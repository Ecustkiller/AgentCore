"""探针：多端同权（B2）真跑验收——两条真 SSE 连接对着真后端跑验收 2/3/4/5。

单测能证明「函数被调用了」，证明不了「两台设备在真实时序下真的都看见了」。本脚本挂两条
真连接（A 扮桌面、B 扮手机 `follow=true` 对话级订阅）对着运行中的后端跑，断言的是**帧到没
到对端**：

- **场景 1（验收 4 · 空闲对话也同步）**：B 停在**空闲**会话上（此前会 204 打回），A 发一条 →
  B 必须自动收到这个新回合。
- **场景 2（验收 3 · 不掐流）**：回合跑着时 B 再挂上来 → A **不被挤成 detached**，两端各自收全
  到 `message_end`。这条直接推翻旧口径「对话 SSE 是单消费者，手机打开即把桌面挤掉」。
- **场景 3（验收 5 · 短暂态一致）**：A 在自己占着槽时排一条 → **B 必须看见 `turn_queued`**；撤单
  → **B 必须看见 `turn_queue_cancelled`**。这两帧此前只到发起端，是 P1 信号道的全部价值。
- **场景 4（验收 5 · 任一端 Stop 两端同停）**：A 跑着，B 跟播，任一端 `POST …/stop` → 两端都收口。
- **场景 5（验收 2 · 对端收口）**：一张真开工卡两端同时可见，**由 B 点掉** → A 那张自动收口，
  不用刷新。要模型真的组队才有卡，没弹卡时判 SKIP 而非 FAIL。

跑法（后端须已起，见 `docs/02-架构/本地开发.md`；建议 `AGENTCORE_RELOAD=false`，
热重载会在回合中途重启 worker）::

    uv run python scripts/archive/probe_multiend.py
    uv run python scripts/archive/probe_multiend.py --only 3      # 只跑场景 3
    uv run python scripts/archive/probe_multiend.py --keep        # 失败时保留会话便于查日志

凭据同 `probe_turn.py`（`dev` / `devpassword`，`DEV_USERNAME` / `DEV_PASSWORD` 可覆盖）。
真跑要烧 LLM 额度（每个场景 1–2 个回合），走 dev 账号 BYOK — `.cursor/rules/local-llm-dogfood.mdc`。
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import time
from typing import Any

import httpx

# 统一时间基准：两端的 t_ms 必须可直接相减，否则量不出「对端晚了多久」——
# 而「晚多久」正是跟播与「等回合结束才回放」的分界。
T0 = time.monotonic()

DEFAULT_BASE_URL = os.environ.get("PROBE_BASE_URL", "http://localhost:8000")
DEFAULT_USERNAME = os.environ.get("DEV_USERNAME", "dev")
DEFAULT_PASSWORD = os.environ.get("DEV_PASSWORD", "devpassword")

# 够长、让回合跑满几秒，好在窗口内插队 / 停止；又不至于烧太多 token。
SLOW_PROMPT = "用中文写一段 150 字左右的散文，主题是清晨的海边。只要正文。"
FAST_PROMPT = "只回复两个字：你好"
# 场景 5 要的是一张真卡：组队必然先弹开工卡（team_preview）等人授权。
TEAM_PROMPT = (
    "组建一个辩论团队来辩「远程办公是否提升生产力」，正方反方各一位辩手，"
    "先给出团队组成，等我授权后再开始辩论。"
)


class Endpoint:
    """一个「端」：一条 SSE 连接 + 它**实际收到**的事件序列。

    断言全部基于 `events` —— 谁在什么时刻收到了什么，正是多端同权唯一说得清的判据。
    """

    def __init__(
        self, name: str, platform: str, token: str, base: str, device_id: str = "probe"
    ) -> None:
        self.name = name
        self.platform = platform
        self.token = token
        self.base = base
        # HTTP 头只能 ASCII，与中文端名分开（同一台设备的两条连接应共用一个 id）。
        self.device_id = device_id
        self.events: list[dict[str, Any]] = []
        self.status: int | None = None
        self.error: str | None = None
        self.last_id: str | None = None
        self.done = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._cursor = 0

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "X-Client-Platform": self.platform,
            "X-Client-Device": self.device_id,
        }

    async def _consume(self, resp: httpx.Response) -> None:
        async for line in resp.aiter_lines():
            if line.startswith("id:"):
                self.last_id = line[3:].strip()
                continue
            if not line.startswith("data:"):
                continue
            raw = line[5:].strip()
            if not raw:
                continue
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                continue
            self.events.append(
                {
                    "t_ms": int((time.monotonic() - T0) * 1000),
                    "type": ev.get("type", "?"),
                    "payload": ev.get("payload") or {},
                }
            )

    def follow(self, client: httpx.AsyncClient, conv_id: str) -> None:
        """挂对话级订阅（`follow=true`）——第二台设备的姿势。"""

        async def run() -> None:
            try:
                async with client.stream(
                    "GET",
                    f"{self.base}/v1/conversations/{conv_id}/stream",
                    params={"follow": "true"},
                    headers=self.headers,
                ) as resp:
                    self.status = resp.status_code
                    if resp.status_code != 200:
                        self.error = f"HTTP {resp.status_code}"
                        return
                    await self._consume(resp)
            except Exception as e:  # noqa: BLE001 — 探针：连接怎么断的本身就是结论
                self.error = repr(e)
            finally:
                self.done.set()

        self._task = asyncio.create_task(run())

    def send(self, client: httpx.AsyncClient, conv_id: str, content: str, delivery: str) -> None:
        """发一条消息并跟读它自己那条流——发起端的姿势。"""

        async def run() -> None:
            try:
                async with client.stream(
                    "POST",
                    f"{self.base}/v1/conversations/{conv_id}/messages",
                    headers=self.headers,
                    json={"content": content, "delivery": delivery},
                ) as resp:
                    self.status = resp.status_code
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode("utf-8", "replace")
                        self.error = f"HTTP {resp.status_code}: {body[:200]}"
                        return
                    await self._consume(resp)
            except Exception as e:  # noqa: BLE001
                self.error = repr(e)
            finally:
                self.done.set()

        self._task = asyncio.create_task(run())

    def resume(self, client: httpx.AsyncClient, conv_id: str, message_id: str) -> None:
        """冷路放行（另一端点掉那张卡）。也返回 SSE，必须跟读——当普通 POST 会一直等到流结束。"""

        async def run() -> None:
            try:
                async with client.stream(
                    "POST",
                    f"{self.base}/v1/conversations/{conv_id}/messages/{message_id}/resume",
                    headers=self.headers,
                    json={"decision": "continue", "note": ""},
                ) as resp:
                    self.status = resp.status_code
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode("utf-8", "replace")
                        self.error = f"HTTP {resp.status_code}: {body[:200]}"
                        return
                    await self._consume(resp)
            except Exception as e:  # noqa: BLE001
                self.error = repr(e)
            finally:
                self.done.set()

        self._task = asyncio.create_task(run())

    async def expect(self, *types: str, timeout: float = 60.0) -> dict[str, Any] | None:
        """按到达顺序等下一个属于 `types` 的事件；超时返回 None。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            while self._cursor < len(self.events):
                ev = self.events[self._cursor]
                self._cursor += 1
                if ev["type"] in types:
                    return ev
            if self.done.is_set() and self._cursor >= len(self.events):
                return None
            await asyncio.sleep(0.05)
        return None

    def seen(self, *types: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e["type"] in types]

    def summary(self) -> str:
        counts: dict[str, int] = {}
        for e in self.events:
            counts[e["type"]] = counts.get(e["type"], 0) + 1
        parts = ", ".join(f"{k}×{v}" for k, v in counts.items())
        tail = f" [error={self.error}]" if self.error else ""
        return f"{self.name}: {parts or '(无事件)'}{tail}"

    async def close(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            # CancelledError 是 BaseException，不在 Exception 里——两个都要收。
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[bool, str, str]] = []
        self.skipped: list[str] = []

    def check(self, ok: bool, label: str, detail: str = "") -> bool:
        self.rows.append((ok, label, detail))
        mark = "PASS" if ok else "FAIL"
        line = f"    [{mark}] {label}"
        if detail:
            line += f" — {detail}"
        print(line)
        return ok

    def skip(self, label: str, detail: str) -> None:
        """判不了的条目要如实说判不了——把上游限流算成 FAIL 会让人去查不存在的缺陷。"""
        self.skipped.append(label)
        print(f"    [SKIP] {label} — {detail}")

    @property
    def failed(self) -> int:
        return sum(1 for ok, _, _ in self.rows if not ok)


