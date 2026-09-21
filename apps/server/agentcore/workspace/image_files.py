"""Raster image extensions / MIME — conversation attachments and ``read``.

Single set so workspace files and uploads agree on what is a pixel image
(not SVG markup, not Office).
"""

from __future__ import annotations

from agentcore.workspace.attachment_parse import extension_of

IMAGE_EXTENSIONS = frozenset({
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".avif",
    ".heic",
    ".heif",
})

IMAGE_MIMES = frozenset({
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/avif",
    "image/x-ms-bmp",
    "image/heic",
    "image/heif",
})

IMAGE_MIME_EXCLUDE = frozenset({
    "image/svg+xml",
})

EXT_TO_IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".heic": "image/heic",
    ".heif": "image/heif",
}


def is_raster_image_path(path: str) -> bool:
    """True when ``path`` is a known raster / camera image by extension."""
    return extension_of(path) in IMAGE_EXTENSIONS


def image_data_mime(path: str) -> str:
    """MIME for a data-URL part; default png when the extension is unknown."""
    return EXT_TO_IMAGE_MIME.get(extension_of(path), "image/png")
