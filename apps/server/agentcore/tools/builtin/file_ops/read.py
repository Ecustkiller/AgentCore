"""file_read / file_list (+ tree rendering) tools."""

from __future__ import annotations

import re
import time
from typing import Any

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    FileProductsContract,
    ToolRegistration,
    ToolSurface,
)
from agentcore.workspace._paths import AI_ARCHIVE_FILE_SUFFIXES
from agentcore.workspace.attachment_parse import (
    MARKITDOWN_EXTENSIONS,
    SKIP_EXTENSIONS,
    ParseStatus,
    extension_of,
    extract_office_bytes,
    parsed_copy_path,
)
from agentcore.workspace.declared_dirs import (
    LATENT_EMPTY_LIST_MESSAGE,
    is_declared_latent_dir,
)
from agentcore.workspace.external_mounts import EXTERNAL_PREFIX, parse_external_path
from agentcore.workspace.limits import OFFICE_EXTRACT_MAX_BYTES
from agentcore.workspace.protocol import (
    DirEntry,
    NotADirectory,
    NotAFile,
    OutsideWorkspace,
    PathNotFound,
    TreeEntry,
    WorkspaceError,
)
from agentcore.workspace.sparse_listing import should_hide_ai_noise_from_list

from .errors import (
    _error,
    _file_read_path_ceiling_error,
    _map_workspace_read_error,
    _maybe_channel_dead_error,
    _office_extract_budget_error,
    _outside_workspace_msg,
    _path_missing_error,
)
from .path_hints import enrich_missing_path_message

_DEFAULT_READ_LINES = 500


def _empty_list_message(directory: str) -> str:
    """Empty ``file_list`` body — latent declared dirs get auto-create copy."""
    if is_declared_latent_dir(directory):
        return LATENT_EMPTY_LIST_MESSAGE
    return "（空目录）"


def _format_numbered_lines(lines: list[str], start_line: int) -> str:
    return "\n".join(
        f"{lineno:>6}|{text}"
        for lineno, text in zip(
            range(start_line, start_line + len(lines)), lines, strict=True
        )
    )


def _format_line_window(
    lines: list[str],
    *,
    start_line: int,
    end_line: int,
    total_lines: int,
) -> str:
    """Honest ranged view: numbered lines + footer ``（第 a–b 行，共 N 行）``.

    Never silently drops a tail without a footer, and never inserts transport
    elision (``DEFAULT_ELISION_MARKER``) into filesystem body text.
    """
    body = _format_numbered_lines(lines, start_line) if lines else ""
    footer = f"（第 {start_line}–{end_line} 行，共 {total_lines} 行）"
    return body + "\n\n" + footer if body else footer


def _file_read_ok(output: str, start: float) -> ToolResult:
    """Successful file_read result; ``output_limit`` covers full view (no 4k head+tail)."""
    return ToolResult(
        tool_call_id="",
        success=True,
        output=output,
        duration_ms=int((time.monotonic() - start) * 1000),
        output_limit=max(len(output), ToolResult._MAX_OUTPUT_LEN),
    )

class _TreeNode:
    __slots__ = ("children", "is_dir", "name")

    def __init__(self, name: str, is_dir: bool) -> None:
        self.name = name
        self.is_dir = is_dir
        self.children: list[_TreeNode] = []


_BRACE_GLOB_RE = re.compile(r"\{([^{}]+)\}")


def expand_brace_globs(pattern: str) -> list[str]:
    """Expand one level of ``{a,b}`` alternatives (pathlib globs do not).

    ``*.{ts,tsx}`` → ``['*.ts', '*.tsx']``. Nested / empty braces are left as-is
    (single-element list). Order is stable; duplicates are dropped.
    """
    raw = (pattern or "*").strip() or "*"
    match = _BRACE_GLOB_RE.search(raw)
    if match is None:
        return [raw]
    alternatives = [part.strip() for part in match.group(1).split(",") if part.strip()]
    if not alternatives:
        return [raw]
    prefix = raw[: match.start()]
    suffix = raw[match.end() :]
    expanded: list[str] = []
    seen: set[str] = set()
    for alt in alternatives:
        item = f"{prefix}{alt}{suffix}"
        if item not in seen:
            seen.add(item)
            expanded.append(item)
    return expanded or [raw]