async def _login(client: httpx.AsyncClient, base: str, user: str, pw: str) -> str:
    r = await client.post(
        f"{base}/v1/auth/token",
        headers={"X-Client-Platform": "desktop"},
        json={"username": user, "password": pw},
    )
    if r.status_code == 401:
        raise SystemExit("登录失败 (401)。先建 dev 账号：uv run python scripts/seed_dev_user.py")
    r.raise_for_status()
    return r.json()["access_token"]


async def _new_conversation(client: httpx.AsyncClient, base: str, hdrs: dict[str, str]) -> str:
    r = await client.post(f"{base}/v1/conversations", headers=hdrs, json={"title": "多端验收"})
    r.raise_for_status()
    return r.json()["id"]


async def scenario_idle_follow(
    client: httpx.AsyncClient, base: str, token: str, rep: Report
) -> None:
    """验收 4：B 停在空闲会话上，A 发一条 → B 自动收到新回合。"""
    print("\n场景 1 · 验收 4：空闲对话也同步（B 停在空闲会话，A 发消息）")
    hdrs = {"Authorization": f"Bearer {token}", "X-Client-Platform": "desktop"}
    conv = await _new_conversation(client, base, hdrs)
    print(f"  会话 {conv}")

    b = Endpoint("B(手机·follow)", "mobile", token, base, "probe-mobile")
    b.follow(client, conv)
    await asyncio.sleep(2.0)  # 让订阅在**空闲**状态下先挂稳

    rep.check(
        b.status == 200 and not b.done.is_set(),
        "空闲会话不打回 204，连接挂得住",
        f"status={b.status} closed={b.done.is_set()}",
    )

    a = Endpoint("A(桌面·POST)", "desktop", token, base, "probe-desktop")
    a.send(client, conv, FAST_PROMPT, "steer")

    a_start = await a.expect("message_start", timeout=60)
    got = await b.expect("message_start", timeout=60)
    rep.check(
        got is not None,
        "A 发的新回合自动出现在 B 上（无需刷新）",
        f"B 收到 message_start @{got['t_ms']}ms" if got else "B 60s 内没收到 message_start",
    )

    # 「收到了」不等于「跟得上」：若 B 要等回合收口才拿到首帧，产品上就不是换端接着盯，
    # 而是换端等结束才看到——这条把两者分开。
    if got and a_start:
        lag = got["t_ms"] - a_start["t_ms"]
        rep.check(lag < 3000, "B 实时跟播（非等回合结束才回放）", f"B 比 A 晚 {lag}ms")

    end_a = await a.expect("message_end", timeout=90)
    end_b = await b.expect("message_end", timeout=90)
    rep.check(end_b is not None, "B 跟到回合结束")
    if end_a and end_b:
        rep.check(
            end_b["t_ms"] - end_a["t_ms"] < 3000,
            "两端几乎同时收口",
            f"B 比 A 晚 {end_b['t_ms'] - end_a['t_ms']}ms",
        )

    await a.close()
    await b.close()
    print(f"    {a.summary()}\n    {b.summary()}")


