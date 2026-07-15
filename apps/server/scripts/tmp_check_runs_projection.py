"""临时排查脚本：验证某回合 journal → runs 投影是否含协作图事件（用后即删）。"""

import asyncio
import json
from pathlib import Path

from agentcore.db.base import async_session_factory
from agentcore.db.repositories.runs import TurnJournalRepository
from agentcore.runtime.journal import runs_from_entries_cached

CID = "3cf6f63f-41ec-4d38-abbd-8cf8e7a7b2e6"
TID = "73811098-ec1b-4667-9d28-f7a5b9a23025"
OUT = Path(__file__).parent / "tmp_runs_projection.json"


async def main() -> None:
    async with async_session_factory() as session:
        repo = TurnJournalRepository(session)
        journal_map = await repo.load_map([TID])
    entries = journal_map.get(TID)
    print("load_map entries:", len(entries or []))
    runs = runs_from_entries_cached(TID, entries)
    if runs is None:
        print("CACHED RUNS PROJECTION = None !!")
        return
    evs = runs.get("events") or []
    print("runs.events:", len(evs))
    print("has run_plan:", any(e.get("type") == "run_plan" for e in evs))
    print("finish_reason:", runs.get("finish_reason"))
    OUT.write_text(json.dumps(runs, ensure_ascii=False, default=str), encoding="utf-8")
    print("exported to", OUT)


asyncio.run(main())