def _pattern_filters(pattern: str) -> bool:
    """True when ``pattern`` is narrower than「列全部」."""
    p = (pattern or "*").strip() or "*"
    return p != "*"


def _pattern_targets_archives(pattern: str) -> bool:
    """True when glob(s) end with an AI-archive suffix (``*.zip``, ``*.{rar,7z}``…)."""
    for pat in expand_brace_globs(pattern):
        lower = (pat or "").lower().rstrip("/")
        if any(lower.endswith(suf) for suf in AI_ARCHIVE_FILE_SUFFIXES):
            return True
    return False


def _is_bare_external_directory(directory: str) -> bool:
    """True for ``external`` / ``external/`` (no alias) — not a listable mount path."""
    raw = (directory or "").strip().replace("\\", "/").strip("/")
    return raw == EXTERNAL_PREFIX.rstrip("/")


def _looks_like_external_directory(directory: str) -> bool:
    """Bare ``external`` or any ``external/<alias>/…`` shape (even unknown alias)."""
    raw = (directory or "").strip().replace("\\", "/").strip("/")
    if raw == EXTERNAL_PREFIX.rstrip("/") or raw.startswith(EXTERNAL_PREFIX):
        return True
    return parse_external_path(directory) is not None


def _external_directory_hint(backend: Any) -> str:
    """Actionable mounts guidance for bare / failed ``external`` list attempts."""
    guide = (
        "须使用 `external/<别名>/`（例如 `external/desktop/`）访问已授权区外目录"
    )
    mounts = getattr(backend, "_mounts", None) or {}
    if not mounts:
        return (
            f"{guide}；本对话尚无会话级区外目录授权"
            "（用户经 ask_user grant_* 确认后才会出现 mounts）。"
        )
    parts = [f"`external/{a}/`" for a in mounts]
    return f"{guide}；当前 mounts：{'；'.join(parts)}。"


def _no_match_hint(
    *,
    pattern: str,
    directory: str,
    bare_entries: list,
    recursive: bool,
) -> str:
    """Actionable message when a glob matched nothing in a non-empty directory."""
    sample_parts: list[str] = []
    for entry in bare_entries[:8]:
        sample_parts.append(f"{'d ' if entry.is_dir else 'f '}{entry.path}")
    sample = "；".join(sample_parts)
    more = (
        f" 等共 {len(bare_entries)} 项"
        if len(bare_entries) > 8
        else f"（共 {len(bare_entries)} 项）"
    )
    tips = ["去掉 pattern", "换更宽的 glob"]
    if not recursive:
        tips.insert(0, "设 recursive=true 以搜索子目录")
    tip_text = "、".join(tips)
    root = "./" if directory in (".", "") else f"{directory.rstrip('/')}/"
    return (
        f"（在 {root} 下无匹配 pattern={pattern!r} 的条目；目录非空{more}。"
        f"可见顶层示例：{sample}。可{tip_text}。）"
    )


async def _file_not_found_error(
    rel_path: str,
    *,
    start: float,
    context: ToolContext,
) -> ToolResult:
    """``PathNotFound`` for file_read — landmark / root-search tip (shared path_hints)."""
    base = f"文件不存在：{rel_path}"
    return _path_missing_error(
        await enrich_missing_path_message(context, rel_path, base=base),
        start,
    )


def _render_file_tree(
    entries: list[TreeEntry],
    directory: str,
    max_depth: int,
    truncated: bool,
    elided_count: int,
    *,
    empty_message: str | None = None,
    warnings: list[str] | None = None,
) -> str:
    """Render ``list_tree`` entries as an ASCII tree (``├──`` / ``└──`` / ``│``)."""
    root_label = "./" if directory == "." else f"{directory.rstrip('/')}/"
    lines: list[str] = [root_label]

    if not entries:
        empty = empty_message or "（空目录）"
        body = f"{root_label}\n{empty}\n\n（{max_depth} 层深度，共 0 条目）"
        if warnings:
            body += "\n" + "\n".join(f"⚠ {w}" for w in warnings)
        return body

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
    out = "\n".join(lines) + footer
    if warnings:
        out += "\n" + "\n".join(f"⚠ {w}" for w in warnings)
    return out

