"""Entire-command curl/wget → ``web_fetch`` / ``download_url``.

Same family as ``file_read`` given a public URL: the model picked the wrong
*channel*. Not a script classifier — match only when the human command is a
single downloader argv (no pipes / ``&&``). Loopback and this-machine hosts
stay on ``run`` (user-machine path, distinct from the public-web door).
"""

from __future__ import annotations

import ipaddress
import shlex
from typing import Literal, NamedTuple
from urllib.parse import urlparse

from agentcore.core.net import ip_is_safe, is_local_machine_host, is_loopback_host
from agentcore.tools.builtin.package_install import (
    _bin_base,
    _strip_leading_env_assigns,
    split_shell_segments,
)

ShellHttpDest = Literal["web_fetch", "download_url"]

SHELL_FETCH_REDIRECT = "shell_fetch_redirect"
SHELL_DOWNLOAD_REDIRECT = "shell_download_redirect"

_HTTP = ("http://", "https://")

# curl: GET this URL. Unknown flags → no match (install scripts, POST, headers).
_CURL_BOOL_LONG = frozenset(
    {
        "--silent",
        "--show-error",
        "--location",
        "--fail",
        "--insecure",
        "--compressed",
        "--remote-name",
    }
)
_CURL_VALUE_LONG = frozenset(
    {
        "--output",
        "--user-agent",
        "--connect-timeout",
        "--max-time",
        "--retry",
        "--retry-max-time",
    }
)
_CURL_BOOL_LETTERS = frozenset("sSLfkO")
_CURL_VALUE_LETTERS = frozenset("oAm")  # o output; A user-agent; m max-time

_WGET_BOOL = frozenset(
    {
        "-q",
        "--quiet",
        "-nv",
        "--no-verbose",
        "--no-check-certificate",
        "-nc",
        "--no-clobber",
    }
)
_WGET_VALUE = frozenset(
    {
        "-O",
        "--output-document",
        "-o",
        "--output-file",
        "-t",
        "--tries",
        "-T",
        "--timeout",
    }
)

_STDOUT_REDIR = frozenset({">", ">>", "1>", "1>>", "&>"})
_STDERR_REDIR = frozenset({"2>", "2>>"})
_MERGE_REDIR = frozenset({"2>&1", ">&1", ">&2", "|&"})


class ShellHttpHit(NamedTuple):
    dest: ShellHttpDest
    url: str
    matched: str
    code: str


def _clip(snippet: str, limit: int = 80) -> str:
    compact = " ".join(snippet.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1] + "…"


def _is_http_url(token: str) -> bool:
    lowered = (token or "").strip().casefold()
    return lowered.startswith(_HTTP)


def _public_http_url(url: str) -> str | None:
    """Return a stripped public http(s) URL, or None when this is not the public door."""
    text = (url or "").strip()
    if not _is_http_url(text):
        return None
    try:
        parsed = urlparse(text)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"}:
        return None
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        return None
    if is_loopback_host(host) or is_local_machine_host(host):
        return None
    if host.endswith((".local", ".internal", ".localhost")):
        return None
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return text
    if not ip_is_safe(str(ip)):
        return None
    return text


def _peel_stdio_redirects(argv: list[str]) -> tuple[list[str] | None, str | None]:
    """Drop ``2>&1`` / stderr redirects; capture a single stdout dest. None = opaque."""
    out: list[str] = []
    dest: str | None = None
    i = 0
    n = len(argv)
    while i < n:
        tok = argv[i]
        low = tok.lower()
        if low in _MERGE_REDIR or low.startswith("2>/"):
            i += 1
            continue
        if low in _STDOUT_REDIR:
            if dest is not None or i + 1 >= n:
                return None, None
            dest = argv[i + 1]
            i += 2
            continue
        if low in _STDERR_REDIR:
            if i + 1 >= n:
                return None, None
            i += 2
            continue
        if tok.startswith(">>") and len(tok) > 2:
            if dest is not None:
                return None, None
            dest = tok[2:]
            i += 1
            continue
        if tok.startswith(">") and not tok.startswith(">>") and len(tok) > 1:
            if dest is not None:
                return None, None
            dest = tok[1:]
            i += 1
            continue
        out.append(tok)
        i += 1
    return out, dest


def _stdout_dest(path: str | None) -> bool:
    return (path or "").strip() in {"", "-"}


def _hit(
    *,
    dest: ShellHttpDest,
    url: str,
    command: str,
) -> ShellHttpHit:
    code = SHELL_FETCH_REDIRECT if dest == "web_fetch" else SHELL_DOWNLOAD_REDIRECT
    return ShellHttpHit(dest=dest, url=url, matched=_clip(command), code=code)


def _take_value(argv: list[str], i: int, attached: str) -> tuple[str, int] | None:
    if attached:
        return attached, i + 1
    if i + 1 >= len(argv):
        return None
    return argv[i + 1], i + 2