async def scenario_no_kick(client: httpx.AsyncClient, base: str, token: str, rep: Report) -> None:
    """验收 3：回合跑着时 B 挂上来，A 不被挤掉，两端各自收全。"""
    print("\n场景 2 · 验收 3：不掐流（后开的 B 不影响先开的 A）")
    hdrs = {"Authorization": f"Bearer {token}", "X-Client-Platform": "desktop"}
    conv = await _new_conversation(client, base, hdrs)
    print(f"  会话 {conv}")

    a = Endpoint("A(桌面·POST)", "desktop", token, base, "probe-desktop")
    a.send(client, conv, SLOW_PROMPT, "steer")
    started = await a.expect("message_start", timeout=60)
    rep.check(started is not None, "A 的回合已开跑")

    # 回合正在跑时第二台设备挂上来——旧口径下这一刻 A 就被挤成 detached 了。
    b = Endpoint("B(手机·follow)", "mobile", token, base, "probe-mobile")
    b.follow(client, conv)

    end_a = await a.expect("message_end", timeout=120)
    end_b = await b.expect("message_end", timeout=120)

    rep.check(end_a is not None, "A（先开的）没被挤掉，收全到 message_end")
    rep.check(end_b is not None, "B（后开的）也收到 message_end")
    # 只有这一条依赖模型真的吐了正文；上游限流时回合以 error 收口，判不了逐帧一致。
    if a.seen("error"):
        rep.skip(
            "两端逐帧拿到同样的正文增量",
            "上游限流（llm.call_failed），本回合无正文——等限流窗过去再跑",
        )
    else:
        n_a, n_b = len(a.seen("content_delta")), len(b.seen("content_delta"))
        rep.check(
            n_a > 0 and n_a == n_b,
            "★ 两端逐帧拿到同样的正文增量（字级同步）",
            f"A content_delta×{n_a} / B×{n_b}",
        )

    await a.close()
    await b.close()
    print(f"    {a.summary()}\n    {b.summary()}")


