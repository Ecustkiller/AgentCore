"""Resolve prepare phase: attachment context + worker wire helpers.

CEO toolset assembly ownership: ``agentcore.tools.ceo_toolset`` (re-exported
here for historical import / monkeypatch seams).
"""

from __future__ import annotations

import base64
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.memory import default_memory_store
from agentcore.tools.builtin.consult_memory import ConsultMemoryTool
from agentcore.tools.builtin.read_conversation import ReadConversationTool
from agentcore.tools.builtin.search_conversations import SearchConversationsTool
from agentcore.tools.ceo_toolset import _assemble_ceo_toolset  # noqa: F401 — seam
from agentcore.tools.registry import ToolRegistry
from agentcore.workspace.attachment_parse import (
    ATTACHMENT_INLINE_MAX_CHARS,
    MARKITDOWN_EXTENSIONS,
    SKIP_EXTENSIONS,
    extension_of,
    truncate_for_prompt,
)

if TYPE_CHECKING:
    from agentcore.runtime.costing import RunCost
    from agentcore.vision.protocol import VisionReader
    from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)

# Soft-miss / gate-off notes for conversation attachments (跨会话对话日志访问定案 P1).
# Never fall back to client shallow ``text`` — that would silently fake a deep read.
_CONV_ATTACH_SOFT_MISS = (
    "无法打开该对话（可能不存在、已删除、为 handoff，或不在可访问范围内）。"
)
_CONV_ATTACH_GATE_OFF = (
    "跨会话对话日志访问已关闭（conversation_history_access=off），"
    "服务端拒绝深读该对话；未注入客户端浅文。"
    "请在设置中开启「允许 AI 查阅历史对话」后重试。"
)
_CONV_ATTACH_NO_ID = "缺少 conversation_id，无法服务端深读；未注入客户端浅文。"
_CONV_ATTACH_HOST = (
    "那是本回合正在进行的宿主会话——请直接看本会话工作记忆，无需附件深读。"
)
_CONV_ATTACH_TRUNC_NOTE = (
    "\n\n… [truncated for prompt; 完整日志请派查阅 Worker `read_conversation` 续读"
    "（conversation_id={cid}{cursor_part}）]"
)

