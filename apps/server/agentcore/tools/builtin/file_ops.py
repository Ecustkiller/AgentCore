"""File operations tools (read, write, list, precise str_replace edit, delete,
move, copy, mkdir, batch).

Thin shells over ``ToolContext.backend``: each tool parses arguments, calls the
workspace backend, maps typed ``WorkspaceError`` failures back to user-facing
messages, and renders a ``ToolResult``. All actual I/O and the path-traversal
guard live in the backend, so the same tools run unchanged against a server or a
local (desktop) workspace.
"""

import time
from posixpath import basename, splitext
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.workspace._paths import is_ai_noise_file_name
from agentcore.workspace.protocol import (
    AlreadyExists,
    AmbiguousMatch,
    NoMatch,
    NotADirectory,
    NotAFile,
    NotUTF8,
    OutsideWorkspace,
    PathNotFound,
    TreeEntry,
    WorkspaceError,
)

logger = get_logger(__name__)

_DEFAULT_READ_LINES = 500


def _truncate_content_lines(content: str, max_lines: int) -> str:
    """Keep the first ``max_lines`` logical lines, preserving original line endings."""
    if max_lines <= 0:
        return ""
    count = 0
    i = 0
    n = len(content)
    while i < n and count < max_lines:
        count += 1
        j = content.find("\n", i)
        if j == -1:
            return content
        i = j + 1
    return content[:i]


def _format_numbered_lines(lines: list[str], start_line: int) -> str:
    return "\n".join(
        f"{lineno:>6}|{text}"
        for lineno, text in zip(
            range(start_line, start_line + len(lines)), lines, strict=True
        )
    )


# 写类工具「回显结果」：worker 写 / 追加 / 替换后，常会为「确认写对没」再花一整轮 read 回读自检
# （trace 4d715ea0 实测：8 个 append worker 全是 读→追加→回读→handoff，那一轮回读零信息增量）。
# 行业实践是让写类工具直接把「改动后的结果」回显进回执（Aider / Cursor / Claude Code 均回 diff /
# 结果片段），使验证在同一轮内完成、免掉那一轮回读。
# 回显有界（行数 + 字符双上限），大文件不炸 token。
_APPEND_ECHO_LINES = 12
_APPEND_ECHO_CHARS = 600
_EDIT_ECHO_CONTEXT = 3
_EDIT_ECHO_MAX_LINES = 24


def _tail_preview(content: str, *, max_lines: int, max_chars: int) -> str:
    """Last ``max_lines`` lines of ``content``, capped at ``max_chars`` (kept from the tail)."""
    lines = content.splitlines()
    tail = "\n".join(lines[-max_lines:])
    elided = len(lines) > max_lines
    if len(tail) > max_chars:
        tail = tail[-max_chars:]
        elided = True
    return ("…\n" if elided else "") + tail


class _TreeNode:
    __slots__ = ("children", "is_dir", "name")

    def __init__(self, name: str, is_dir: bool) -> None:
        self.name = name
        self.is_dir = is_dir
        self.children: list[_TreeNode] = []


def _render_file_tree(
    entries: list[TreeEntry],
    directory: str,
    max_depth: int,
    truncated: bool,
    elided_count: int,
) -> str:
    """Render ``list_tree`` entries as an ASCII tree (``├──`` / ``└──`` / ``│``)."""
    root_label = "./" if directory == "." else f"{directory.rstrip('/')}/"
    lines: list[str] = [root_label]

    if not entries:
        return f"{root_label}\n（空目录）\n\n（{max_depth} 层深度，共 0 条目）"

    dir_base = "" if directory == "." else directory.rstrip("/")
    root_name = "." if directory == "." else directory.rstrip("/").split("/")[-1]
    root = _TreeNode(root_name, True)

    for entry in sorted(entries, key=lambda e: e.path.lower()):
        parts = entry.path.split("/")
        if dir_base:
            base_parts = dir_base.split("/")
            if parts[: len(base_parts)] != base_parts:
                continue
            parts = parts[len(base_parts) :]
        if not parts:
            continue

        current = root
        for i, part in enumerate(parts):
            is_last = i == len(parts) - 1
            child = next((c for c in current.children if c.name == part), None)
            if child is None:
                child = _TreeNode(part, entry.is_dir if is_last else True)
                current.children.append(child)
            elif is_last:
                child.is_dir = entry.is_dir
            current = child

    def emit(children: list[_TreeNode], prefix: str) -> None:
        ordered = sorted(children, key=lambda n: (not n.is_dir, n.name.lower()))
        for i, child in enumerate(ordered):
            is_last = i == len(ordered) - 1
            branch = "└── " if is_last else "├── "
            extension = "    " if is_last else "│   "
            name = f"{child.name}/" if child.is_dir else child.name
            lines.append(prefix + branch + name)
            if child.children:
                emit(child.children, prefix + extension)

    emit(root.children, "")

    footer = f"\n\n（{max_depth} 层深度，共 {len(entries)} 条目"
    if truncated and elided_count:
        footer += f"；另有 {elided_count} 个条目因深度/预算未展开"
    footer += "）"
    return "\n".join(lines) + footer


