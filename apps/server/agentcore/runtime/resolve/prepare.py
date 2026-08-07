"""Resolve prepare phase: attachment context + worker wire helpers.

CEO toolset assembly ownership: ``agentcore.tools.ceo_toolset`` (re-exported
here for historical import / monkeypatch seams).
"""

from __future__ import annotations

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


async def _build_attachment_context(
    attachments: list[dict] | None,
    *,
    user_id: str | None = None,
    host_conversation_id: str | None = None,
    conversation_history_access: bool = True,
) -> str | None:
    """Render user-referenced files / dirs / conversations into a prompt block.

    Text files carry pre-extracted text; pre-parsed binaries (docx/pdf/…) carry
    inline text (context-capped) plus a pointer to the ``*.md`` workspace copy;
    office/PDF that missed pre-parse steer ``file_read`` (transparent extract);
    spreadsheet / unknown binaries carry only a workspace path (CEO must
    ``delegate`` → worker ``code_execute``; CEO has no ``code_execute``).
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
            # Binary (or empty-body resident / preparse failed): path only.
            path = ws_path or att.get("path") or name
            if ws_path:
                resident = True
            ext = extension_of(name, ws_path if isinstance(ws_path, str) else None)
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
        f"{resident_note}{binary_note}{office_note}{preparsed_note}{missing_note}\n\n"
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