# Raster / camera image set for eye→text (desktop inline bitmaps + HEIC/HEIF).
_IMAGE_EXTENSIONS = frozenset({
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
_IMAGE_MIMES = frozenset({
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
# Non-raster image/* that must not take the eye→text path (e.g. vector markup).
_IMAGE_MIME_EXCLUDE = frozenset({
    "image/svg+xml",
})
_EXT_TO_IMAGE_MIME = {
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

# Visible-facts prompt for conversation image attachments (eye→text; main LLM stays text).
_ATTACHMENT_VISION_PROMPT = (
    "用中文简要列出这张图片中可见的事实：文字、物体、人物、布局与颜色等。"
    "只写图上能看见的内容，不要臆测图外信息或作者意图。"
)

_IMAGE_VISION_UNCONFIGURED = (
    "未配置识图（组合 vision 槽或 platform VISION_*）：本回合未注入图片可见事实。"
    "勿把工作区路径当作已读图；勿默认建议用 code_execute 打开图片。"
)

_IMAGE_NATIVE_INDEX = (
    "此图已随当前用户消息以多模态附件发送给主模型；"
    "勿再要求 code_execute 开图，也勿假定未看见像素。"
)


def _wire_worker_memory_tools(
    worker_tools: ToolRegistry,
    *,
    memory_enabled: bool = True,
    folder_id: str | None = None,
    has_memory_topics: bool = False,
) -> None:
    """Register ``consult_memory`` on the delegated worker toolset when memory is on
    AND the turn has at least one consultable TOPIC note.

    Same store + project scope as the CEO path (``folder_id`` ⇒ project-then-global
    resolution). Off or empty topics ⇒ not wired — mirrors ``_assemble_ceo_toolset``
    (caller-supplied ``memory_enabled`` + empty-catalog alignment: no directory ⇒ no tool).
    """
    if memory_enabled and has_memory_topics:
        worker_tools.register(
            ConsultMemoryTool(store=default_memory_store(), folder_id=folder_id)
        )


def _wire_worker_conversation_log_tools(
    worker_tools: ToolRegistry,
    *,
    conversation_history_access: bool = True,
    folder_id: str | None = None,
) -> None:
    """Register cross-session log tools when the privacy gate is on.

    ``search_conversations`` / ``read_conversation`` are ``manual_wire`` worker-only
    tools — never auto-registered by ``build_worker_registry``, never on the CEO
    toolset. Gate off ⇒ not wired (跨会话对话日志访问定案).
    """
    if not conversation_history_access:
        return
    worker_tools.register(SearchConversationsTool(folder_id=folder_id))
    worker_tools.register(ReadConversationTool())


async def _deep_read_conversation_attachment(
    att: dict,
    *,
    name: str,
    user_id: str | None,
    host_conversation_id: str | None,
    conversation_history_access: bool,
) -> str:
    """Server-side deep transcript for ``kind=conversation`` — never client shallow text.

    Privacy gate off / missing id / owner soft-miss / handoff / host → explicit note.
    Over-long → first prompt-capped chunk via ``log_export.chunk_transcript`` +
    Worker ``read_conversation`` continuation hint.
    """
    from agentcore.conversation.log_export import (
        chunk_transcript,
        render_conversation_log,
    )
    from agentcore.db.base import async_session_factory
    from agentcore.db.repositories import (
        ConversationRepository,
        MessageRepository,
        TurnJournalRepository,
    )

    cid = str(att.get("conversation_id") or "").strip()
    if not conversation_history_access:
        return f"--- Conversation: {name} [deep-read denied] ---\n{_CONV_ATTACH_GATE_OFF}"
    if not cid:
        return f"--- Conversation: {name} ---\n{_CONV_ATTACH_NO_ID}"
    if host_conversation_id and cid == host_conversation_id:
        return f"--- Conversation: {name} ---\n{_CONV_ATTACH_HOST}"
    if not user_id:
        return f"--- Conversation: {name} ---\n{_CONV_ATTACH_SOFT_MISS}"

    async with async_session_factory() as session:
        conv = await ConversationRepository(session).get_by_id(cid, user_id=user_id)
        if conv is None or conv.mode == "handoff":
            return f"--- Conversation: {name} ---\n{_CONV_ATTACH_SOFT_MISS}"
        messages = list(await MessageRepository(session).list_all_for_conversation(cid))
        assistant_ids = [m.id for m in messages if m.role == "assistant"]
        journal_map = await TurnJournalRepository(session).load_map(assistant_ids)
        full = render_conversation_log(conv, messages, journal_map)
        chunk = chunk_transcript(
            full,
            conversation=conv,
            messages=messages,
            cursor=None,
            max_chars=ATTACHMENT_INLINE_MAX_CHARS,
        )

    title = chunk.title or name
    note = " (truncated; continue via read_conversation)" if chunk.truncated else ""
    body = chunk.transcript
    if chunk.truncated:
        cursor_part = f", next_cursor={chunk.next_cursor}" if chunk.next_cursor else ""
        body += _CONV_ATTACH_TRUNC_NOTE.format(cid=cid, cursor_part=cursor_part)
    return f"--- Conversation: {title}{note} ---\n{body}"


def _attachment_mime(att: dict) -> str:
    raw = att.get("mime") or att.get("content_type") or att.get("media_type") or ""
    return str(raw).split(";", 1)[0].strip().lower()


def _is_image_attachment(att: dict, *, name: str, ws_path: str | None) -> bool:
    """True when extension / MIME should take the vision eye→text path.

    Recognizes known raster/HEIC extensions and MIMEs, plus any ``image/*`` that is
    not explicitly excluded (e.g. ``image/svg+xml``). Non-image MIMEs (xlsx, etc.)
    never match via the ``image/`` prefix alone.
    """
    mime = _attachment_mime(att)
    if mime:
        if mime in _IMAGE_MIME_EXCLUDE:
            return False
        if mime in _IMAGE_MIMES or mime.startswith("image/"):
            return True
    ext = extension_of(name, ws_path if isinstance(ws_path, str) else None)
    return ext in _IMAGE_EXTENSIONS


def _image_data_mime(att: dict, *, name: str, ws_path: str | None) -> str:
    """MIME for data-URL parts — prefer attachment mime, else extension map."""
    mime = _attachment_mime(att)
    if mime.startswith("image/") and mime not in _IMAGE_MIME_EXCLUDE:
        return mime
    ext = extension_of(name, ws_path if isinstance(ws_path, str) else None)
    return _EXT_TO_IMAGE_MIME.get(ext, "image/png")


async def _build_native_image_part(
    *,
    att: dict,
    name: str,
    ws_path: str,
    backend: WorkspaceBackend,
) -> dict | None:
    """Read resident image bytes into an OpenAI ``image_url`` content part."""
    import base64

    try:
        raw = await backend.read_bytes(ws_path)
    except Exception:  # noqa: BLE001 — native path must not break prepare
        logger.warning("attachment.native_image_read_failed", path=ws_path, exc_info=True)
        return None
    if not raw:
        return None
    b64 = base64.b64encode(raw).decode("ascii")
    mime = _image_data_mime(att, name=name, ws_path=ws_path)
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{b64}"},
    }


def _vision_credential_source(reader: VisionReader) -> str | None:
    """Pricing origin stamped on the reader (BYOK→user, platform→platform)."""
    src = getattr(reader, "credential_source", None)
    if src in ("user", "platform", "vendor"):
        return str(src)
    return None


def _bill_attachment_vision(
    reading: Any,
    *,
    cost_sink: list[RunCost] | None,
    reader: VisionReader,
    parent_run_id: str | None,
) -> None:
    """Append a ``role=vision`` ledger row; never raise into prepare."""
    if cost_sink is None or not reading.model or reading.usage.total_tokens == 0:
        return
    try:
        from agentcore.runtime.costing import vision_run_cost

        cost_sink.append(
            vision_run_cost(
                reading.model,
                reading.usage,
                parent_run_id=parent_run_id,
                credential_source=_vision_credential_source(reader),
            )
        )
    except Exception:  # noqa: BLE001 — billing must never break a successful read
        logger.warning("attachment.vision_billing_failed", exc_info=True)


async def _read_image_attachment_block(
    *,
    name: str,
    path: str,
    ws_path: str,
    vision_reader: VisionReader | None,
    backend: WorkspaceBackend | None,
    cost_sink: list[RunCost] | None,
    parent_run_id: str | None,
) -> str:
    """Eye→text for a resident image, or an honest unconfigured / failure note."""
    if vision_reader is None or backend is None:
        return (
            f"--- File: {name} ({path}) [image] ---\n"
            f"{_IMAGE_VISION_UNCONFIGURED}"
        )
    try:
        raw = await backend.read_bytes(ws_path)
    except Exception as exc:  # noqa: BLE001 — prepare must not crash on one attachment
        logger.warning(
            "attachment.vision_read_failed",
            name=name,
            path=ws_path,
            error=str(exc),
            exc_info=True,
        )
        return (
            f"--- File: {name} ({path}) [image / read failed] ---\n"
            f"无法读取工作区图片字节：{exc}。本回合未注入可见事实。"
        )
    if not raw:
        return (
            f"--- File: {name} ({path}) [image / empty] ---\n"
            "工作区图片为空，本回合未注入可见事实。"
        )
    b64 = base64.b64encode(raw).decode("ascii")
    try:
        reading = await vision_reader.read(b64, _ATTACHMENT_VISION_PROMPT)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "attachment.vision_read_failed",
            name=name,
            path=ws_path,
            error=str(exc),
            exc_info=True,
        )
        return (
            f"--- File: {name} ({path}) [image / vision failed] ---\n"
            f"识图失败：{exc}。工作区路径仍可用，但本回合未注入可见事实。"
        )
    _bill_attachment_vision(
        reading,
        cost_sink=cost_sink,
        reader=vision_reader,
        parent_run_id=parent_run_id,
    )
    logger.info("attachment.vision_read", name=name, path=ws_path)
    body = (reading.text or "").strip() or "(视觉模型未返回可见事实)"
    return f"--- File: {name} ({path}) [image / vision] ---\n{body}"


async def _build_attachment_context(
    attachments: list[dict] | None,
    *,
    user_id: str | None = None,
    host_conversation_id: str | None = None,
    conversation_history_access: bool = True,
    vision_reader: VisionReader | None = None,
    backend: WorkspaceBackend | None = None,
    cost_sink: list[RunCost] | None = None,
    vision_parent_run_id: str | None = None,
    main_native_vision: bool = False,
    native_image_parts: list[dict] | None = None,
) -> str | None:
    """Render user-referenced files / dirs / conversations into a prompt block.

    Text files carry pre-extracted text; pre-parsed binaries (docx/pdf/…) carry
    inline text (context-capped) plus a pointer to the ``*.md`` workspace copy;
    office/PDF that missed pre-parse steer ``file_read`` (transparent extract);
    spreadsheet / unknown binaries carry only a workspace path (CEO must
    ``delegate`` → worker ``code_execute``; CEO has no ``code_execute``).
    Resident **image** attachments: when ``main_native_vision`` and
    ``native_image_parts`` is provided, bytes become multimodal ``image_url``
    parts (no VisionReader); otherwise eye→text via ``vision_reader`` when
    wired; without a reader the block states识图未配置 honestly (never silent
    path-only, never「用 code_execute 开图」as primary).
    Directories carry a recursive file listing (paths only);
    ``kind=conversation`` is **server deep-read** via ``log_export``
    (client shallow ``text`` is ignored). A file with a ``workspace_path``
    was persisted into the workspace, so the header points the agent at that
    durable path. Returns None when there is nothing to inject so the base
    prompt stays unchanged.
    """
    if not attachments:
        return None

    blocks: list[str] = []
    resident = False
    has_binary = False
    has_office_unparsed = False
    has_preparsed = False
    has_conversation = False
    has_resident_missing = False
    has_image_unconfigured = False
    for att in attachments:
        name = att.get("name") or "untitled"
        kind = att.get("kind") or "file"
        text = (att.get("text") or "").strip()
        binary = bool(att.get("binary"))
        ws_path = att.get("workspace_path")
        parse_status = att.get("parse_status")
        parsed_path = att.get("parsed_workspace_path")

        if kind == "file" and att.get("resident_missing"):
            # 验盘失败：元数据有路径、字节未落盘——禁当已交源码 / 禁派解压。
            has_resident_missing = True
            claimed = (
                att.get("claimed_workspace_path")
                or att.get("path")
                or name
            )
            blocks.append(
                f"--- File: {name} ({claimed}) [resident missing] ---\n"
                "Attachment metadata lists this path, but the bytes are NOT in "
                "the workspace (upload/residency failed or incomplete). "
                "Do NOT treat this as delivered source. Do NOT delegate unzip/"
                "edit against this path. Immediately ask_user to re-upload."
            )
            continue

        if kind == "dir":
            if not text:
                continue
            path = att.get("path") or name
            note = " (partial listing)" if att.get("truncated") else ""
            blocks.append(
                f"--- Directory: {name} ({path}){note} ---\n"
                f"File paths (contents not included):\n{text}"
            )
        elif kind == "conversation":
            has_conversation = True
            blocks.append(
                await _deep_read_conversation_attachment(
                    att,
                    name=name,
                    user_id=user_id,
                    host_conversation_id=host_conversation_id,
                    conversation_history_access=conversation_history_access,
                )
            )
        elif parse_status == "scanned" and text:
            path = ws_path or att.get("path") or name
            if ws_path:
                resident = True
            has_preparsed = True
            copy_note = f" [scan note → {parsed_path}]" if parsed_path else ""
            blocks.append(
                f"--- File: {name} ({path}) [scanned / no text layer]{copy_note} ---\n{text}"
            )
        elif parse_status == "ok" and text:
            path = ws_path or att.get("path") or name
            if ws_path:
                resident = True
            has_preparsed = True
            body, clipped = truncate_for_prompt(text)
            client_trunc = bool(att.get("truncated"))
            flags: list[str] = []
            if parsed_path and parsed_path != path:
                flags.append(f"pre-parsed → {parsed_path}")
            if clipped or client_trunc:
                flags.append("truncated")
            flag_s = f" [{'; '.join(flags)}]" if flags else ""
            block = f"--- File: {name} ({path}){flag_s} ---\n{body}"
            if clipped and parsed_path:
                block += (
                    f"\n\n… [truncated at {len(body)} chars for context; "
                    f"full extracted text is at {parsed_path}]"
                )
            elif clipped:
                block += f"\n\n… [truncated at {len(body)} chars for context]"
            blocks.append(block)
        elif binary or (ws_path and not text):
            # Binary (or empty-body resident / preparse failed): path only —
            # except resident images → native multimodal or VisionReader eye→text.
            path = ws_path or att.get("path") or name
            if ws_path:
                resident = True
            ws_str = ws_path if isinstance(ws_path, str) and ws_path else None
            if (
                binary
                and ws_str
                and _is_image_attachment(att, name=name, ws_path=ws_str)
            ):
                if (
                    main_native_vision
                    and native_image_parts is not None
                    and backend is not None
                ):
                    part = await _build_native_image_part(
                        att=att,
                        name=name,
                        ws_path=ws_str,
                        backend=backend,
                    )
                    if part is not None:
                        native_image_parts.append(part)
                        blocks.append(
                            f"--- File: {name} ({path}) [image / multimodal] ---\n"
                            f"{_IMAGE_NATIVE_INDEX}"
                        )
                    else:
                        blocks.append(
                            f"--- File: {name} ({path}) [image / multimodal failed] ---\n"
                            "无法读取驻留图片字节，本回合未把该图发给主模型。"
                        )
                    continue
                if vision_reader is None or backend is None:
                    has_image_unconfigured = True
                blocks.append(
                    await _read_image_attachment_block(
                        name=name,
                        path=path,
                        ws_path=ws_str,
                        vision_reader=vision_reader,
                        backend=backend,
                        cost_sink=cost_sink,
                        parent_run_id=vision_parent_run_id,
                    )
                )
                continue
            ext = extension_of(name, ws_str)
            if ext in MARKITDOWN_EXTENSIONS:
                has_office_unparsed = True
                blocks.append(
                    f"--- File: {name} ({path}) [binary / office-pdf] ---\n"
                    "No inline text for this office/PDF attachment (pre-parse missed or "
                    "failed). Use file_read on the workspace-relative path above — "
                    "text is extracted automatically. Do NOT default to code_execute "
                    "for office/PDF. Do NOT use an OS absolute path."
                )
            else:
                has_binary = True
                sheet_hint = (
                    " (e.g. openpyxl / pandas for .xlsx/.csv)"
                    if ext in SKIP_EXTENSIONS
                    else ""
                )
                blocks.append(
                    f"--- File: {name} ({path}) [binary] ---\n"
                    "This is a binary file saved in the workspace (no text inline). "
                    "CEO has no code_execute — delegate a worker to open/parse it "
                    "with code_execute on the workspace-relative path "
                    f"above{sheet_hint}. Do NOT use an OS absolute path. "
                    "Do NOT treat file_list emptiness as missing."
                )
        elif text:
            path = ws_path or att.get("path") or name
            if ws_path:
                resident = True
            note = " (truncated)" if att.get("truncated") else ""
            blocks.append(f"--- File: {name} ({path}){note} ---\n{text}")

    if not blocks:
        return None

    body = "\n\n".join(blocks)
    resident_note = (
        " Files shown with an in-workspace path have been saved into your "
        "workspace — read or edit them with the file tools by that path rather "
        "than trusting only the (possibly truncated) text below."
        if resident
        else ""
    )
    binary_note = (
        " Spreadsheet / unknown binary attachments have no inline body: "
        "delegate a worker to code_execute on the workspace-relative path "
        "(CEO has no code_execute). Never hard-read an OS absolute path "
        "outside the workspace (it will fail or hang)."
        if has_binary
        else ""
    )
    office_note = (
        " Office/PDF attachments without inline text: use file_read on the "
        "workspace path (automatic text extract); do not default to code_execute."
        if has_office_unparsed
        else ""
    )
    preparsed_note = (
        " Some office/PDF attachments were pre-parsed at upload: inline text may "
        "be truncated — use the ``*.md`` workspace copy (or the original path) "
        "with file tools for the full extract."
        if has_preparsed
        else ""
    )
    conversation_note = (
        " A Conversation block is a server-rendered deep transcript (messages +"
        " process layer); when truncated, delegate a Worker with"
        " ``read_conversation`` to continue — do not treat a truncated block as"
        " the full log."
        if has_conversation
        else ""
    )
    missing_note = (
        " A [resident missing] block means chip/metadata claimed a workspace "
        "path but bytes are absent — ask_user to re-upload; never dispatch "
        "unzip/remediation as if the file were already delivered."
        if has_resident_missing
        else ""
    )
    image_note = (
        " Image attachments are eye→text when识图 is configured (profile vision "
        "slot or platform VISION_*); without a reader, the block states that "
        "honestly — do not treat a bare path as a reading, and do not default to "
        "code_execute to open images."
        if has_image_unconfigured
        else ""
    )
    return (
        "<attached_files>\n"
        "The user attached the following files, directories and past "
        "conversations as actionable inputs for this turn—not mere optional "
        "reference. When the user narrows scope to these materials and/or "
        "existing workspace products, start from them (gap analysis or a "
        "revision); do not idle solely because a full repo is missing. Cite "
        "them by name when relevant. Directory entries list file paths only "
        "(file contents are not included)."
        f"{conversation_note}"
        f"{resident_note}{binary_note}{office_note}{preparsed_note}"
        f"{missing_note}{image_note}\n\n"
        f"{body}\n"
        "</attached_files>"
    )


def _build_agent_mention_context(
    agent_mentions: list[dict] | None,
) -> str | None:
    """Render conversation-page Agent soft mentions into a prompt block.

    Soft hint only — does not force delegate / hard-route. Empty / missing → None
    so the turn stays byte-identical to today's no-mention assembly.
    """
    if not agent_mentions:
        return None
    lines: list[str] = []
    for raw in agent_mentions:
        if not isinstance(raw, dict):
            continue
        agent_id = str(raw.get("agent_id") or "").strip()
        role = str(raw.get("role") or "").strip()
        if not agent_id or not role:
            continue
        lines.append(f"- {role} (id={agent_id})")
    if not lines:
        return None
    return (
        "<agent_mentions>\n"
        "用户点名关注以下 Agent（软提示，非强制派单/非硬路由）：\n"
        + "\n".join(lines)
        + "\n</agent_mentions>"
    )


def merge_attachment_and_mention_context(
    attachment_context: str | None,
    agent_mentions: list[dict] | None,
) -> str | None:
    """Join file attachment block with optional Agent soft-mention block.

    Mentions ride the same ATTACHMENT volatile tail (紧邻 / 并入) so CEO and
    workers that already consume ``attachment_context`` stay in sync.
    """
    mention = _build_agent_mention_context(agent_mentions)
    if attachment_context and mention:
        return f"{attachment_context}\n\n{mention}"
    return attachment_context or mention