def _error(error: str, start: float) -> ToolResult:
    """Build a failed ToolResult with elapsed timing."""
    return ToolResult(
        tool_call_id="",
        success=False,
        output="",
        error=error,
        duration_ms=int((time.monotonic() - start) * 1000),
    )


def _distinct_name_hint(path: str) -> str:
    """A concrete renamed-path suggestion for a write-conflict error: insert a ``-1``
    before the extension (``out/report.md`` → ``out/report-1.md``) so the worker has a
    ready, collision-free alternative to retype."""
    stem, ext = splitext(path)
    return f"{stem}-1{ext}" if stem else f"{path}-1"


class FileReadTool:
    """Read the contents of a file within the workspace."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_read",
            description="读取工作区内某个文件的内容。路径必须是相对于工作区的相对路径。",
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "工作区内的相对文件路径",
                    },
                    "offset": {
                        "type": "integer",
                        "description": "起始行号（1-based，含）。省略则从第 1 行开始。",
                        "minimum": 1,
                    },
                    "limit": {
                        "type": "integer",
                        "description": "最多读取行数。省略则读到文件末尾（上限 500 行）。",
                        "minimum": 1,
                        "maximum": 500,
                    },
                },
                "required": ["path"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = arguments.get("path", "")
        offset = arguments.get("offset")
        limit = arguments.get("limit")
        use_range = offset is not None or limit is not None

        try:
            if use_range:
                eff_offset = int(offset) if offset is not None else 1
                eff_limit = int(limit) if limit is not None else _DEFAULT_READ_LINES
                result = await context.backend.read_lines(
                    rel_path, offset=eff_offset, limit=eff_limit
                )
            else:
                content = await context.backend.read(rel_path)
                content = _truncate_content_lines(content, _DEFAULT_READ_LINES)
                return ToolResult(
                    tool_call_id="",
                    success=True,
                    output=content,
                    duration_ms=int((time.monotonic() - start) * 1000),
                )
        except OutsideWorkspace:
            return _error(f"路径 '{rel_path}' 超出了工作区范围", start)
        except PathNotFound:
            return _error(f"文件不存在：{rel_path}", start)
        except NotAFile:
            return _error(f"不是文件：{rel_path}", start)
        except WorkspaceError as e:
            return _error(f"读取文件失败：{e}", start)

        body = _format_numbered_lines(result.lines, result.start_line)
        footer = (
            f"\n\n（第 {result.start_line}–{result.end_line} 行，共 {result.total_lines} 行）"
        )
        output = body + footer if body else footer.lstrip()

        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
        )


class FileWriteTool:
    """Write content to a file within the workspace."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_write",
            description=(
                "把内容写入文件：会创建该文件（含所有上级目录），或【整体覆盖】"
                "已有文件。用它来新建文件；若只想改已有文件的一部分，优先用 "
                "str_replace（它只编辑匹配到的片段，而不是重写整个文件）。若要在"
                "已有文件【末尾追加】内容（长文分段写作），用 file_append，不要"
                "每次重写全文。路径必须是相对于工作区的相对路径。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "工作区内的相对文件路径",
                    },
                    "content": {
                        "type": "string",
                        "description": "要写入文件的内容",
                    },
                },
                "required": ["path", "content"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = arguments.get("path", "")
        content = arguments.get("content", "")

        # A missing/empty path resolves to the workspace root (a directory); writing
        # onto it raises a cryptic OS error (Permission denied / IsADirectory) that
        # leaks the absolute server path and gives the model nothing to act on. Fail
        # fast with the required-arg message instead (parity with str_replace/move).
        if not rel_path:
            return _error("path 不能为空：请提供工作区内的相对文件路径（如 report.md）", start)

        # 并行写隔离·硬约束: in a delegate batch, refuse to overwrite a file another
        # concurrent sibling already wrote (it would silently clobber their deliverable).
        # Claimed BEFORE the awaited write so two concurrent claims can't interleave; a
        # downstream consolidating an upstream's file (its ancestor) is still allowed.
        coordinator = context.write_coordinator
        if coordinator is not None:
            owner = coordinator.claim(rel_path, context.run_id, context.write_ancestors)
            if owner is not None:
                logger.info(
                    "file_write.collision",
                    path=rel_path,
                    run_id=context.run_id,
                    owner=owner,
                )
                from agentcore.runtime.audit.hooks import on_write_conflict

                on_write_conflict(
                    path=rel_path,
                    run_id=context.run_id,
                    owner_run_id=owner,
                )
                return _error(
                    f"写入冲突：`{rel_path}` 正被同一批的另一个并行队友写入——同名文件并发写"
                    f"会互相覆盖，已拦下。请换一个不同的文件名（给它加上你的角色或编号后缀，"
                    f"如 `{_distinct_name_hint(rel_path)}`）后重写。",
                    start,
                )

        try:
            written = await context.backend.write(rel_path, content)
        except OutsideWorkspace:
            if coordinator is not None:
                coordinator.release(rel_path, context.run_id)
            return _error(f"路径 '{rel_path}' 超出了工作区范围", start)
        except WorkspaceError as e:
            if coordinator is not None:
                coordinator.release(rel_path, context.run_id)
            return _error(f"写入文件失败：{e}", start)

        return ToolResult(
            tool_call_id="",
            success=True,
            # file_write 是整体写入，内容就是你本次提交的全文 → 无需回显（模型已持有），只在回执里
            # 点明「已落盘、无需回读」即可（见本模块顶部说明）。
            output=(
                f"已写入 {written} 字节到 {rel_path}"
                "（内容即你本次提交的全文，已落盘，无需再读回确认）"
            ),
            duration_ms=int((time.monotonic() - start) * 1000),
        )


class FileAppendTool:
    """Append content to the end of a file within the workspace."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_append",
            description=(
                "在文件【末尾追加】内容：文件不存在则创建（含上级目录）；已存在则在"
                "末尾拼接，不重写全文。适合长文分段写作（先出大纲，再逐节追加）。"
                "若要【整体覆盖】或新建首段，用 file_write；若要改中间某段，用 "
                "str_replace。路径必须是相对于工作区的相对路径。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "工作区内的相对文件路径",
                    },
                    "content": {
                        "type": "string",
                        "description": "要追加到文件末尾的内容",
                    },
                },
                "required": ["path", "content"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = arguments.get("path", "")
        content = arguments.get("content", "")

        if not rel_path:
            return _error("path 不能为空：请提供工作区内的相对文件路径（如 report.md）", start)

        coordinator = context.write_coordinator
        if coordinator is not None:
            owner = coordinator.claim(rel_path, context.run_id, context.write_ancestors)
            if owner is not None:
                logger.info(
                    "file_append.collision",
                    path=rel_path,
                    run_id=context.run_id,
                    owner=owner,
                )
                from agentcore.runtime.audit.hooks import on_write_conflict

                on_write_conflict(
                    path=rel_path,
                    run_id=context.run_id,
                    owner_run_id=owner,
                )
                return _error(
                    f"写入冲突：`{rel_path}` 正被同一批的另一个并行队友写入——同名文件并发写"
                    f"会互相覆盖，已拦下。请换一个不同的文件名（给它加上你的角色或编号后缀，"
                    f"如 `{_distinct_name_hint(rel_path)}`）后重写。",
                    start,
                )

        try:
            appended = await context.backend.append(rel_path, content)
        except OutsideWorkspace:
            if coordinator is not None:
                coordinator.release(rel_path, context.run_id)
            return _error(f"路径 '{rel_path}' 超出了工作区范围", start)
        except NotAFile:
            if coordinator is not None:
                coordinator.release(rel_path, context.run_id)
            return _error(f"不是文件：{rel_path}", start)
        except WorkspaceError as e:
            if coordinator is not None:
                coordinator.release(rel_path, context.run_id)
            return _error(f"追加文件失败：{e}", start)

        return ToolResult(
            tool_call_id="",
            success=True,
            # 回显合并后的文件末尾：append 只写增量、模型上下文里没有合并后的全文，故把「文件当前
            # 末尾」当场给它，免得它为「看看追加落对没」再花一轮 read 回读（见本模块顶部说明）。
            output=(
                f"已追加 {appended} 字节到 {rel_path}（已落盘，无需再读回确认）。文件当前末尾：\n"
                + _tail_preview(
                    await context.backend.read(rel_path),
                    max_lines=_APPEND_ECHO_LINES,
                    max_chars=_APPEND_ECHO_CHARS,
                )
            ),
            duration_ms=int((time.monotonic() - start) * 1000),
        )


class FileListTool:
    """List files in a directory within the workspace."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_list",
            description="列出某个目录下的文件与子目录。路径必须是相对于工作区的相对路径。",
            parameters={
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": "相对目录路径（默认：工作区根目录）",
                        "default": ".",
                    },
                    "pattern": {
                        "type": "string",
                        "description": "用于过滤结果的 glob 模式（如 '*.py'）",
                        "default": "*",
                    },
                    "recursive": {
                        "type": "boolean",
                        "description": "递归列出子目录（树形）。默认 false（仅当前层）。",
                        "default": False,
                    },
                    "max_depth": {
                        "type": "integer",
                        "description": "递归最大深度（仅 recursive=true 时生效）。默认 3，上限 8。",
                        "default": 3,
                        "minimum": 1,
                        "maximum": 8,
                    },
                },
                "required": [],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        directory = arguments.get("directory", ".")
        pattern = arguments.get("pattern", "*")
        recursive = bool(arguments.get("recursive", False))
        max_depth = int(arguments.get("max_depth", 3))
        max_depth = max(1, min(max_depth, 8))

        try:
            if recursive:
                tree = await context.backend.list_tree(
                    directory, pattern=pattern, max_depth=max_depth
                )
            else:
                # ``list`` is shared with user UI (system-noise only); strip AI
                # noise here so media/archives don't pollute the agent view.
                entries = [
                    e
                    for e in await context.backend.list(directory, pattern)
                    if e.is_dir or not is_ai_noise_file_name(basename(e.path))
                ]
        except OutsideWorkspace:
            return _error(f"路径 '{directory}' 超出了工作区范围", start)
        except NotADirectory:
            return _error(f"不是目录：{directory}", start)
        except WorkspaceError as e:
            return _error(f"列目录失败：{e}", start)

        if recursive:
            output = _render_file_tree(
                tree.entries,
                directory,
                max_depth,
                tree.truncated,
                tree.elided_count,
            )
        else:
            lines = [f"{'d ' if entry.is_dir else 'f '}{entry.path}" for entry in entries]
            output = "\n".join(lines) if lines else "（空目录）"

        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
        )