def _note_file_read_success(
    context: ToolContext,
    path_key: str,
    output: str,
    *,
    using_reread: bool,
) -> str:
    """Bump ``file_read_counts`` for a full (non-ranged) read; consume grant; tip.

    Ranged reads (offset/limit) must not call this — they neither count nor tip.
    """
    from agentcore.runtime.runs.constants import FILE_READ_SAME_PATH_MAX

    context.file_read_counts[path_key] = int(context.file_read_counts.get(path_key, 0)) + 1
    if using_reread:
        remaining = int(context.file_read_reread_remaining.get(path_key, 0))
        context.file_read_reread_remaining[path_key] = max(0, remaining - 1)
        if context.file_read_reread_remaining[path_key] <= 0:
            output += (
                f"\n\n[系统提示] `{path_key}` 的再读授额已用尽；"
                "请依据本次正文推进；若正文仍在对话中请勿空转整读，"
                "正文已被清理时可再读，或落盘 / 换其它文件。"
            )
        return output
    if context.file_read_counts[path_key] >= FILE_READ_SAME_PATH_MAX:
        output += (
            f"\n\n[系统提示] 本 run 对 `{path_key}` 的整读 file_read 已达上限 "
            f"（{FILE_READ_SAME_PATH_MAX} 次）；正文仍在对话中时请停止重复整读，"
            "改用已有正文落盘；可用 offset/limit 精读片段。"
        )
    return output


def _format_extracted_read(
    text: str,
    *,
    offset: int | None,
    limit: int | None,
) -> str:
    """Apply file_read offset/limit to extracted (or sidecar) text lines.

    Full and ranged reads share the same honest window: numbered lines + footer.
    """
    lines = text.splitlines()
    total = len(lines)
    eff_offset = int(offset) if offset is not None else 1
    eff_limit = int(limit) if limit is not None else _DEFAULT_READ_LINES
    start_idx = max(0, eff_offset - 1)
    if start_idx >= total:
        return f"（第 {eff_offset}–{eff_offset - 1} 行，共 {total} 行）"
    selected = lines[start_idx : start_idx + eff_limit]
    start_line = start_idx + 1
    end_line = start_idx + len(selected)
    return _format_line_window(
        selected,
        start_line=start_line,
        end_line=end_line,
        total_lines=total,
    )

