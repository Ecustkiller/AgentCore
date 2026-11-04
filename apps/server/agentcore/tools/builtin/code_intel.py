"""Workspace code intelligence: symbols, references, imports and diagnostics."""

from __future__ import annotations

import ast
import asyncio
import re
import time
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import PurePosixPath
from typing import Any, Literal, cast

from agentcore.core.types import ToolApproval, ToolFace
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    FileProductsContract,
    ToolRegistration,
    ToolSurface,
)
from agentcore.workspace.protocol import GrepQuery, WorkspaceError

CodeAction = Literal[
    "symbols",
    "references",
    "imports",
    "diagnostics",
    "affected_tests",
]

_SOURCE_EXTS = frozenset({".py", ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"})
_INDEX_LIST_CAP = 6000
_INDEX_FILE_CAP = 1200
_INDEX_CHAR_CAP = 300_000
_INDEX_TOTAL_CHAR_CAP = 16_000_000
_OUTPUT_LIMIT = 16_000
_INDEX_TRUNCATED_NOTE = "… 索引达到文件或字符安全预算"
_SYMBOL_RE = re.compile(
    r"(?:^|\n)\s*(?:export\s+)?(?:default\s+)?"
    r"(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+"
    r"(?P<name>[A-Za-z_$][\w$]*)",
    re.MULTILINE,
)
_IMPORT_RE = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](?P<module>[^"']+)["']"""
)
_PYFLAKES_CORRECTNESS = frozenset(
    {
        "BreakOutsideLoop",
        "ContinueOutsideLoop",
        "DefaultExceptNotLast",
        "DuplicateArgument",
        "FStringMissingPlaceholders",
        "FutureFeatureNotDefined",
        "LateFutureImport",
        "MultiValueRepeatedKeyLiteral",
        "MultiValueRepeatedKeyVariable",
        "RedefinedInListComp",
        "RedefinedWhileUnused",
        "ReturnOutsideFunction",
        "UndefinedExport",
        "UndefinedLocal",
        "UndefinedName",
        "YieldOutsideFunction",
    }
)


@dataclass(frozen=True)
class SymbolDef:
    path: str
    name: str
    kind: str
    line: int


@dataclass(frozen=True)
class ImportRef:
    module: str
    line: int


@dataclass
class FileIntel:
    path: str
    text: str
    imports: list[ImportRef] = field(default_factory=list)
    symbols: list[SymbolDef] = field(default_factory=list)


@dataclass
class CodeIntelIndex:
    files: dict[str, FileIntel]
    paths: frozenset[str]
    diagnostics: list[tuple[str, int, str]]
    truncated: bool

    @cached_property
    def symbols(self) -> list[SymbolDef]:
        return [symbol for file in self.files.values() for symbol in file.symbols]

    @cached_property
    def reverse_imports(self) -> dict[str, set[str]]:
        modules = _path_modules(self.files)
        reverse: dict[str, set[str]] = {}
        for importer, file in self.files.items():
            for ref in file.imports:
                resolved = _resolve_import(ref.module, importer, modules, self.paths)
                if resolved:
                    reverse.setdefault(resolved, set()).add(importer)
        return reverse


def _is_source(path: str) -> bool:
    return PurePosixPath(path).suffix.lower() in _SOURCE_EXTS


def _is_test(path: str) -> bool:
    parts = set(PurePosixPath(path).parts)
    name = PurePosixPath(path).name
    return (
        "tests" in parts
        or "__tests__" in parts
        or name.startswith("test_")
        or name.endswith("_test.py")
        or ".test." in name
        or ".spec." in name
    )


def _module_aliases(path: str) -> tuple[str, ...]:
    p = PurePosixPath(path)
    if p.suffix != ".py":
        return ()
    parts = list(p.with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    aliases: list[str] = []
    if parts:
        aliases.append(".".join(parts))
    if len(parts) > 1 and parts[0] in {"src", "lib"}:
        aliases.append(".".join(parts[1:]))
    return tuple(dict.fromkeys(aliases))


def _path_modules(files: dict[str, FileIntel]) -> dict[str, tuple[str, ...]]:
    out: dict[str, tuple[str, ...]] = {}
    for path in files:
        aliases = _module_aliases(path)
        if aliases:
            out[path] = aliases
    return out


def _resolve_import(
    raw: str,
    importer: str,
    modules: dict[str, tuple[str, ...]],
    available: frozenset[str],
) -> str | None:
    module = raw.strip()
    if not module:
        return None
    if module.startswith("@/") or module.startswith("~/"):
        base = PurePosixPath(module[2:])
        for prefix in ("", "src/"):
            resolved = f"{prefix}{base.as_posix()}"
            for suffix in (
                "",
                ".ts",
                ".tsx",
                ".js",
                ".jsx",
                "/index.ts",
                "/index.tsx",
                "/index.js",
                "/index.jsx",
            ):
                candidate = f"{resolved}{suffix}"
                if candidate in available:
                    return candidate
        return None
    if module.startswith("./") or module.startswith("../"):
        base = PurePosixPath(importer).parent
        resolved = (base / module).as_posix()
        for suffix in (
            "",
            ".py",
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mts",
            ".mjs",
            ".cts",
            ".cjs",
            "/__init__.py",
            "/index.ts",
            "/index.tsx",
            "/index.js",
            "/index.jsx",
        ):
            candidate = f"{resolved}{suffix}"
            if candidate in available:
                return candidate
        return None
    if module.startswith("."):
        base = PurePosixPath(importer).parent
        level = len(module) - len(module.lstrip("."))
        for _ in range(max(0, level - 1)):
            base = base.parent
        relative = module[level:].replace(".", "/")
        resolved = (base / relative).as_posix()
        for suffix in (
            ".py",
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mts",
            ".mjs",
            ".cts",
            ".cjs",
            "/__init__.py",
            "/index.ts",
            "/index.tsx",
            "/index.js",
            "/index.jsx",
        ):
            candidate = f"{resolved}{suffix}"
            if candidate in available:
                return candidate
        return None
    for path, aliases in modules.items():
        for known in aliases:
            if module == known or module.startswith(known + "."):
                return path
    for path, aliases in modules.items():
        if any(known.startswith(module + ".") for known in aliases):
            return path
    return None


class _PythonCollector(ast.NodeVisitor):
    def __init__(self, path: str) -> None:
        self.path = path
        self.symbols: list[SymbolDef] = []
        self.imports: list[ImportRef] = []
        self._containers: list[tuple[str, bool]] = []

    def _function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        is_method = bool(self._containers and self._containers[-1][1])
        self.symbols.append(
            SymbolDef(
                self.path,
                node.name,
                "method" if is_method else "function",
                node.lineno,
            )
        )
        self._containers.append((node.name, False))
        self.generic_visit(node)
        self._containers.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._function(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.symbols.append(SymbolDef(self.path, node.name, "class", node.lineno))
        self._containers.append((node.name, True))
        self.generic_visit(node)
        self._containers.pop()

    def visit_Import(self, node: ast.Import) -> None:
        self.imports.extend(ImportRef(alias.name, node.lineno) for alias in node.names)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        dots = "." * int(node.level or 0)
        if node.module:
            self.imports.append(ImportRef(f"{dots}{node.module}", node.lineno))
            return
        # ``from . import util`` imports the child module, not the package itself.
        self.imports.extend(
            ImportRef(f"{dots}{alias.name}", node.lineno) for alias in node.names
        )


def _python_intel(
    path: str, text: str
) -> tuple[list[SymbolDef], list[ImportRef], list[tuple[int, str]]]:
    try:
        tree = ast.parse(text, filename=path)
    except SyntaxError as e:
        return [], [], [(e.lineno or 1, e.msg)]
    collector = _PythonCollector(path)
    collector.visit(tree)
    # pyflakes is a lightweight semantic pass (undefined names, redefinitions,
    # unused imports); it is not a full type checker.
    from pyflakes import checker

    messages = checker.Checker(tree, filename=path).messages
    diagnostics = [
        (message.lineno, message.message % message.message_args)
        for message in messages
        if type(message).__name__ in _PYFLAKES_CORRECTNESS
    ]
    return collector.symbols, collector.imports, diagnostics


def _mask_js_noncode(text: str, *, mask_strings: bool) -> str:
    """Blank comments (and optionally strings) while preserving line numbers."""
    out = list(text)
    i = 0
    size = len(text)
    while i < size:
        if text.startswith("//", i):
            end = text.find("\n", i)
            end = size if end < 0 else end
            for j in range(i, end):
                out[j] = " "
            i = end
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            end = size if end < 0 else end + 2
            for j in range(i, end):
                if out[j] != "\n":
                    out[j] = " "
            i = end
            continue
        if text[i] in {"'", '"', "`"}:
            quote = text[i]
            j = i + 1
            while j < size:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == quote:
                    j += 1
                    break
                j += 1
            if mask_strings:
                for k in range(i, min(j, size)):
                    if out[k] != "\n":
                        out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out)


def _js_intel(
    path: str, text: str
) -> tuple[list[SymbolDef], list[ImportRef], list[tuple[int, str]]]:
    code_only = _mask_js_noncode(text, mask_strings=True)
    without_comments = _mask_js_noncode(text, mask_strings=False)
    symbols = [
        SymbolDef(path, match.group("name"), "symbol", text.count("\n", 0, match.start()) + 1)
        for match in _SYMBOL_RE.finditer(code_only)
    ]
    imports = [
        ImportRef(
            match.group("module"),
            text.count("\n", 0, match.start()) + 1,
        )
        for match in _IMPORT_RE.finditer(without_comments)
    ]
    if code_only.count("{") != code_only.count("}"):
        return symbols, imports, [(1, "unbalanced braces")]
    if code_only.count("(") != code_only.count(")"):
        return symbols, imports, [(1, "unbalanced parentheses")]
    return symbols, imports, []


async def build_code_intel_index(
    context: ToolContext,
    *,
    scope: str = "",
) -> CodeIntelIndex:
    cache_key = f"v1:{scope}"
    cached = context.get_cached_tool_result(kind="code_intel_index", key=cache_key)
    if isinstance(cached, CodeIntelIndex):
        return cached
    future, owner = context.begin_tool_inflight(
        kind="code_intel_index",
        key=cache_key,
    )
    if not owner:
        shared = await future
        if isinstance(shared, CodeIntelIndex):
            return shared
    try:
        index = await _build_code_intel_index_uncached(context, scope)
    except BaseException:
        future.cancel()
        raise
    finally:
        context.end_tool_inflight(
            kind="code_intel_index",
            key=cache_key,
            future=future,
        )
    if not future.done():
        future.set_result(index)
    return index


async def _build_code_intel_index_uncached(
    context: ToolContext,
    scope: str,
) -> CodeIntelIndex:
    index_files = getattr(context.backend, "index_files", None)
    if index_files is None:
        return CodeIntelIndex({}, frozenset(), [], False)
    try:
        paths, truncated = await index_files(cap=_INDEX_LIST_CAP, order="path")
    except Exception:
        return CodeIntelIndex({}, frozenset(), [], False)
    scoped = [p for p in paths if _matches_path(p, scope)]
    if scope and not scoped:
        # A very large tree can exhaust the flat-list cap before a deep scope.
        # Walk that scope directly; this path is only for cache-miss scopes.
        try:
            if await context.backend.exists(scope):
                scoped = [scope]
                paths = list(dict.fromkeys([*paths, scope]))
                tree = None
            else:
                tree = await context.backend.list_tree(
                    scope,
                    max_depth=20,
                    max_entries=_INDEX_LIST_CAP,
                )
        except WorkspaceError:
            tree = None
        if tree is not None:
            scoped = [entry.path for entry in tree.entries if not entry.is_dir]
            paths = list(dict.fromkeys([*paths, *scoped]))
    source_candidates = [p for p in scoped if _is_source(p)]
    source_truncated = len(source_candidates) > _INDEX_FILE_CAP
    sources = source_candidates[:_INDEX_FILE_CAP]
    all_paths = frozenset(paths)
    sem = asyncio.Semaphore(16)

    async def _read(path: str) -> tuple[str, str | None, bool]:
        async with sem:
            try:
                text = await context.backend.read(path)
            except WorkspaceError:
                return path, None, False
        return path, text[:_INDEX_CHAR_CAP], len(text) > _INDEX_CHAR_CAP

    pairs = await asyncio.gather(*(_read(path) for path in sources))
    files: dict[str, FileIntel] = {}
    diagnostics: list[tuple[str, int, str]] = []
    chars_used = 0
    content_truncated = False
    for path, text, file_truncated in pairs:
        if text is None:
            continue
        remaining = _INDEX_TOTAL_CHAR_CAP - chars_used
        if remaining <= 0:
            content_truncated = True
            break
        if len(text) > remaining:
            text = text[:remaining]
            file_truncated = True
            content_truncated = True
        chars_used += len(text)
        if path.endswith(".py"):
            symbols, imports, error = _python_intel(path, text)
        else:
            symbols, imports, error = _js_intel(path, text)
        if not file_truncated:
            diagnostics.extend((path, line, message) for line, message in error)
        files[path] = FileIntel(path=path, text=text, imports=imports, symbols=symbols)
    modules = _path_modules(files)
    all_modules = {
        path: aliases
        for path in all_paths
        if (aliases := _module_aliases(path))
    }
    local_roots = {
        alias.split(".", 1)[0]
        for aliases in all_modules.values()
        for alias in aliases
    }
    for path, file in files.items():
        for ref in file.imports:
            if ref.module.startswith("."):
                resolved = _resolve_import(ref.module, path, modules, all_paths)
                label = "unresolved relative import"
            else:
                root = ref.module.split(".", 1)[0]
                if root not in local_roots:
                    continue
                resolved = _resolve_import(ref.module, path, all_modules, all_paths)
                label = "unresolved local import"
            if resolved is None:
                diagnostics.append(
                    (path, ref.line, f"{label} {ref.module}")
                )
    index = CodeIntelIndex(
        files=files,
        paths=all_paths,
        diagnostics=sorted(
            set(diagnostics),
            key=lambda item: (item[0].lower(), item[1], item[2]),
        ),
        truncated=bool(truncated or source_truncated or content_truncated),
    )
    context.cache_tool_result(
        kind="code_intel_index",
        key=f"v1:{scope}",
        value=index,
    )
    return index


def _matches_path(path: str, scope: str) -> bool:
    if not scope:
        return True
    scope = scope.rstrip("/")
    return path == scope or path.startswith(scope + "/")


def _symbol_lines(index: CodeIntelIndex, query: str, path: str, limit: int) -> list[str]:
    needle = query.lower()
    symbols = [
        symbol
        for symbol in index.symbols
        if _matches_path(symbol.path, path)
        and (not needle or needle in symbol.name.lower())
    ]
    lines = [f"{s.path}:{s.line}: {s.kind} {s.name}" for s in symbols[:limit]]
    if len(symbols) > limit:
        lines.append(f"… 另有 {len(symbols) - limit} 个符号")
    return lines


def _symbol_kind(line: str) -> str:
    stripped = line.strip()
    if "class " in stripped:
        return "class"
    if "interface " in stripped or "enum " in stripped or " type " in stripped:
        return "type"
    if "def " in stripped or "function " in stripped:
        return "function"
    return "symbol"


async def _grep_symbol_fallback(
    context: ToolContext,
    *,
    query: str,
    path: str,
    limit: int,
) -> list[str]:
    needle = re.escape(query)
    pattern = (
        rf"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?"
        rf"(?:function|class|interface|type|enum|const|let|var)\s+"
        rf"{needle}[A-Za-z0-9_$]*\b"
        rf"|^\s*(?:async\s+)?(?:def|class)\s+{needle}[A-Za-z0-9_]*\b"
    )
    try:
        result = await context.backend.grep(
            GrepQuery(
                pattern=pattern,
                directory=path or ".",
                max_results=min(limit * 4, 200),
            )
        )
    except WorkspaceError:
        return []
    lines: list[str] = []
    for hit in result.hits:
        if not _is_source(hit.path):
            continue
        symbol = _SYMBOL_RE.search("\n" + hit.text)
        if symbol is None:
            match = re.search(r"\b(?:def|class)\s+([A-Za-z_]\w*)", hit.text)
            name = match.group(1) if match else query
        else:
            name = symbol.group("name")
        lines.append(f"{hit.path}:{hit.line_no}: {_symbol_kind(hit.text)} {name}")
        if len(lines) >= limit:
            break
    return lines


async def _grep_references(
    context: ToolContext,
    *,
    query: str,
    path: str,
    limit: int,
) -> tuple[list[str], int] | None:
    try:
        result = await context.backend.grep(
            GrepQuery(
                pattern=rf"\b{re.escape(query)}\b",
                directory=path or ".",
                max_results=limit,
            )
        )
    except WorkspaceError:
        return None
    lines = [
        f"{hit.path}:{hit.line_no}: {hit.text.strip()[:180]}"
        for hit in result.hits
    ]
    return lines or [f"未找到 {query} 的引用"], len(result.hits)


def _reference_lines(
    index: CodeIntelIndex, query: str, scope: str, limit: int
) -> list[str]:
    if not query:
        return ["references 需要 query"]
    pattern = re.compile(rf"\b{re.escape(query)}\b")
    lines: list[str] = []
    for path, file in index.files.items():
        if not _matches_path(path, scope):
            continue
        for number, text in enumerate(file.text.splitlines(), start=1):
            if pattern.search(text):
                lines.append(f"{path}:{number}: {text.strip()[:180]}")
                if len(lines) >= limit:
                    return [*lines, "… 已截断"]
    return lines or [f"未找到 {query} 的引用"]


def _import_lines(index: CodeIntelIndex, path: str) -> list[str]:
    reverse = index.reverse_imports
    if path:
        file = index.files.get(path)
        if file is None:
            return [f"未索引文件：{path}"]
        lines = [f"{path}:{ref.line} -> {ref.module}" for ref in file.imports]
        lines.extend(f"{path} <- {item}" for item in sorted(reverse.get(path, ())))
        return lines or [f"{path} 没有可解析的 import"]
    return [
        f"{src} <- {', '.join(sorted(importers))}"
        for src, importers in sorted(reverse.items())
    ]


def _test_candidates(source: str) -> list[str]:
    p = PurePosixPath(source)
    stem = p.stem
    parent = p.parent.as_posix()
    prefix = "" if parent == "." else f"{parent}/"
    if p.suffix == ".py":
        candidates = [
            f"{prefix}test_{stem}.py",
            f"{prefix}tests/test_{stem}.py",
            f"{prefix}__tests__/test_{stem}.py",
            f"tests/test_{stem}.py",
        ]
        if parent != ".":
            candidates.append(f"tests/{p.parent.name}/test_{stem}.py")
        return candidates
    return [
        f"{prefix}{stem}.test{p.suffix}",
        f"{prefix}{stem}.spec{p.suffix}",
        f"{prefix}__tests__/{stem}.test{p.suffix}",
        f"{prefix}__tests__/{stem}.spec{p.suffix}",
        f"tests/{stem}.test{p.suffix}",
        f"tests/{stem}.spec{p.suffix}",
    ]


def affected_test_paths(index: CodeIntelIndex, paths: list[str]) -> list[str]:
    reverse = index.reverse_imports
    out: set[str] = set()
    for path in paths:
        if _is_test(path) and path in index.paths:
            out.add(path)
        for candidate in _test_candidates(path):
            if candidate and candidate in index.paths:
                out.add(candidate)
    visited = set(paths)
    frontier = list(paths)
    while frontier:
        current = frontier.pop()
        for importer in reverse.get(current, ()):
            if importer in visited:
                continue
            visited.add(importer)
            if _is_test(importer):
                out.add(importer)
            frontier.append(importer)
    return sorted(out)


def _affected_lines(index: CodeIntelIndex, paths: list[str]) -> list[str]:
    return [
        f"{path}: affected test" for path in affected_test_paths(index, paths)
    ]


def _render(action: CodeAction, index: CodeIntelIndex, args: dict[str, Any]) -> list[str]:
    limit = max(1, min(int(args.get("limit") or 50), 200))
    query = str(args.get("query") or "").strip()
    path = str(args.get("path") or "").strip().replace("\\", "/")
    raw_paths = args.get("paths")
    paths = [str(p) for p in raw_paths] if isinstance(raw_paths, list) else []
    if action == "symbols":
        lines = _symbol_lines(index, query, path, limit)
    elif action == "references":
        lines = _reference_lines(index, query, path, limit)
    elif action == "imports":
        lines = _import_lines(index, path)[:limit]
    elif action == "affected_tests":
        lines = _affected_lines(index, paths)[:limit]
    else:
        lines = [
            f"{p}:{line}: {msg}"
            for p, line, msg in index.diagnostics
            if _matches_path(p, path)
        ][:limit]
        if not lines:
            lines = ["未发现可解析的语法/结构诊断"]
    if index.truncated:
        lines.append(_INDEX_TRUNCATED_NOTE)
    return lines


class CodeIntelTool:
    """Read-only code intelligence over the current workspace."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_BOTH,
        file_products=FileProductsContract.READ_ONLY,
        workspace_io=True,
        catalog_summary="代码符号、引用、依赖与诊断",
        blurb="按符号理解代码，不用反复 grep",
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="code_intel",
            description=(
                "只读代码导航：查声明、文本引用、依赖、静态诊断和受影响测试；"
                "Python 诊断含未定义名称，TS/JS 为轻量结构诊断，非完整 LSP。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "symbols",
                            "references",
                            "imports",
                            "diagnostics",
                            "affected_tests",
                        ],
                    },
                    "query": {
                        "type": "string",
                        "description": "符号名称片段；references 按文本边界匹配。",
                    },
                    "path": {
                        "type": "string",
                        "description": "限定 symbols/references/diagnostics 的文件或目录。",
                    },
                    "paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "affected_tests 的变更文件。",
                    },
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200},
                },
                "required": ["action"],
            },
            face=ToolFace.SEARCH,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        action = str(arguments.get("action") or "").strip()
        allowed = {
            "symbols",
            "references",
            "imports",
            "diagnostics",
            "affected_tests",
        }
        if action not in allowed:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"未知 action：{action}",
                duration_ms=0,
                contract_failure=True,
            )
        limit = max(1, min(int(arguments.get("limit") or 50), 200))
        query = str(arguments.get("query") or "").strip()
        path = str(arguments.get("path") or "").strip().replace("\\", "/")
        if action == "references":
            if not query:
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error="references 需要 query",
                    duration_ms=int((time.monotonic() - start) * 1000),
                    contract_failure=True,
                )
            grep_result = await _grep_references(
                context,
                query=query,
                path=path,
                limit=limit,
            )
            if grep_result is not None:
                lines, match_count = grep_result
                return ToolResult(
                    tool_call_id="",
                    success=True,
                    output="\n".join(lines),
                    duration_ms=int((time.monotonic() - start) * 1000),
                    output_limit=_OUTPUT_LIMIT,
                    metadata={
                        "action": action,
                        "match_count": match_count,
                        "source": "grep",
                    },
                )
        scope = path if action in {"symbols", "references", "diagnostics"} else ""
        index = await build_code_intel_index(context, scope=scope)
        render_args = dict(arguments)
        if action == "affected_tests" and not render_args.get("paths"):
            render_args["paths"] = list(context.landed_artifact_kinds)
        lines = _render(cast(CodeAction, action), index, render_args)
        if action == "symbols" and render_args.get("query"):
            show_budget_note = bool(lines and lines[-1] == _INDEX_TRUNCATED_NOTE)
            if show_budget_note:
                lines = lines[:-1]
            query = str(render_args["query"]).strip()
            has_match = any(
                query.lower() in symbol.name.lower()
                and _matches_path(symbol.path, path)
                for symbol in index.symbols
            )
            if index.truncated or not has_match:
                fallback = await _grep_symbol_fallback(
                    context,
                    query=query,
                    path=path,
                    limit=max(1, min(int(arguments.get("limit") or 50), 200)),
                )
                if fallback:
                    lines = list(dict.fromkeys([*lines, *fallback]))
            if show_budget_note:
                lines.append(_INDEX_TRUNCATED_NOTE)
        output = "\n".join(lines) if lines else "没有结果"
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
            output_limit=_OUTPUT_LIMIT,
            metadata={
                "action": action,
                "files": len(index.files),
                "diagnostics": len(index.diagnostics),
            },
        )