class StrReplaceTool:
    """Replace an exact text span in an existing workspace file (precise edit)."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="str_replace",
            description=(
                "通过替换【完全精确匹配的文本片段】来编辑已有文件。改文件时优先"
                "用它而非 file_write：它只重写匹配到的片段，因此对大文件安全、也"
                "不会误伤无关内容。在 old_string 里放足够的上下文，确保在文件中"
                "【唯一匹配一次】（包括空白、缩进与换行）。若 old_string 不存在、"
                "或匹配多于一次（除非 replace_all=true），则失败。要新建文件请改"
                "用 file_write。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "工作区内的相对文件路径",
                    },
                    "old_string": {
                        "type": "string",
                        "description": ("要替换的精确文本，需带足够的上下文以在文件中唯一。"),
                    },
                    "new_string": {
                        "type": "string",
                        "description": "替换后的文本（必须与 old_string 不同）。",
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": ("替换所有出现处，而非要求唯一匹配（默认 false）。"),
                        "default": False,
                    },
                },
                "required": ["path", "old_string", "new_string"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = arguments.get("path", "")
        old_string = arguments.get("old_string", "")
        new_string = arguments.get("new_string", "")
        replace_all = bool(arguments.get("replace_all", False))

        if not old_string:
            return _error("old_string 不能为空", start)
        if old_string == new_string:
            return _error("old_string 与 new_string 相同，没有需要改动的内容", start)

        try:
            outcome = await context.backend.replace(
                rel_path, old_string, new_string, all_=replace_all
            )
        except OutsideWorkspace:
            return _error(f"路径 '{rel_path}' 超出了工作区范围", start)
        except PathNotFound:
            return _error(f"文件不存在：{rel_path}", start)
        except NotAFile:
            return _error(f"不是文件：{rel_path}", start)
        except NotUTF8:
            return _error(f"无法编辑二进制 / 非 UTF-8 文件：{rel_path}", start)
        except NoMatch:
            return _error(
                f"在 {rel_path} 中找不到 old_string；它必须与文件完全一致，包括空白与缩进。",
                start,
            )
        except AmbiguousMatch as e:
            return _error(
                f"old_string 在 {rel_path} 中不唯一（匹配 {e.count} 处）。请补充"
                "更多上下文以锁定单一片段，或设置 replace_all=true。",
                start,
            )
        except WorkspaceError as e:
            return _error(f"写入文件失败：{e}", start)

        loc = "" if outcome.first_line is None else f"（约第 {outcome.first_line} 行）"
        # 回显改动落点的上下文（所改即所见），免得 worker 为「确认替换落对没」再花一轮 read 回读
        # （见本模块顶部说明）。有界：落点前后各 _EDIT_ECHO_CONTEXT 行 + 新增行数，封顶 MAX_LINES。
        echo = ""
        if outcome.first_line is not None:
            region = await context.backend.read_lines(
                rel_path,
                offset=max(1, outcome.first_line - _EDIT_ECHO_CONTEXT),
                limit=min(
                    _EDIT_ECHO_CONTEXT * 2 + 1 + new_string.count("\n"),
                    _EDIT_ECHO_MAX_LINES,
                ),
            )
            echo = "。改动落点（已落盘，无需再读回确认）：\n" + _format_numbered_lines(
                region.lines, region.start_line
            )
        return ToolResult(
            tool_call_id="",
            success=True,
            output=f"已在 {rel_path} 替换 {outcome.count} 处{loc}{echo}",
            duration_ms=int((time.monotonic() - start) * 1000),
            metadata={"replacements": outcome.count},
        )


class FileDeleteTool:
    """Delete a file, or a directory and all its contents, within the workspace."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_delete",
            description=(
                "删除一个文件，或一个目录【及其全部内容】（递归）。默认【可逆】："
                "本地模式移入系统回收站；云端 / 无回收站环境移入工作区软删除区"
                "（.agentcore/trash，保留还原所需信息）。仅当 permanent=true 时"
                "才永久删除。工作区根目录本身不可删除。路径必须是相对于工作区的"
                "相对路径。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "要删除的文件或目录的相对路径",
                    },
                    "permanent": {
                        "type": "boolean",
                        "description": (
                            "true = 永久删除（不可恢复）；默认 false = 可逆删除"
                            "（回收站 / 工作区软删区）。"
                        ),
                        "default": False,
                    },
                },
                "required": ["path"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = arguments.get("path", "")
        permanent = bool(arguments.get("permanent", False))

        try:
            await context.backend.delete(rel_path, permanent=permanent)
        except OutsideWorkspace:
            return _error(f"路径 '{rel_path}' 超出了工作区范围", start)
        except PathNotFound:
            return _error(f"路径不存在：{rel_path}", start)
        except WorkspaceError as e:
            return _error(f"删除失败：{e}", start)

        if permanent:
            msg = f"已永久删除 {rel_path}"
        else:
            msg = (
                f"已可逆删除 {rel_path}"
                "（本地通道→系统回收站；云端/sidecar→工作区 .agentcore/trash）"
            )

        return ToolResult(
            tool_call_id="",
            success=True,
            output=msg,
            duration_ms=int((time.monotonic() - start) * 1000),
        )


class FileMoveTool:
    """Move or rename a file or directory within the workspace."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_move",
            description=(
                "在工作区内移动或重命名文件 / 目录。可用于重命名（在同一目录内"
                "移动）或把路径迁到新位置；目标路径缺失的上级目录会自动创建。若"
                "目标已存在则失败——【不会覆盖】。两个路径都必须是相对于工作区的"
                "相对路径。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": "要移动的已有文件 / 目录的相对路径",
                    },
                    "destination": {
                        "type": "string",
                        "description": "目标相对路径（必须尚不存在）",
                    },
                },
                "required": ["source", "destination"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        source = arguments.get("source", "")
        destination = arguments.get("destination", "")

        if not source or not destination:
            return _error("'source' 与 'destination' 均为必填", start)
        if source == destination:
            return _error("source 与 destination 相同，无需移动", start)

        try:
            await context.backend.move(source, destination)
        except OutsideWorkspace as e:
            return _error(f"路径 '{e}' 超出了工作区范围", start)
        except PathNotFound:
            return _error(f"源路径不存在：{source}", start)
        except AlreadyExists:
            return _error(
                f"目标已存在：{destination}。请换一个不存在的路径，或先删除它。",
                start,
            )
        except WorkspaceError as e:
            return _error(f"移动失败：{e}", start)

        return ToolResult(
            tool_call_id="",
            success=True,
            output=f"已把 {source} 移动到 {destination}",
            duration_ms=int((time.monotonic() - start) * 1000),
        )


class FileCopyTool:
    """Copy a file or directory tree within the workspace (binary-safe)."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_copy",
            description=(
                "在工作区内复制文件或【目录树】（含二进制）。目标路径缺失的上级"
                "目录会自动创建；若目标已存在则失败——【不会覆盖】。不能复制到"
                "自身或其子目录。两个路径都必须是相对于工作区的相对路径。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": "要复制的已有文件 / 目录的相对路径",
                    },
                    "destination": {
                        "type": "string",
                        "description": "目标相对路径（必须尚不存在）",
                    },
                },
                "required": ["source", "destination"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        source = arguments.get("source", "")
        destination = arguments.get("destination", "")

        if not source or not destination:
            return _error("'source' 与 'destination' 均为必填", start)
        if source == destination:
            return _error("source 与 destination 相同，无需复制", start)

        try:
            await context.backend.copy(source, destination)
        except OutsideWorkspace as e:
            return _error(f"路径 '{e}' 超出了工作区范围", start)
        except PathNotFound:
            return _error(f"源路径不存在：{source}", start)
        except AlreadyExists:
            return _error(
                f"目标已存在：{destination}。请换一个不存在的路径，或先删除它。",
                start,
            )
        except WorkspaceError as e:
            return _error(f"复制失败：{e}", start)

        return ToolResult(
            tool_call_id="",
            success=True,
            output=f"已把 {source} 复制到 {destination}",
            duration_ms=int((time.monotonic() - start) * 1000),
        )


class MkdirTool:
    """Create an empty directory (with parents) within the workspace."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="mkdir",
            description=(
                "在工作区内创建空目录（上级目录不存在时一并创建）。若路径已存在"
                "则失败。路径必须是相对于工作区的相对路径。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "要创建的相对目录路径",
                    },
                },
                "required": ["path"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = arguments.get("path", "")

        if not rel_path:
            return _error("path 不能为空：请提供工作区内的相对目录路径", start)

        try:
            await context.backend.mkdir(rel_path)
        except OutsideWorkspace:
            return _error(f"路径 '{rel_path}' 超出了工作区范围", start)
        except AlreadyExists:
            return _error(f"路径已存在：{rel_path}", start)
        except WorkspaceError as e:
            return _error(f"创建目录失败：{e}", start)

        return ToolResult(
            tool_call_id="",
            success=True,
            output=f"已创建目录 {rel_path}",
            duration_ms=int((time.monotonic() - start) * 1000),
        )


_BATCH_OPS = frozenset({"move", "copy", "delete", "mkdir"})
_BATCH_MAX_OPS = 50


def _batch_op_label(item: dict[str, Any]) -> str:
    op = str(item.get("op", "")).strip()
    if op == "move":
        return f"move {item.get('source', '')} → {item.get('destination', '')}"
    if op == "copy":
        return f"copy {item.get('source', '')} → {item.get('destination', '')}"
    if op == "delete":
        perm = " (永久)" if item.get("permanent") else ""
        return f"delete {item.get('path', '')}{perm}"
    if op == "mkdir":
        return f"mkdir {item.get('path', '')}"
    return f"? {op}"


class FileBatchTool:
    """Apply multiple move/copy/delete/mkdir ops in one call (partial failure OK)."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_batch",
            description=(
                "一次提交多条工作区文件操作（move / copy / delete / mkdir）。"
                f"最多 {_BATCH_MAX_OPS} 项。逐项执行：单项失败不中断整批，回执如实"
                "列出成功 / 跳过 / 失败。目标同名冲突 = 跳过并入报告。"
                "整理方案确认后传入 organize_plan_id：仅允许方案内条目，且跳过二次审批。"
                "删除默认可逆；区外 permanent=true 一律拒绝。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "operations": {
                        "type": "array",
                        "description": "按顺序执行的操作列表",
                        "minItems": 1,
                        "maxItems": _BATCH_MAX_OPS,
                        "items": {
                            "type": "object",
                            "properties": {
                                "op": {
                                    "type": "string",
                                    "enum": ["move", "copy", "delete", "mkdir"],
                                    "description": "操作类型",
                                },
                                "path": {
                                    "type": "string",
                                    "description": "delete / mkdir 的相对路径",
                                },
                                "source": {
                                    "type": "string",
                                    "description": "move / copy 的源相对路径",
                                },
                                "destination": {
                                    "type": "string",
                                    "description": "move / copy 的目标相对路径",
                                },
                                "permanent": {
                                    "type": "boolean",
                                    "description": "仅 delete：true = 永久删除（区外禁止）",
                                    "default": False,
                                },
                            },
                            "required": ["op"],
                        },
                    },
                    "organize_plan_id": {
                        "type": "string",
                        "description": (
                            "整理方案卡确认后返回的 plan_id。携带时：范围校验仅允许方案内"
                            "条目，并跳过 GRANTABLE 二次审批；执行成功项写入可撤销日志。"
                        ),
                    },
                    "organize_undo": {
                        "type": "boolean",
                        "description": (
                            "true = 撤销本会话最近一次整理（逆回放 move/mkdir；删除项只提示"
                            "去回收站）。单次有效。勿与 operations / organize_plan_id 同用。"
                        ),
                        "default": False,
                    },
                },
                "required": [],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        if bool(arguments.get("organize_undo")):
            return await self._undo(context, start)

        raw = arguments.get("operations")
        if not isinstance(raw, list) or not raw:
            return _error("operations 必须是非空数组（撤销请用 organize_undo=true）", start)
        if len(raw) > _BATCH_MAX_OPS:
            return _error(f"operations 最多 {_BATCH_MAX_OPS} 项", start)

        plan_id = str(arguments.get("organize_plan_id") or "").strip()
        if plan_id:
            from agentcore.workspace.organize_plan_store import get_plan, ops_within_plan

            plan = get_plan(plan_id)
            if plan is None or plan.conversation_id != context.conversation_id:
                return _error(f"整理方案不存在或已失效：{plan_id}", start)
            scope_err = ops_within_plan(plan, [i for i in raw if isinstance(i, dict)])
            if scope_err:
                return _error(scope_err, start)

        lines: list[str] = [f"本次共 {len(raw)} 项："]
        ok_n = skip_n = fail_n = 0
        successes: list[dict[str, Any]] = []

        for i, item in enumerate(raw, start=1):
            if not isinstance(item, dict):
                fail_n += 1
                lines.append(f"{i}. 失败 · 条目必须是对象")
                continue
            op = str(item.get("op", "")).strip()
            label = _batch_op_label(item)
            if op not in _BATCH_OPS:
                fail_n += 1
                lines.append(f"{i}. 失败 · {label}：未知 op")
                continue
            try:
                status, detail = await self._run_one(op, item, context)
            except Exception as e:  # noqa: BLE001 — batch must continue
                fail_n += 1
                lines.append(f"{i}. 失败 · {label}：{e}")
                continue
            if status == "ok":
                ok_n += 1
                lines.append(f"{i}. 成功 · {detail}")
                successes.append(item)
            elif status == "skip":
                skip_n += 1
                lines.append(f"{i}. 跳过 · {detail}")
            else:
                fail_n += 1
                lines.append(f"{i}. 失败 · {detail}")

        if plan_id and successes:
            from agentcore.workspace import organize_journal

            organize_journal.record_batch(
                conversation_id=context.conversation_id,
                plan_id=plan_id,
                successes=successes,
            )
            lines.append(
                f"已记录整理日志（plan={plan_id}）。可用 file_batch(organize_undo=true) 撤销"
                "本次 move/mkdir；删除项请到系统回收站手动恢复。"
            )

        summary = f"完成：成功 {ok_n}，跳过 {skip_n}，失败 {fail_n}"
        lines.append(summary)
        return ToolResult(
            tool_call_id="",
            success=fail_n == 0,
            output="\n".join(lines),
            error="" if fail_n == 0 else summary,
            duration_ms=int((time.monotonic() - start) * 1000),
            metadata={
                "ok": ok_n,
                "skip": skip_n,
                "fail": fail_n,
                "total": len(raw),
                "organize_plan_id": plan_id or None,
            },
        )

    async def _undo(self, context: ToolContext, start: float) -> ToolResult:
        from agentcore.workspace import organize_journal
        from agentcore.workspace.organize_plan_store import deactivate_plan

        journal = organize_journal.get_journal(context.conversation_id)
        if journal is None:
            return _error("没有可撤销的整理记录", start)
        if journal.undone:
            return _error("本次整理已撤销过（仅单次有效）", start)
        undo_ops, deletes = organize_journal.build_undo_operations(journal)
        lines: list[str] = ["撤销本次整理："]
        ok_n = skip_n = fail_n = 0
        for i, item in enumerate(undo_ops, start=1):
            op = str(item.get("op", "")).strip()
            try:
                status, detail = await self._run_one(op, item, context)
            except Exception as e:  # noqa: BLE001
                fail_n += 1
                lines.append(f"{i}. 失败 · {e}")
                continue
            if status == "ok":
                ok_n += 1
                lines.append(f"{i}. 成功 · {detail}")
            elif status == "skip":
                skip_n += 1
                lines.append(f"{i}. 跳过 · {detail}")
            else:
                fail_n += 1
                lines.append(f"{i}. 失败 · {detail}")
        if deletes:
            lines.append(
                "以下删除项未自动还原，请到系统回收站手动恢复：\n"
                + "\n".join(f"- {p}" for p in deletes)
            )
        organize_journal.mark_undone(context.conversation_id)
        deactivate_plan(journal.plan_id)
        summary = f"撤销完成：成功 {ok_n}，跳过 {skip_n}，失败 {fail_n}"
        lines.append(summary)
        return ToolResult(
            tool_call_id="",
            success=fail_n == 0,
            output="\n".join(lines),
            error="" if fail_n == 0 else summary,
            duration_ms=int((time.monotonic() - start) * 1000),
            metadata={"ok": ok_n, "skip": skip_n, "fail": fail_n, "undo": True},
        )

    async def _run_one(
        self, op: str, item: dict[str, Any], context: ToolContext
    ) -> tuple[str, str]:
        if op == "mkdir":
            path = str(item.get("path", "")).strip()
            if not path:
                return "fail", "mkdir · path 不能为空"
            try:
                await context.backend.mkdir(path)
            except AlreadyExists:
                return "skip", f"mkdir {path}（已存在）"
            except OutsideWorkspace as e:
                return "fail", f"mkdir {path}：{e}"
            except WorkspaceError as e:
                return "fail", f"mkdir {path}：{e}"
            return "ok", f"mkdir {path}"

        if op == "delete":
            path = str(item.get("path", "")).strip()
            if not path:
                return "fail", "delete · path 不能为空"
            permanent = bool(item.get("permanent", False))
            try:
                await context.backend.delete(path, permanent=permanent)
            except PathNotFound:
                return "skip", f"delete {path}（不存在）"
            except OutsideWorkspace as e:
                return "fail", f"delete {path}：{e}"
            except WorkspaceError as e:
                return "fail", f"delete {path}：{e}"
            mode = "永久删除" if permanent else "可逆删除"
            return "ok", f"delete {path}（{mode}）"

        source = str(item.get("source", "")).strip()
        destination = str(item.get("destination", "")).strip()
        if not source or not destination:
            return "fail", f"{op} · source 与 destination 均为必填"
        if source == destination:
            return "skip", f"{op} {source}（源与目标相同）"
        try:
            if op == "move":
                await context.backend.move(source, destination)
            else:
                await context.backend.copy(source, destination)
        except PathNotFound:
            return "fail", f"{op} {source} → {destination}：源不存在"
        except AlreadyExists:
            # MVP conflict policy: skip into report (提案钉死).
            return "skip", f"{op} {source} → {destination}：目标已存在"
        except OutsideWorkspace as e:
            return "fail", f"{op} {source} → {destination}：{e}"
        except WorkspaceError as e:
            return "fail", f"{op} {source} → {destination}：{e}"
        return "ok", f"{op} {source} → {destination}"
