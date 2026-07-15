"""Bind a conversation_id to a demo tape (writes demos/bindings.json).

From apps/server::

    # Explicit id
    uv run python scripts/demo_tape_bind.py <conversation_id> \\
        --tape demos/tapes/lv-molihua-trademark.json --speed 4 --max-gap-ms 2000

    # Latest cloud conversation for the seed user (desktop 云端草稿 / 云端随手聊)
    uv run python scripts/demo_tape_bind.py --latest \\
        --tape demos/tapes/lv-molihua-trademark.json --speed 4 --max-gap-ms 2000
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agentcore.db import async_session_factory
from agentcore.db.models import Conversation, Folder
from agentcore.db.repositories import UserRepository
from agentcore.demo_tape.binding import conversation_is_cloud, write_binding

DEFAULT_USERNAME = os.environ.get("DEV_USERNAME", "dev")


@dataclass(frozen=True)
class LatestConversation:
    id: str
    title: str
    is_cloud: bool
    reason: str


async def fetch_latest_conversation(
    session: AsyncSession,
    *,
    username: str,
    cloud_only: bool,
) -> LatestConversation:
    user = await UserRepository(session).get_by_username(username)
    if user is None:
        raise SystemExit(f"unknown username: {username!r}")

    stmt = (
        select(
            Conversation.id,
            Conversation.title,
            Conversation.local_container_root_id,
            Conversation.local_root_id,
            Conversation.folder_id,
            Folder.local_root_id,
        )
        .outerjoin(Folder, Folder.id == Conversation.folder_id)
        .where(
            Conversation.user_id == user.user_id,
            Conversation.deleted_at.is_(None),
        )
        .order_by(Conversation.created_at.desc())
        .limit(40)
    )
    if cloud_only:
        # Cloud bare chat OR cloud project folder (folder.local_root_id IS NULL).
        stmt = stmt.where(
            Conversation.local_container_root_id.is_(None),
            Conversation.local_root_id.is_(None),
            or_(Conversation.folder_id.is_(None), Folder.local_root_id.is_(None)),
        )

    rows = (await session.execute(stmt)).all()
    if not rows:
        hint = (
            "no cloud conversation found — in desktop: composer chip →「云端草稿」, "
            "or Command Palette →「云端随手聊」, send any message to create, then retry"
            if cloud_only
            else "no conversation found for this user"
        )
        raise SystemExit(f"{hint} (username={username!r})")

    cid, title, container, local_root, folder_id, folder_local = rows[0]
    is_cloud, reason = conversation_is_cloud(
        local_container_root_id=container,
        local_root_id=local_root,
        folder_local_root_id=folder_local,
        folder_id=folder_id,
    )
    return LatestConversation(
        id=str(cid),
        title=str(title or ""),
        is_cloud=is_cloud,
        reason=reason,
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "conversation_id",
        nargs="?",
        default=None,
        help="Conversation UUID (omit when using --latest)",
    )
    p.add_argument(
        "--latest",
        action="store_true",
        help="Bind the newest conversation for --username (default: cloud-only)",
    )
    p.add_argument(
        "--username",
        default=DEFAULT_USERNAME,
        help=f"Account for --latest (default: {DEFAULT_USERNAME!r})",
    )
    p.add_argument(
        "--include-local",
        action="store_true",
        help="With --latest, allow local/sidecar conversations (not recommended for desktop replay)",
    )
    p.add_argument("--tape", required=True, help="Repo-relative or absolute tape path")
    p.add_argument("--speed", type=float, default=None)
    p.add_argument("--max-gap-ms", type=int, default=None)
    return p


async def _resolve_conversation_id(args: argparse.Namespace) -> str:
    if args.latest and args.conversation_id:
        raise SystemExit("pass either <conversation_id> or --latest, not both")
    if not args.latest and not args.conversation_id:
        raise SystemExit("provide <conversation_id> or --latest")
    if not args.latest:
        return str(args.conversation_id)

    async with async_session_factory() as session:
        latest = await fetch_latest_conversation(
            session,
            username=args.username,
            cloud_only=not args.include_local,
        )
    label = latest.title.strip() or "(untitled)"
    mode = "cloud" if latest.is_cloud else "LOCAL/sidecar"
    print(f"--latest → {latest.id}  [{mode}]  {label}  ({latest.reason})")
    if not latest.is_cloud:
        print(
            "WARNING: this conversation will likely route to desktop sidecar and "
            "bypass server tape replay. Prefer「云端草稿」/「云端随手聊」.",
            file=sys.stderr,
        )
    return latest.id


async def _amain(args: argparse.Namespace) -> None:
    conversation_id = await _resolve_conversation_id(args)
    path = write_binding(
        conversation_id,
        tape=args.tape,
        speed=args.speed,
        max_gap_ms=args.max_gap_ms,
    )
    print(f"bound {conversation_id} → {args.tape} in {path}")


def main() -> None:
    args = build_parser().parse_args()
    asyncio.run(_amain(args))


if __name__ == "__main__":
    main()