class FileReadTool:
    """Read the contents of a file within the workspace."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_BOTH,
        file_products=FileProductsContract.READ_ONLY,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_read",
            description=(
                "读取工作区内某个文件的内容（相对路径）。"
                "Office/PDF（docx/pdf/pptx/odt/rtf）自动抽取文本；表格（xlsx/csv 等）请用 "
                "code_execute。"
                "宜在 grep / code_search 命中后再读；优先传 offset/limit 精读片段，"
                "禁止无目标地整目录逐文件通读。"
                "含糊「根」/ `.` / 仅根标签勿当文件整读——先 file_list/grep 钉真实路径。"
                "回执为编号行 + 页脚「第 a–b 行，共 N 行」（区间视图；"
                "超默认行数只展示窗口，非磁盘残缺，勿把页脚当正文去 str_replace）。"
                "同一相对路径本 run 对【整读】有成功次数上限（带 offset/limit 的分段读"
                "不计入、不触顶）；触顶且正文仍在对话中、又无再读授额时仅拒绝该路径，"
                "其它文件仍可 file_read。正文已被清理或写成功后可再整读核对。"
                "已落盘产物优先以写/append 回执中的 artifact manifest 验真。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": (
                            "工作区相对 POSIX 文件路径（`.`=根；`/<根标签>/…` 与裸 `/`、"
                            "`\\` 视为根；其它绝对路径如 /etc、盘符拒绝）"
                        ),
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

        # Same-path ceiling (full reads only): hard-reject empty spin only when
        # verbatim body is still in the projected window AND no reread grant.
        # Ranged (offset/limit) skips the gate and does not bump counts.
        # Cleared body → allow recovery read even with remaining == 0.
        from agentcore.runtime.runs.constants import FILE_READ_SAME_PATH_MAX

        path_key = (rel_path or "").strip().replace("\\", "/")
        using_reread = False
        if path_key and not use_range:
            prior = int(context.file_read_counts.get(path_key, 0))
            if prior >= FILE_READ_SAME_PATH_MAX:
                remaining = int(context.file_read_reread_remaining.get(path_key, 0))
                if remaining > 0:
                    # Grant overrides even when stale verbatim is still present.
                    using_reread = True
                else:
                    verbatim = context.file_read_verbatim_paths
                    # None = projection not synced (unit tests / non-engine) →
                    # treat as body still present.
                    body_present = verbatim is None or path_key in verbatim
                    if body_present:
                        return _file_read_path_ceiling_error(
                            (
                                f"已多次读取 `{path_key}`（本 run 上限 "
                                f"{FILE_READ_SAME_PATH_MAX} 次）。正文已在对话中，勿再读此文件；"
                                "可换其它文件，或基于已有正文落盘 / handoff。"
                            ),
                            start,
                        )
                    # Cleared: allow recovery full-read (no grant required).

        ext = extension_of(path_key or rel_path)
        if ext in SKIP_EXTENSIONS:
            return _error(
                (
                    f"`{path_key or rel_path}` 是表格/分隔数据文件，file_read 不自动抽文本；"
                    "请用 code_execute（如 openpyxl / pandas）按工作区相对路径解析。"
                ),
                start,
            )

        if ext in MARKITDOWN_EXTENSIONS:
            return await self._read_office_or_pdf(
                rel_path,
                path_key=path_key,
                offset=offset,
                limit=limit,
                using_reread=using_reread,
                start=start,
                context=context,
            )

        try:
            # Full + ranged share read_lines window (default cap = _DEFAULT_READ_LINES).
            # Never whole-file read + silent head-only chop without footer.
            eff_offset = int(offset) if offset is not None else 1
            eff_limit = int(limit) if limit is not None else _DEFAULT_READ_LINES
            result = await context.backend.read_lines(
                rel_path, offset=eff_offset, limit=eff_limit
            )
        except OutsideWorkspace:
            return _error(
                _outside_workspace_msg(rel_path, location=context.backend.location),
                start,
            )
        except PathNotFound:
            return await _file_not_found_error(rel_path, start=start, context=context)
        except NotAFile:
            return _error(f"不是文件：{rel_path}", start)
        except WorkspaceError as e:
            return _map_workspace_read_error(e, path=path_key or rel_path, start=start)

        output = _format_line_window(
            result.lines,
            start_line=result.start_line,
            end_line=result.end_line,
            total_lines=result.total_lines,
        )
        if path_key and not use_range:
            output = _note_file_read_success(
                context, path_key, output, using_reread=using_reread
            )
        # Ranged success: no file_read_counts bump.
        return _file_read_ok(output, start)

    async def _read_office_or_pdf(
        self,
        rel_path: str,
        *,
        path_key: str,
        offset: int | None,
        limit: int | None,
        using_reread: bool,
        start: float,
        context: ToolContext,
    ) -> ToolResult:
        """Transparent office/PDF extract via markitdown (no default ``*.md`` write)."""
        sidecar = parsed_copy_path(rel_path.replace("\\", "/"))
        text: str | None = None

        try:
            sidecar_text = await context.backend.read(sidecar)
            if (sidecar_text or "").strip():
                text = sidecar_text
        except PathNotFound:
            pass
        except OutsideWorkspace:
            return _error(
                _outside_workspace_msg(rel_path, location=context.backend.location),
                start,
            )
        except NotAFile:
            pass
        except WorkspaceError:
            pass

        if text is None:
            try:
                data = await context.backend.read_bytes(rel_path)
            except OutsideWorkspace:
                return _error(
                    _outside_workspace_msg(rel_path, location=context.backend.location),
                    start,
                )
            except PathNotFound:
                return await _file_not_found_error(
                    rel_path, start=start, context=context
                )
            except NotAFile:
                return _error(f"不是文件：{rel_path}", start)
            except WorkspaceError as e:
                return _map_workspace_read_error(e, path=path_key or rel_path, start=start)

            if len(data) > OFFICE_EXTRACT_MAX_BYTES:
                return _office_extract_budget_error(
                    path_key or rel_path, len(data), start
                )

            extracted = await extract_office_bytes(data, ext=extension_of(path_key or rel_path))
            if extracted.status == ParseStatus.FAILED:
                return _error(
                    (
                        f"无法从 `{path_key or rel_path}` 抽取文本"
                        f"（{extracted.detail or 'convert failed'}）。"
                        "若缺 markitdown 依赖或文件损坏，请告知用户；"
                        "不要改用 code_execute 硬解 Office/PDF。"
                    ),
                    start,
                )
            if extracted.status == ParseStatus.SKIPPED:
                return _error(
                    f"`{path_key or rel_path}` 不支持透明文本抽取。",
                    start,
                )
            # OK or SCANNED — both carry honest text (scan notice is not empty success).
            text = extracted.text
            if extracted.status == ParseStatus.SCANNED and not (text or "").strip():
                return _error(
                    f"`{path_key or rel_path}` 看起来是扫描件且无可抽文本层（无 OCR）。",
                    start,
                )

        assert text is not None
        output = _format_extracted_read(text, offset=offset, limit=limit)
        use_range = offset is not None or limit is not None
        if path_key and not use_range:
            output = _note_file_read_success(
                context, path_key, output, using_reread=using_reread
            )
        return _file_read_ok(output, start)


class FileListTool:
    """List files in a directory within the workspace."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_BOTH,
        file_products=FileProductsContract.READ_ONLY,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_list",
            description=(
                "列出某个目录下的文件与子目录。路径必须是相对于工作区的相对路径。"
                "默认只列当前层（recursive=false）：`*.py` 不会进入子目录；"
                "要搜整棵树请设 recursive=true。支持 `{ts,tsx}` 花括号二选一。"
                "区外目录须 `external/<别名>/`（勿传裸 `external`）；"
                "大 zip 持久展开请用 archive_extract，勿假定仅靠 code_execute 解压即工作区可见。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": (
                            "工作区相对 POSIX 目录（默认 `.`=整仓；`/<根标签>/…` 与裸 `/`、"
                            "`\\` 视为根；区外授权目录用 `external/<别名>/`，禁止裸 `external`；"
                            "其它绝对路径拒绝）"
                        ),
                        "default": ".",
                    },
                    "pattern": {
                        "type": "string",
                        "description": (
                            "用于过滤结果的 glob 模式（如 '*.py'、'*.{ts,tsx}'）。"
                            "非递归时只匹配当前层文件名。"
                        ),
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
        pattern = arguments.get("pattern", "*") or "*"
        recursive = bool(arguments.get("recursive", False))
        max_depth = int(arguments.get("max_depth", 3))
        max_depth = max(1, min(max_depth, 8))
        patterns = expand_brace_globs(str(pattern))
        reveal_archives = _pattern_targets_archives(str(pattern))

        if _is_bare_external_directory(str(directory)):
            return _error(
                f"directory={directory!r} 无效：裸 `external` 不是可列目录。"
                + _external_directory_hint(context.backend),
                start,
            )

        prev_reveal = getattr(context.backend, "ai_list_reveal_archives", False)
        if reveal_archives:
            context.backend.ai_list_reveal_archives = True
        try:
            if recursive:
                merged: dict[str, TreeEntry] = {}
                truncated = False
                elided_count = 0
                soft_warnings: list[str] = []
                for pat in patterns:
                    tree = await context.backend.list_tree(
                        directory, pattern=pat, max_depth=max_depth
                    )
                    for entry in tree.entries:
                        merged[entry.path] = entry
                    truncated = truncated or tree.truncated
                    elided_count += tree.elided_count
                    soft_warnings.extend(tree.warnings)
                entries_tree = list(merged.values())
                empty_message = None
                if not entries_tree and _pattern_filters(str(pattern)):
                    bare = [
                        e
                        for e in await context.backend.list(directory, "*")
                        if e.is_dir
                        or not should_hide_ai_noise_from_list(
                            e.path,
                            materials=context.material_paths,
                            reveal_archives=reveal_archives,
                        )
                    ]
                    if bare:
                        empty_message = _no_match_hint(
                            pattern=str(pattern),
                            directory=str(directory),
                            bare_entries=bare,
                            recursive=True,
                        )
                if empty_message is None and not entries_tree:
                    empty_message = _empty_list_message(str(directory))
                # Dedupe soft warnings while preserving order.
                uniq_warnings: list[str] = []
                seen_w: set[str] = set()
                for w in soft_warnings:
                    if w in seen_w:
                        continue
                    seen_w.add(w)
                    uniq_warnings.append(w)
                output = _render_file_tree(
                    entries_tree,
                    directory,
                    max_depth,
                    truncated,
                    elided_count,
                    empty_message=empty_message,
                    warnings=uniq_warnings,
                )
            else:
                # ``list`` is shared with user UI (system-noise only); strip AI
                # noise here so media/archives don't pollute the agent view —
                # except under ``attachments/``, this-turn ``material_paths``,
                # ``external/<alias>/`` archives, or pattern-targeted archives.
                seen: set[str] = set()
                entries: list[DirEntry] = []
                for pat in patterns:
                    for dir_entry in await context.backend.list(directory, pat):
                        if dir_entry.path in seen:
                            continue
                        if dir_entry.is_dir or not should_hide_ai_noise_from_list(
                            dir_entry.path,
                            materials=context.material_paths,
                            reveal_archives=reveal_archives,
                        ):
                            seen.add(dir_entry.path)
                            entries.append(dir_entry)
                if entries:
                    output = "\n".join(
                        f"{'d ' if e.is_dir else 'f '}{e.path}" for e in entries
                    )
                elif _pattern_filters(str(pattern)):
                    bare = [
                        e
                        for e in await context.backend.list(directory, "*")
                        if e.is_dir
                        or not should_hide_ai_noise_from_list(
                            e.path,
                            materials=context.material_paths,
                            reveal_archives=reveal_archives,
                        )
                    ]
                    if bare:
                        output = _no_match_hint(
                            pattern=str(pattern),
                            directory=str(directory),
                            bare_entries=bare,
                            recursive=False,
                        )
                    else:
                        output = _empty_list_message(str(directory))
                else:
                    output = _empty_list_message(str(directory))
        except OutsideWorkspace:
            return _error(
                _outside_workspace_msg(directory, location=context.backend.location),
                start,
            )
        except NotADirectory:
            if _looks_like_external_directory(str(directory)):
                return _error(
                    f"不是可列的区外目录：{directory}。"
                    + _external_directory_hint(context.backend),
                    start,
                )
            # Local/channel backends may still raise for missing declared dirs.
            if is_declared_latent_dir(str(directory)):
                return ToolResult(
                    tool_call_id="",
                    success=True,
                    output=_empty_list_message(str(directory)),
                    duration_ms=int((time.monotonic() - start) * 1000),
                )
            # ServerWorkspace.list maps missing paths to NotADirectory (not PathNotFound).
            base = f"不是目录：{directory}"
            return _path_missing_error(
                await enrich_missing_path_message(context, str(directory), base=base),
                start,
            )
        except PathNotFound:
            if _looks_like_external_directory(str(directory)):
                return _path_missing_error(
                    f"区外路径不存在或未授权：{directory}。"
                    + _external_directory_hint(context.backend),
                    start,
                )
            if is_declared_latent_dir(str(directory)):
                return ToolResult(
                    tool_call_id="",
                    success=True,
                    output=_empty_list_message(str(directory)),
                    duration_ms=int((time.monotonic() - start) * 1000),
                )
            base = f"列目录失败：路径不存在：{directory}"
            return _path_missing_error(
                await enrich_missing_path_message(context, str(directory), base=base),
                start,
            )
        except WorkspaceError as e:
            dead = _maybe_channel_dead_error(e, start)
            if dead is not None:
                return dead
            if _looks_like_external_directory(str(directory)):
                return _error(
                    f"列目录失败：{e}。" + _external_directory_hint(context.backend),
                    start,
                    user_face=False,
                )
            return _error(f"列目录失败：{e}", start, user_face=False)
        finally:
            context.backend.ai_list_reveal_archives = prev_reveal

        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
        )