async def scenario_queue(client: httpx.AsyncClient, base: str, token: str, rep: Report) -> None:
    """验收 5：A 排队 → B 看见；撤单 → B 也看见。P1 信号道的核心。"""
    print("\n场景 3 · 验收 5：短暂态一致（排队 / 撤单送达对端）")
    hdrs = {"Authorization": f"Bearer {token}", "X-Client-Platform": "desktop"}
    conv = await _new_conversation(client, base, hdrs)
    print(f"  会话 {conv}")

    a = Endpoint("A(桌面·占槽)", "desktop", token, base, "probe-desktop")
    a.send(client, conv, SLOW_PROMPT, "steer")
    rep.check(await a.expect("message_start", timeout=60) is not None, "A 的回合占住了槽")

    b = Endpoint("B(手机·follow)", "mobile", token, base, "probe-mobile")
    b.follow(client, conv)
    await asyncio.sleep(1.0)

    # A 在自己占槽时再发一条 → FIFO 排队。此前这帧只到 A 自己的 POST 流。
    a2 = Endpoint("A2(桌面·排队)", "desktop", token, base, "probe-desktop")
    a2.send(client, conv, FAST_PROMPT, "queue")

    q_self = await a2.expect("turn_queued", timeout=30)
    rep.check(q_self is not None, "发起端自己收到 turn_queued")

    q_peer = await b.expect("turn_queued", timeout=30)
    rep.check(
        q_peer is not None,
        "★ 另一端 B 也收到 turn_queued（P1 信号道）",
        f"@{q_peer['t_ms']}ms queue_id={q_peer['payload'].get('queue_id')}"
        if q_peer
        else "B 没收到——信号道没通",
    )

    queue_id = (q_peer or q_self or {}).get("payload", {}).get("queue_id")

    # 权威内容源：REST 快照必须与信号一致（信号只是「变了」）。
    r = await client.get(f"{base}/v1/conversations/{conv}/queued-turns", headers=hdrs)
    items = r.json().get("items", []) if r.status_code == 200 else []
    rep.check(
        any(i.get("queue_id") == queue_id for i in items),
        "GET /queued-turns 权威快照能查到这一项",
        f"HTTP {r.status_code}, {len(items)} 项",
    )

    if queue_id:
        c = await client.post(
            f"{base}/v1/conversations/{conv}/queued-turns/{queue_id}/cancel", headers=hdrs
        )
        rep.check(c.status_code == 200, "撤单 REST 成功", f"HTTP {c.status_code}")

        x_peer = await b.expect("turn_queue_cancelled", timeout=30)
        rep.check(
            x_peer is not None,
            "★ 另一端 B 收到 turn_queue_cancelled（撤单可见）",
            f"@{x_peer['t_ms']}ms" if x_peer else "B 没收到——撤单对端无感",
        )

    await a.close()
    await a2.close()
    await b.close()
    print(f"    {a.summary()}\n    {a2.summary()}\n    {b.summary()}")


