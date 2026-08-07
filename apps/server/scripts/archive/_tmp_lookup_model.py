"""One-off: lookup provider + conversation model for a debate trace."""
from __future__ import annotations

import asyncio
import json

from sqlalchemy import text

from agentcore.db.session import get_session_factory

PROVIDER_ID = "5a19babf-2825-4caa-bf04-21f1ce0bb1b6"
CONV_ID = "cf03eb0b-a366-432a-9caf-3578f3690888"


async def main() -> None:
    fac = get_session_factory()
    async with fac() as s:
        # provider tables vary; probe information_schema
        tables = (
            await s.execute(
                text(
                    "select table_name from information_schema.tables "
                    "where table_schema='public' and ("
                    "table_name ilike '%provider%' or table_name ilike '%credential%' "
                    "or table_name ilike '%llm%' or table_name='conversations')"
                )
            )
        ).fetchall()
        print("tables", [t[0] for t in tables])

        for table in ("llm_providers", "providers", "user_providers", "llm_credentials"):
            cols = (
                await s.execute(
                    text(
                        "select column_name from information_schema.columns "
                        "where table_name=:t order by ordinal_position"
                    ),
                    {"t": table},
                )
            ).fetchall()
            if cols:
                print(f"{table} cols", [c[0] for c in cols])

        conv_cols = [
            c[0]
            for c in (
                await s.execute(
                    text(
                        "select column_name from information_schema.columns "
                        "where table_name='conversations' order by ordinal_position"
                    )
                )
            ).fetchall()
        ]
        print("conversations cols", conv_cols)
        want = [
            c
            for c in conv_cols
            if any(k in c for k in ("model", "provider", "agent", "title", "default", "persona"))
        ]
        if want:
            q = "select " + ", ".join(want) + " from conversations where id = :id"
            row = (await s.execute(text(q), {"id": CONV_ID})).mappings().first()
            print("conv", dict(row) if row else None)

        # try common provider lookup shapes
        for q, params in (
            (
                "select * from llm_providers where id::text = :id limit 1",
                {"id": PROVIDER_ID},
            ),
            (
                "select * from providers where id::text = :id limit 1",
                {"id": PROVIDER_ID},
            ),
        ):
            try:
                row = (await s.execute(text(q), params)).mappings().first()
            except Exception as e:  # noqa: BLE001
                print("query fail", q[:40], type(e).__name__, e)
                await s.rollback()
                continue
            if row:
                d = dict(row)
                for secret in list(d):
                    if any(k in secret.lower() for k in ("key", "secret", "token", "password")):
                        d[secret] = "***"
                print("hit", q.split()[3], json.dumps(d, default=str, ensure_ascii=False)[:1500])


if __name__ == "__main__":
    asyncio.run(main())