def _parse_curl(argv: list[str], *, shell_dest: str | None, command: str) -> ShellHttpHit | None:
    urls: list[str] = []
    dest = shell_dest
    remote_name = False
    i = 1
    n = len(argv)
    while i < n:
        tok = argv[i]
        if tok == "--":
            i += 1
            continue
        if _is_http_url(tok):
            urls.append(tok)
            i += 1
            continue
        if not tok.startswith("-"):
            return None
        if tok.startswith("--"):
            key, eq, attached = tok.partition("=")
            key_l = key.lower()
            if key_l in _CURL_BOOL_LONG:
                if eq:
                    return None
                if key_l == "--remote-name":
                    remote_name = True
                i += 1
                continue
            if key_l in _CURL_VALUE_LONG:
                taken = _take_value(argv, i, attached)
                if taken is None:
                    return None
                value, i = taken
                if key_l == "--output":
                    if dest is not None:
                        return None
                    dest = value
                continue
            return None
        letters = tok[1:]
        if not letters:
            return None
        j = 0
        while j < len(letters):
            ch = letters[j]
            if ch in _CURL_BOOL_LETTERS:
                if ch == "O":
                    remote_name = True
                j += 1
                continue
            if ch in _CURL_VALUE_LETTERS:
                if j != len(letters) - 1:
                    attached = letters[j + 1 :]
                    j = len(letters)
                else:
                    attached = ""
                taken = _take_value(argv, i, attached)
                if taken is None:
                    return None
                value, i = taken
                if ch in {"o"}:
                    if dest is not None:
                        return None
                    dest = value
                # a / A / m consume a value we ignore (UA / max-time)
                break
            return None
        else:
            i += 1
    if len(urls) != 1:
        return None
    url = _public_http_url(urls[0])
    if url is None:
        return None
    if dest is not None and not _stdout_dest(dest):
        return _hit(dest="download_url", url=url, command=command)
    if remote_name:
        return _hit(dest="download_url", url=url, command=command)
    return _hit(dest="web_fetch", url=url, command=command)


def _parse_wget(argv: list[str], *, shell_dest: str | None, command: str) -> ShellHttpHit | None:
    urls: list[str] = []
    dest = shell_dest
    i = 1
    n = len(argv)
    while i < n:
        tok = argv[i]
        if _is_http_url(tok):
            urls.append(tok)
            i += 1
            continue
        if not tok.startswith("-"):
            return None
        if tok in {"-O-", "-qO-"}:
            if dest is not None:
                return None
            dest = "-"
            i += 1
            continue
        if tok.startswith("-O") and len(tok) > 2:
            if dest is not None:
                return None
            dest = tok[2:]
            i += 1
            continue
        key, eq, attached = tok.partition("=")
        key_l = key.lower() if key.startswith("--") else key
        if key_l in _WGET_BOOL or key in _WGET_BOOL:
            if eq:
                return None
            i += 1
            continue
        if key_l in _WGET_VALUE or key in _WGET_VALUE:
            taken = _take_value(argv, i, attached)
            if taken is None:
                return None
            value, i = taken
            if key in {"-O", "-o"} or key_l in {"--output-document", "--output-file"}:
                if dest is not None and dest != shell_dest:
                    return None
                dest = value
            continue
        return None
    if len(urls) != 1:
        return None
    url = _public_http_url(urls[0])
    if url is None:
        return None
    if dest is not None and _stdout_dest(dest):
        return _hit(dest="web_fetch", url=url, command=command)
    return _hit(dest="download_url", url=url, command=command)


def shell_http_match(command: str) -> ShellHttpHit | None:
    """Hit when the whole command is GET/save one public URL; else None."""
    text = (command or "").strip()
    if not text:
        return None
    segs = split_shell_segments(text)
    if len(segs) != 1:
        return None
    try:
        argv = shlex.split(segs[0], posix=True)
    except ValueError:
        argv = segs[0].split()
    argv = _strip_leading_env_assigns(argv)
    peeled, shell_dest = _peel_stdio_redirects(argv)
    if peeled is None or not peeled:
        return None
    head = _bin_base(peeled[0])
    if head == "curl":
        return _parse_curl(peeled, shell_dest=shell_dest, command=text)
    if head == "wget":
        return _parse_wget(peeled, shell_dest=shell_dest, command=text)
    return None


def shell_http_redirect_message(hit: ShellHttpHit) -> str:
    """Wrong-channel steer — names the product door, does not ban curl."""
    if hit.dest == "download_url":
        return (
            f"公网 http(s) 落到工作区请用 download_url（检测到：{hit.matched}）。"
            "摘字请用 web_fetch。解析、装包、跑测试仍用 run。"
        )
    return (
        f"公网 http(s) 摘字请用 web_fetch（检测到：{hit.matched}）。"
        "落盘请用 download_url。解析、装包、跑测试仍用 run。"
    )