async def scenario_stop(client: httpx.AsyncClient, base: str, token: str, rep: Report) -> None:
    """验收 5 后半：任一端 Stop → 两端同时停。"""
    print("\n场景 4 · 验收 5：任一端 Stop，两端同时停")
    hdrs = {"Authorization": f"Bearer {token}", "X-Client-Platform": "desktop"}
    conv = await _new_conversation(client, base, hdrs)
    print(f"  会话 {conv}")

    a = Endpoint("A(桌面·POST)", "desktop", token, base, "probe-desktop")
    a.send(client, conv, SLOW_PROMPT, "steer")
    rep.check(await a.expect("message_start", timeout=60) is not None, "回合已开跑")

    b = Endpoint("B(手机·follow)", "mobile", token, base, "probe-mobile")
    b.follow(client, conv)
    await asyncio.sleep(2.0)

    s = await client.post(f"{base}/v1/conversations/{conv}/stop", headers=hdrs)
    rep.check(s.status_code == 200, "Stop REST 成功", f"HTTP {s.status_code}")

    end_a = await a.expect("message_end", "error", timeout=45)
    end_b = await b.expect("message_end", "error", timeout=45)
    rep.check(end_a is not None, "A 收到收口")
    rep.check(
        end_b is not None,
        "★ B（没按停止的那端）也收到收口",
        "" if end_b else "B 会一直转圈——停止没送到对端",
    )

    await a.close()
    await b.close()
    print(f"    {a.summary()}\n    {b.summary()}")


