"""Deploy-window memory pipeline migration (expand already via Alembic).

Runs in the stop-api window so documents→tables backfill never races live writes:

1. file → documents tree (``migrate_documents``)
2. bare ``记忆/`` → ``AgentCore/`` layout (``migrate_agentcore``)
3. snapshot which legacy-corresponding table rows already exist
4. episodic + meta → tables, copy only (``migrate_episodes``)
5. contract (self-lagged): delete a legacy source only if its table row was in
   the pre-migrate snapshot **and** content still matches — so the first deploy
   that migrates a scope leaves sources in place; the next deploy clears them.
   Pinning back to the previous image can still read ``情景/*.md``.

From ``apps/server``::

    uv run python scripts/migrate_memory_pipeline.py

Compose / deploy::

    docker compose run --rm api python scripts/migrate_memory_pipeline.py
"""

from __future__ import annotations

import argparse
import asyncio
import sys


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run memory layout + documents→tables migrate/contract (deploy window). "
            "Contract is self-lagged one deploy: sources migrated this run are kept "
            "until the next deploy."
        )
    )
    parser.add_argument(
        "--skip-documents",
        action="store_true",
        help="Skip file→documents and AgentCore layout passes.",
    )
    parser.add_argument(
        "--skip-contract",
        action="store_true",
        help="Copy into tables only; leave legacy episodic/meta sources in place.",
    )
    parser.add_argument(
        "--contract-only",
        action="store_true",
        help=(
            "Only run the contract (delete) step. Eligible sources are those whose "
            "table rows already exist at contract start (typically previous deploy)."
        ),
    )
    return parser.parse_args()


async def _run(args: argparse.Namespace) -> int:
    from agentcore.core.logging import get_logger, setup_logging

    setup_logging()
    log = get_logger("migrate_memory_pipeline")
    failed = 0

    if not args.contract_only and not args.skip_documents:
        from agentcore.memory.migrate_agentcore import migrate_agentcore_layout
        from agentcore.memory.migrate_documents import migrate_file_memory_to_documents

        doc_stats = await migrate_file_memory_to_documents()
        log.info(
            "memory.migrate_pipeline_documents",
            users=doc_stats.users_scanned,
            migrated=doc_stats.notes_migrated,
            skipped=doc_stats.notes_skipped_existing,
            failed=doc_stats.notes_failed,
        )
        print(
            "documents:"
            f" users={doc_stats.users_scanned}"
            f" migrated={doc_stats.notes_migrated}"
            f" skipped={doc_stats.notes_skipped_existing}"
            f" failed={doc_stats.notes_failed}"
        )
        failed += doc_stats.notes_failed

        ac_stats = await migrate_agentcore_layout()
        log.info(
            "memory.migrate_pipeline_agentcore",
            scopes=ac_stats.scopes_scanned,
            memory_roots_moved=ac_stats.memory_roots_moved,
            rules_moved=ac_stats.rules_moved,
            failed=ac_stats.scopes_failed,
        )
        print(
            "agentcore:"
            f" scopes={ac_stats.scopes_scanned}"
            f" memory_roots_moved={ac_stats.memory_roots_moved}"
            f" rules_moved={ac_stats.rules_moved}"
            f" failed={ac_stats.scopes_failed}"
        )
        failed += ac_stats.scopes_failed

    from agentcore.db.base import async_session_factory
    from agentcore.memory.migrate_episodes import (
        collect_legacy_episode_scopes,
        contract_document_episode_sources,
        migrate_document_episodes_to_tables,
        snapshot_legacy_table_preimage,
    )

    # One-deploy self-lag: capture which legacy-corresponding rows already exist
    # before this run's migrate, then only those may be contracted afterward.
    bundles = await collect_legacy_episode_scopes(session_factory=async_session_factory)
    preexisting = await snapshot_legacy_table_preimage(bundles, async_session_factory)
    log.info(
        "memory.migrate_pipeline_preimage",
        episodes=len(preexisting.episode_ids),
        scopes=len(preexisting.scope_keys),
    )

    if not args.contract_only:
        ep_stats = await migrate_document_episodes_to_tables()
        failed += ep_stats.failed
        log.info(
            "memory.migrate_pipeline_episodes",
            scopes=ep_stats.scopes_scanned,
            episodes=ep_stats.episodes_migrated,
            metas=ep_stats.metas_migrated,
            skipped=ep_stats.episodes_skipped,
            failed=ep_stats.failed,
        )
        print(
            "episodes-migrate:"
            f" scopes={ep_stats.scopes_scanned}"
            f" episodes={ep_stats.episodes_migrated}"
            f" metas={ep_stats.metas_migrated}"
            f" skipped={ep_stats.episodes_skipped}"
            f" failed={ep_stats.failed}"
        )

    if not args.skip_contract:
        contract_stats = await contract_document_episode_sources(
            preexisting=preexisting
        )
        failed += contract_stats.failed
        log.info(
            "memory.migrate_pipeline_contract",
            scopes=contract_stats.scopes_scanned,
            contracted=contract_stats.scopes_contracted,
            soft_deleted=contract_stats.notes_soft_deleted,
            failed=contract_stats.failed,
        )
        print(
            "episodes-contract:"
            f" scopes={contract_stats.scopes_scanned}"
            f" contracted={contract_stats.scopes_contracted}"
            f" soft_deleted={contract_stats.notes_soft_deleted}"
            f" failed={contract_stats.failed}"
            "  # self-lagged: first migrate keeps sources until next deploy"
        )

    return 1 if failed else 0


def main() -> None:
    args = _parse_args()
    if args.contract_only and args.skip_contract:
        print("error: --contract-only conflicts with --skip-contract", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
