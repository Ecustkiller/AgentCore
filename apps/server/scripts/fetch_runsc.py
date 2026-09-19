"""Download and verify the gVisor runsc bundle at image build time.

Build-stage helper for ``apps/server/Dockerfile`` (stage ``runsc``) — stdlib
only, driven by env:

- ``RUNSC_URL``: archive or legacy binary URL (default: official latest
  x86_64 ``gvisor.tar.bz2``). After 2026-07 the GCS ``…/runsc`` object is gone;
  releases ship ``runsc`` + ``gvisor-bin/`` in one tarball. A URL whose path
  still ends in ``runsc`` (no ``.tar.*``) is written as a single file.
- ``RUNSC_SHA512``: expected digest; empty → fetch ``${RUNSC_URL}.sha512``;
  literal ``skip`` → no verification (mirrors without a digest file).

Usage: ``python fetch_runsc.py /out/runsc``
"""

from __future__ import annotations

import hashlib
import io
import os
import stat
import sys
import tarfile
import urllib.request

_DEFAULT_URL = (
    "https://storage.googleapis.com/gvisor/releases/release/latest/x86_64/gvisor.tar.bz2"
)

_ARCHIVE_SUFFIXES = (".tar.bz2", ".tar.gz", ".tgz", ".tar.zstd", ".tar.zst")
_ZSTD_SUFFIXES = (".tar.zstd", ".tar.zst")


def _is_archive_url(url: str) -> bool:
    path = url.split("?", 1)[0].lower()
    return path.endswith(_ARCHIVE_SUFFIXES)


def _tar_mode(url: str) -> str:
    path = url.split("?", 1)[0].lower()
    if path.endswith(_ZSTD_SUFFIXES):
        raise SystemExit(
            "zstd archives need extra tools; pass gvisor.tar.bz2 as RUNSC_URL"
        )
    if path.endswith(".tar.bz2"):
        return "r:bz2"
    if path.endswith(".tar.gz") or path.endswith(".tgz"):
        return "r:gz"
    raise SystemExit(f"unsupported runsc archive: {url}")


def _normalize_member_name(name: str) -> str | None:
    name = name.replace("\\", "/").lstrip("/")
    while name.startswith("./"):
        name = name[2:]
    if not name:
        return None
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return "/".join(parts)


def _parse_sha512_payload(raw: str, *, archive_name: str) -> str:
    lines = raw.replace("\r", "\n").splitlines()
    for line in lines:
        if archive_name and archive_name in line:
            for token in line.split():
                t = token.strip().lower()
                if len(t) == 128 and all(c in "0123456789abcdef" for c in t):
                    return t
    for token in raw.replace("\r", "\n").split():
        t = token.strip().lower()
        if len(t) == 128 and all(c in "0123456789abcdef" for c in t):
            return t
    raise SystemExit(f"no sha512 digest found in checksum payload: {raw[:200]!r}")


def _verify(data: bytes, url: str) -> None:
    expected = os.environ.get("RUNSC_SHA512", "")
    if expected == "skip":
        return
    if expected:
        expected = expected.strip().lower()
    else:
        sha_url = url + ".sha512"
        raw = urllib.request.urlopen(sha_url, timeout=120).read().decode()
        expected = _parse_sha512_payload(raw, archive_name=url.rsplit("/", 1)[-1])
    actual = hashlib.sha512(data).hexdigest()
    if actual != expected:
        raise SystemExit(f"runsc sha512 mismatch: {actual} != {expected}")


def _chmod_exec(path: str) -> None:
    mode = os.stat(path).st_mode
    os.chmod(path, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _extract_bundle(data: bytes, url: str, out_path: str) -> None:
    dest_dir = os.path.dirname(out_path) or "."
    os.makedirs(dest_dir, exist_ok=True)
    runsc_written = False
    sidecar_count = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode=_tar_mode(url)) as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            name = _normalize_member_name(member.name)
            if name is None:
                continue
            if name == "runsc" or name.endswith("/runsc"):
                dest = out_path
                runsc_written = True
            elif name == "gvisor-bin" or name.startswith("gvisor-bin/"):
                rel = name.split("gvisor-bin/", 1)[-1] if "/" in name else ""
                if not rel:
                    continue
                dest = os.path.join(dest_dir, "gvisor-bin", rel)
                sidecar_count += 1
            else:
                continue
            dest_parent = os.path.dirname(dest)
            if dest_parent:
                os.makedirs(dest_parent, exist_ok=True)
            extracted = tf.extractfile(member)
            if extracted is None:
                continue
            with open(dest, "wb") as f:
                f.write(extracted.read())
            _chmod_exec(dest)
    if not runsc_written:
        raise SystemExit(f"runsc binary not found inside archive {url}")
    if sidecar_count == 0:
        raise SystemExit(
            f"gvisor-bin/ missing inside archive {url} "
            "(runsc 2026-07+ needs sidecars next to the binary)"
        )
    print(
        f"runsc written: {out_path} (+ {sidecar_count} gvisor-bin files)",
        flush=True,
    )


def install_runsc(out_path: str, *, url: str | None = None) -> None:
    url = url or os.environ.get("RUNSC_URL") or _DEFAULT_URL
    print(f"fetching runsc: {url}", flush=True)
    data = urllib.request.urlopen(url, timeout=600).read()
    _verify(data, url)
    parent = os.path.dirname(out_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if _is_archive_url(url):
        _extract_bundle(data, url, out_path)
        return
    with open(out_path, "wb") as f:
        f.write(data)
    _chmod_exec(out_path)
    print(f"runsc written: {out_path} ({len(data)} bytes)", flush=True)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: fetch_runsc.py <output-path>", file=sys.stderr)
        return 2
    try:
        install_runsc(sys.argv[1])
    except SystemExit as exc:
        if isinstance(exc.code, int):
            return exc.code
        if exc.code:
            print(str(exc.code), file=sys.stderr)
            return 1
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