async def scenario_settled_elsewhere(
    client: httpx.AsyncClient, base: str, token: str, rep: Report
) -> None:
    """验收 2：卡被先到的那端点掉，另一端自动收口（不用刷新）。

    用**开工卡**（`team_preview`）而非热审批卡：纯 HTTP 造不出后者（恒确认工具
    `host_package_install` / `delete_folder` / `git push` 都要桌面履约方在场，磁带又不入
    公开仓），而「一端处理 → 另一端收口」的多端语义两者同构。
    """
    print("\n场景 5 · 验收 2：卡被一端点掉，另一端收口")
    hdrs = {"Authorization": f"Bearer {token}", "X-Client-Platform": "desktop"}
    conv = await _new_conversation(client, base, hdrs)
    print(f"  会话 {conv}")

    b = Endpoint("B(手机·follow)", "mobile", token, base, "probe-mobile")
    b.follow(client, conv)
    await asyncio.sleep(1.0)

    a = Endpoint("A(桌面·POST)", "desktop", token, base, "probe-desktop")
    a.send(client, conv, TEAM_PROMPT, "steer")

    start = await a.expect("message_start", timeout=60)
    if start is None:
        rep.skip("卡在两端同时可见", f"回合没起来（多半是上游限流）：{a.error or '无帧'}")
        await a.close()
        await b.close()
        return
    message_id = str(start["payload"].get("message_id") or start["payload"].get("id") or "")

    card_a = await a.expect("team_preview_required", timeout=240)
    if card_a is None:
        rep.skip(
            "卡在两端同时可见",
            "本回合没弹开工卡（模型没组队 / 限流）——提示词要更硬地要求组队后重跑",
        )
        await a.close()
        await b.close()
        return
    rep.check(True, "发起端 A 看到开工卡")

    card_b = await b.expect("team_preview_required", timeout=30)
    rep.check(
        card_b is not None,
        "★ 另一端 B 同时看到同一张卡",
        f"B 晚 {card_b['t_ms'] - card_a['t_ms']}ms" if card_b else "B 没看到这张卡",
    )
    if not message_id:
        rep.skip("另一端点掉后 A 自动收口", "拿不到 message_id，无法调 resume")
        await a.close()
        await b.close()
        return

    # 由 B（另一端）点掉它 —— 验收 2 的关键就是「点的人不是 A」。
    settler = Endpoint("B(手机·授权)", "mobile", token, base, "probe-mobile")
    settler.resume(client, conv, message_id)

    done_a = await a.expect("team_preview_resolved", timeout=90)
    rep.check(
        done_a is not None,
        "★ A 那张卡自动收口（无需刷新）",
        f"A 收到 team_preview_resolved @{done_a['t_ms']}ms"
        if done_a
        else f"A 的卡一直挂着；B 的授权：status={settler.status} err={settler.error}",
    )

    await a.close()
    await b.close()
    await settler.close()
    print(f"    {a.summary()}\n    {b.summary()}\n    {settler.summary()}")


SCENARIOS = {
    1: scenario_idle_follow,
    2: scenario_no_kick,
    3: scenario_queue,
    4: scenario_stop,
    5: scenario_settled_elsewhere,
}


async def main(args: argparse.Namespace) -> int:
    base = args.base_url.rstrip("/")
    rep = Report()
    async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10.0)) as client:
        try:
            token = await _login(client, base, args.user, args.password)
        except httpx.ConnectError:
            raise SystemExit(f"连不上后端 {base}——先起后端（本地开发 §2）。") from None

        picked = [args.only] if args.only else sorted(SCENARIOS)
        for n in picked:
            fn = SCENARIOS.get(n)
            if fn is None:
                raise SystemExit(f"没有场景 {n}（可选 {sorted(SCENARIOS)}）")
            await fn(client, base, token, rep)

    print("\n" + "─" * 70)
    total = len(rep.rows)
    if rep.failed:
        print(f"结果：{total - rep.failed}/{total} 通过，{rep.failed} 条 FAIL")
        for ok, label, detail in rep.rows:
            if not ok:
                print(f"  FAIL  {label}" + (f" — {detail}" if detail else ""))
    elif total == 0:
        # 一条都没判定就宣布「成立」，比 FAIL 更危险。
        print("结果：本次未判定任何条目（全部 SKIP）——什么都没验到")
    else:
        print(f"结果：{total}/{total} 全通过 — 多端同权在真流上成立")
    for label in rep.skipped:
        print(f"  SKIP  {label}（环境所限未判定，不计入通过）")
    return 1 if rep.failed else 0


def _parse() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="多端同权（B2）真跑验收探针")
    p.add_argument("--base-url", default=DEFAULT_BASE_URL)
    p.add_argument("--user", default=DEFAULT_USERNAME)
    p.add_argument("--password", default=DEFAULT_PASSWORD)
    p.add_argument("--only", type=int, help="只跑某个场景（1–4）")
    p.add_argument("--keep", action="store_true", help="（保留位）失败时不清理会话")
    return p.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(_parse())))
