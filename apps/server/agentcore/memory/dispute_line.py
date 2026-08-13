"""行级纠错通道：「这条不对」落在一句话上（Agent记忆与知识系统 §纠错通道·行级）.

条目级 ``disputed_at`` 停用整份内容。但用户是从「记忆已更新」卡里的**一句话**追过来的，
一刀砍掉整个条目会连带否掉仍然正确的几条 —— 他看到的是一句，能操作的却是一个文件，
于是只有两种结局：误伤，或者放弃。

做法是**把那一行搬走**：从条目正文移除，原文存进 ``documents.disputed_lines``。

为什么不是「在正文里给那行打个标记」——bullet 在**正文**里没有能扛住巩固整篇重写的身份，而标记
必须扛得住重写（这正是 ``disputed_at`` 当初进 DB 列而不是 frontmatter 的理由）。搬走还有一层好处：
巩固读不到那句话，不会拿它继续发挥。

**记录行本身有 id**（``DisputedLine``）：它落在 AI 从不重写的列里，身份问题不存在，而撤销必须能
精确点名——按位置寻址的话，连否三条后先撤第一条，第二条的撤销就会静默放回第三条，而提示照样说
「已放回这条记忆」。「一键、不弹确认」的全部正当性都建立在撤销可靠上。记录条数按 entry 设上限
（``MAX_DISPUTED_LINES``），见下方「诚实边界」：这个循环没有自然终点，它的产物就得有。

**诚实边界**：这挡不住「AI 下次从对话里重新学到同一件事再写回来」。本轮**没有**把已否认的
原文当负面约束递给巩固侧——条目级 ``disputed_at`` 至今也只做「不注入」，没有反向喂提示词
（见 ``injection.disputed_memory_paths`` 的全部消费点）。改巩固提示词是 AI 行为面的改动，
得有评测才能判断是变好还是变吵，那是单独一轮的事。所以文案只能说「这条不再用了」，
**不得**说成「以后再也不会出现」。

只有用户在记忆界面上的显式点击能到达这里。**严禁**扫对话原文猜「用户是不是在否认某条记忆」
再自动标记（`intercept-discipline.mdc` 点名否决的意图分类器；误判一次就静默关掉一条用户真正
依赖的规则，而他不会收到任何提示）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from agentcore.db.models.documents import DisputedLine, new_disputed_line
from agentcore.memory.store import (
    CORE_MEMORY_FILE,
    PREFERENCES_MEMORY_FILE,
    MemoryScope,
    MemoryStore,
    is_topic_path,
    memory_version,
    topic_path,
)
from agentcore.memory.user_memory import (
    MarkdownMemoryApplier,
    MemoryAction,
    MemoryOp,
)

_TOPIC_DEFAULT_SECTION = "要点"


class MemoryNoteRow(Protocol):
    """The one field this channel reads off a note row (``Document`` satisfies it)."""

    @property
    def disputed_lines(self) -> list[DisputedLine]: ...


class DisputedLineRepo(Protocol):
    """The note-row operations this channel needs (``DocumentRepository`` satisfies it).

    Narrow on purpose: body and record must land in ONE transaction, which only the repo
    can do, but nothing else about the documents tree belongs in the markdown layer.
    """

    async def get_memory_note(
        self, user_id: str, name: str, folder_id: str | None
    ) -> MemoryNoteRow | None: ...

    async def dispute_memory_line(
        self,
        user_id: str,
        name: str,
        folder_id: str | None,
        *,
        new_content: str,
        line: DisputedLine,
    ) -> MemoryNoteRow | None: ...

    async def restore_memory_line(
        self,
        user_id: str,
        name: str,
        folder_id: str | None,
        *,
        new_content: str,
        line_id: str,
    ) -> MemoryNoteRow | None: ...


@dataclass(frozen=True)
class DisputeLineError:
    """Validation / not-found failure with a user-facing Chinese message."""

    message: str


@dataclass(frozen=True)
class DisputeLineConflict:
    """CAS miss — the entry changed under the user (likely a consolidation pass)."""

    version: str


@dataclass(frozen=True)
class DisputeLineOk:
    version: str
    # Id of the record just written — the handle an undo needs. Empty on restore (the
    # record is gone). Never a position: see ``DisputedLine``.
    line_id: str = ""


DisputeLineResult = DisputeLineOk | DisputeLineConflict | DisputeLineError


def resolve_memory_file(
    *, kind: str, topic_slug: str | None
) -> str | DisputeLineError:
    """Map the card's ``kind`` to the note path holding that bullet.

    Unlike 搬层 there is no legality question here: any line of any entry may be rejected,
    including 偏好 (which cannot move between layers). Only an unusable topic slug fails.
    """
    if kind == "preferences":
        return PREFERENCES_MEMORY_FILE
    if kind == "topic":
        slug = (topic_slug or "").strip()
        if not slug:
            return DisputeLineError("主题笔记需要 topic_slug")
        path = topic_path(slug)
        if not is_topic_path(path):
            return DisputeLineError("无效的主题 slug")
        return path
    return CORE_MEMORY_FILE


async def dispute_memory_line(
    store: MemoryStore,
    repo: DisputedLineRepo,
    *,
    user_id: str,
    content: str,
    section: str,
    scope: MemoryScope = None,
    kind: str = "profile",
    topic_slug: str | None = None,
    baseline: str | None = None,
) -> DisputeLineResult:
    """Move one bullet out of its note and into the entry's disputed record.

    Caller must hold ``user_memory_lock``. ``baseline`` is optional CAS (``None`` =
    unconditional). A no-match REMOVE is refused rather than silently recorded: if the line
    is already gone, recording it would leave a「已否认」row for text nobody can restore to.
    """
    text = (content or "").strip()
    if not text:
        return DisputeLineError("没有可标记的内容")

    sec = (section or "").strip() or (
        _TOPIC_DEFAULT_SECTION if kind == "topic" else ""
    )
    resolved = resolve_memory_file(kind=kind, topic_slug=topic_slug)
    if isinstance(resolved, DisputeLineError):
        return resolved
    file = resolved

    md = await store.load(user_id, file, scope=scope)
    version = memory_version(md)
    if baseline is not None and baseline != version:
        return DisputeLineConflict(version=version)

    applier = MarkdownMemoryApplier()
    # Re-render with no ops first so a no-match REMOVE is not mistaken for a change
    # (apply always re-serializes section/bullet markdown) — 照 move_bullet.
    normalized = applier.apply(md, [])
    removed = applier.apply(
        normalized,
        [MemoryOp(action=MemoryAction.REMOVE, section=sec, match=text, file=file)],
    )
    if removed == normalized:
        return DisputeLineError("这条记忆已经不在了（可能刚被改过）")

    record = new_disputed_line(section=sec, text=text)
    note = await repo.dispute_memory_line(
        user_id,
        file,
        scope,
        new_content=removed,
        line=record,
    )
    if note is None:
        return DisputeLineError("找不到这条记忆所在的条目")
    return DisputeLineOk(version=memory_version(removed), line_id=record["id"])


async def restore_memory_line(
    store: MemoryStore,
    repo: DisputedLineRepo,
    *,
    user_id: str,
    file: str,
    line_id: str,
    scope: MemoryScope = None,
) -> DisputeLineResult:
    """Undo one line-level dispute — the bullet goes back where it came from.

    Caller must hold ``user_memory_lock``. Addressed by the record's id: an unknown id is
    reported, never resolved to whatever sits nearby, so「已放回这条记忆」can only ever
    mean the line the user pointed at. The section is likewise read off the stored record
    rather than from the caller, so an undo cannot re-file the line somewhere it never was.
    """
    note = await repo.get_memory_note(user_id, file, scope)
    if note is None:
        return DisputeLineError("找不到这条记忆所在的条目")
    entry = next((row for row in note.disputed_lines if row["id"] == line_id), None)
    if entry is None:
        return DisputeLineError("这条记录已经不在了")

    md = await store.load(user_id, file, scope=scope)
    applier = MarkdownMemoryApplier()
    added = applier.apply(
        md,
        [
            MemoryOp(
                action=MemoryAction.ADD,
                section=entry["section"],
                content=entry["text"],
                file=file,
            )
        ],
    )

    restored = await repo.restore_memory_line(
        user_id, file, scope, new_content=added, line_id=line_id
    )
    if restored is None:
        return DisputeLineError("这条记录已经不在了")
    return DisputeLineOk(version=memory_version(added))
