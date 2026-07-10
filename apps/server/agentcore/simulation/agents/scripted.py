"""Deterministic scripted tick decisions (no LLM).

Opt-in / fallback path for demo & local dev when DeepSeek is unavailable
or ``SIMULATION_SCRIPTED`` / run ``scripted`` is set. Residents follow the
town hourly schedule (role overrides included): move when the schedule
location differs, otherwise stay and perform the slot activity.

Still produces ``AgentTickOutcome`` so the service can emit the same
``sim.agent_action`` / ``sim.agent_state`` SSE events as the LLM path.

Additionally, every ``SCRIPTED_DEMO_INTERVAL`` ticks a lightweight demo
pulse advances a fixed multi-beat story arc (Zhao↔Wang market rivalry,
Liu mediation, town-hall vote) via conversation / trade / vote
interactions and story-aligned preset ``world_event``s — so Unity demos
stay readable without DeepSeek.

God-mode injects (storm / festival / price_surge / announcement) alter
the *next* scripted tick: shelter / gather / market bias, and queued
announcement votes are drained deterministically.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from agentcore.core.types import new_id
from agentcore.simulation.agents.models import SimPersona
from agentcore.simulation.agents.social import adjust_relation, clamp
from agentcore.simulation.agents.tick_runner import AgentTickOutcome
from agentcore.simulation.interaction.models import (
    InteractionRequest,
    InteractionResult,
    InteractionStateChange,
    InteractionTranscriptLine,
)
from agentcore.simulation.scenarios.town.schedule import schedule_hint_for_persona
from agentcore.simulation.types import SimAgentAction
from agentcore.simulation.world.events.models import WorldEvent
from agentcore.simulation.world.events.templates import build_preset_event
from agentcore.simulation.world.state import WorldAgent, WorldState

if TYPE_CHECKING:
    from agentcore.simulation.interaction.bus import InteractionBus

# Demo pulse cadence (ticks). Interaction every N; world_event every 2N.
SCRIPTED_DEMO_INTERVAL = 3
SCRIPTED_WORLD_EVENT_INTERVAL = SCRIPTED_DEMO_INTERVAL * 2

# Offline / scripted story packs (independent of REST ``scenario``; do not change OpenAPI create).
# Unity Offline is the source of truth for multi-pack; backend keeps price_surge default
# and accepts demo_pack for tests / future WorldState wiring.
DEMO_PACK_PRICE_SURGE = "price_surge"
DEMO_PACK_FESTIVAL = "festival"
DEMO_PACK_TOWN_HALL = "town_hall"
DEMO_PACK_IDS = (DEMO_PACK_PRICE_SURGE, DEMO_PACK_FESTIVAL, DEMO_PACK_TOWN_HALL)

# Story-aligned world-event rotation (surge → storm → festival thaw).
_DEMO_PRESETS = ("price_surge", "storm", "festival")
_FESTIVAL_PRESETS = ("festival", "festival", "festival")
_TOWN_HALL_PRESETS = ("announcement", "festival", "festival")

_RIVAL_LEFT = "zhao"
_RIVAL_RIGHT = "wang"
_MEDIATOR = "liu"
_MARKET = "市场"
_SQUARE = "广场"
_TOWN_HALL = "镇政厅"
_HOME = "住宅区"
_SHELTER_REGIONS = frozenset({_HOME, _TOWN_HALL, "面包店", "餐厅", "图书馆", "工坊"})
_PUBLIC_GATHER = (_SQUARE, _MARKET, "公园", "图书馆", "工坊", "码头")

Speaker = Literal["initiator", "target", "mediator"]


@dataclass(frozen=True)
class _TradeSpec:
    item: str
    qty: int
    base_price: float


@dataclass(frozen=True)
class _StoryBeat:
    """One demo-pulse beat in the Zhao↔Wang rivalry arc."""

    kind: Literal["conversation", "trade", "vote"]
    lines: tuple[tuple[Speaker, str], ...]
    mood_initiator: float
    mood_target: float
    relation: float
    summary_template: str
    trade: _TradeSpec | None = None
    world_event_blurb: str | None = None
    vote_motion: str | None = None
    include_mediator: bool = False
    # Optional gather region so Unity overlays are visible in 图书馆 / 工坊 / 码头.
    location: str | None = None


# Multi-tick arc (9 beats, % N cycle):
# probe → surge trade → quarrel → storm deal → Liu mediation →
# town-hall vote → aftermath → festival thaw → consolidate.
# Odd pulse_index → conversation; even → trade/vote (cadence tests keep alt rhythm).
#
# Offline JSON SoT: apps/town/Assets/StreamingAssets/Fixtures/demo-story-packs.json
# (Unity OfflineDemoBuilder reads it this iteration). Python keeps embedded beats;
# align to JSON next iteration — do not dual-edit copy casually.
_STORY_BEATS: tuple[_StoryBeat, ...] = (
    _StoryBeat(
        kind="conversation",
        lines=(
            (
                "initiator",
                "王婶，听说你今早进的青菜比我便宜两成？这价是从哪来的？",
            ),
            (
                "target",
                "赵老板少打听！我的老主顾等着要货，你管得着吗？",
            ),
            (
                "initiator",
                "市场就这么大，别怪我回头压价——咱们走着瞧。",
            ),
        ),
        mood_initiator=-0.06,
        mood_target=0.04,
        relation=-0.08,
        summary_template=(
            "tick{tick} {a}在市场旁敲打{b}的进货价，两人火药味渐浓（涨价风波·试探）"
        ),
    ),
    _StoryBeat(
        kind="trade",
        lines=(
            (
                "initiator",
                "进货渠道都紧了，这批日用品我按市价收——你别跟我扯旧账。",
            ),
            (
                "target",
                "市价？你分明趁乱加码！……行，先成交，账以后再算。",
            ),
            (
                "initiator",
                "成交。涨价风一来，谁先囤谁活——你懂的。",
            ),
        ),
        mood_initiator=0.02,
        mood_target=-0.1,
        relation=-0.05,
        summary_template=(
            "tick{tick} 涨价风中成交：{a}←{b} {item}×{qty} @{price:.0f}币（涨价风波·趁乱）"
        ),
        trade=_TradeSpec(item="日用品", qty=1, base_price=12.0),
        world_event_blurb=(
            "赵老板与王婶的进货渠道同时告急，日用品与青菜价格飙升，市场人心浮动。"
        ),
    ),
    _StoryBeat(
        kind="conversation",
        lines=(
            (
                "target",
                "赵老板！你昨儿那笔日用品明明吃了涨价的红利，还到处说是我哄抬？",
            ),
            (
                "initiator",
                "我只是跟行情走。你自己进货不稳，别往我身上泼脏水。",
            ),
            (
                "target",
                "行情？我看是你故意放风！再这样我连你摊位都不让过。",
            ),
            (
                "initiator",
                "随你。反正镇民认的是货，不是嗓门。",
            ),
        ),
        mood_initiator=-0.08,
        mood_target=-0.12,
        relation=-0.14,
        summary_template=(
            "tick{tick} {a}与{b}为涨价风波当街对质，关系明显恶化（涨价风波·爆发）"
        ),
        location="图书馆",
    ),
    _StoryBeat(
        kind="trade",
        lines=(
            (
                "initiator",
                "暴风雨要来了，我缺防水布——你那儿还有存货吗？按现价，少废话。",
            ),
            (
                "target",
                "……有。暴风雨里谁都别想赚痛快钱，拿去，别再扯进货的事。",
            ),
            (
                "initiator",
                "成交。雨停了咱们再算旧账。",
            ),
        ),
        mood_initiator=-0.04,
        mood_target=-0.04,
        relation=-0.02,
        summary_template=(
            "tick{tick} 暴风雨前勉强成交：{a}←{b} {item}×{qty} @{price:.0f}币"
            "（涨价风波·避险）"
        ),
        trade=_TradeSpec(item="防水布", qty=1, base_price=18.0),
        world_event_blurb=(
            "乌云压镇，狂风暴雨将至；市场早早收摊，居民赶着囤避险物资。"
        ),
        location="码头",
    ),
    _StoryBeat(
        kind="conversation",
        lines=(
            (
                "mediator",
                "赵老板、王婶，再当街吵我就记警告。涨价的事，去镇政厅说清楚。",
            ),
            (
                "initiator",
                "……听见了，刘警官。我不是要闹事，是进货真紧。",
            ),
            (
                "target",
                "那行，各卖各的。涨价的事，等雨停了再跟镇政厅说清楚。",
            ),
            (
                "mediator",
                "好。今晚镇政厅有议题，你们都到场——用投票，别用嗓门。",
            ),
        ),
        mood_initiator=0.06,
        mood_target=0.08,
        relation=0.1,
        summary_template=(
            "tick{tick} 刘警官介入调解，{a}与{b}收声并约定去镇政厅表决"
            "（涨价风波·调解）"
        ),
        include_mediator=True,
    ),
    _StoryBeat(
        kind="vote",
        lines=(
            (
                "mediator",
                "议题宣读：是否临时限价并延长夜市，缓解涨价纠纷。请表决。",
            ),
            (
                "initiator",
                "支持限价——乱涨只会把市场吵散。",
            ),
            (
                "target",
                "……也支持。限价比互相泼脏水强。",
            ),
        ),
        mood_initiator=0.04,
        mood_target=0.04,
        relation=0.06,
        summary_template=(
            "tick{tick} 镇政厅投票「{motion}」→ {outcome} "
            "(支持{yes}/反对{no}/弃权{abstain})（涨价风波·表决）"
        ),
        vote_motion="是否临时限价并延长夜市开放时间？",
        include_mediator=True,
    ),
    _StoryBeat(
        kind="conversation",
        lines=(
            (
                "mediator",
                "表决结果已经记档。赵老板、王婶，回去各守各的摊，别再当街对骂。",
            ),
            (
                "initiator",
                "知道了。限价我认——至少规矩清楚。",
            ),
            (
                "target",
                "我也认。刘警官，下次有事我们直接去镇政厅。",
            ),
        ),
        mood_initiator=0.05,
        mood_target=0.06,
        relation=0.08,
        summary_template=(
            "tick{tick} 表决后刘警官收场，{a}与{b}关系继续回暖（涨价风波·收场）"
        ),
        include_mediator=True,
    ),
    _StoryBeat(
        kind="trade",
        lines=(
            (
                "initiator",
                "广场在办庆典，我缺点装饰用的彩带——按平价跟你换，算和解？",
            ),
            (
                "target",
                "……看在节日份上。平价就平价，别再提那阵涨价风。",
            ),
            (
                "initiator",
                "成交。今天镇上热闹，咱们也别扫兴。",
            ),
        ),
        mood_initiator=0.12,
        mood_target=0.14,
        relation=0.16,
        summary_template=(
            "tick{tick} 节日和解成交：{a}←{b} {item}×{qty} @{price:.0f}币"
            "（涨价风波·和解）"
        ),
        trade=_TradeSpec(item="彩带", qty=2, base_price=8.0),
        world_event_blurb=(
            "广场张灯结彩，节日庆典拉开帷幕；市场恩怨暂搁一边，镇上气氛回暖。"
        ),
    ),
    _StoryBeat(
        kind="conversation",
        lines=(
            (
                "target",
                "赵老板，夜市限价后客流回来了——你那摊日用品也别再藏着掖着。",
            ),
            (
                "initiator",
                "行，货我正常出。王婶，青菜也别再卡我老主顾。",
            ),
            (
                "mediator",
                "这样就对了。有纠纷还是走镇政厅，别再让我跑第二趟。",
            ),
            (
                "initiator",
                "听见了。今天市场太平，比吵架强。",
            ),
        ),
        mood_initiator=0.08,
        mood_target=0.1,
        relation=0.12,
        summary_template=(
            "tick{tick} {a}与{b}在刘警官见证下巩固和解（涨价风波·巩固）"
        ),
        include_mediator=True,
    ),
)

# Festival pack (6 beats) — gather / decorate / celebrate. Keep copy aligned with
# apps/town OfflineDemoBuilder FestivalStoryBeats (dual-source this iteration).
_FESTIVAL_STORY_BEATS: tuple[_StoryBeat, ...] = (
    _StoryBeat(
        kind="conversation",
        lines=(
            ("initiator", "王婶，广场今晚张灯——你摊上那批彩带借我用用？"),
            ("target", "节日嘛，谁不乐意热闹。彩带你拿去，记得还。"),
            ("initiator", "成。咱们市场的人也该去广场露个脸。"),
        ),
        mood_initiator=0.06,
        mood_target=0.06,
        relation=0.06,
        summary_template=("tick{tick} {a}邀{b}去广场张灯（节日庆典·邀约）"),
    ),
    _StoryBeat(
        kind="trade",
        lines=(
            ("initiator", "庆典要摆摊，我缺两卷彩带——平价跟你换。"),
            ("target", "平价就平价，看在节日份上。拿去吧。"),
            ("initiator", "成交。广场见。"),
        ),
        mood_initiator=0.08,
        mood_target=0.08,
        relation=0.08,
        summary_template=(
            "tick{tick} 节日备货：{a}←{b} {item}×{qty} @{price:.0f}币（节日庆典·备货）"
        ),
        trade=_TradeSpec(item="彩带", qty=2, base_price=8.0),
        world_event_blurb=(
            "广场张灯结彩，节日庆典拉开帷幕；镇民往广场聚集，气氛回暖。"
        ),
    ),
    _StoryBeat(
        kind="conversation",
        lines=(
            ("mediator", "各位，广场灯已点上。今晚别吵进货，先把庆典办好。"),
            ("initiator", "听见了，刘警官。我把摊挪近广场。"),
            ("target", "我也去。节日里吵价多没劲。"),
        ),
        mood_initiator=0.1,
        mood_target=0.1,
        relation=0.1,
        summary_template=("tick{tick} 镇民往广场聚集（节日庆典·聚集）"),
        include_mediator=True,
    ),
    _StoryBeat(
        kind="trade",
        lines=(
            ("target", "赵老板，我缺几串灯笼——你那儿还有吗？"),
            ("initiator", "有。节日价，不坑你。"),
            ("target", "成交。今晚广场见。"),
        ),
        mood_initiator=0.1,
        mood_target=0.12,
        relation=0.1,
        summary_template=(
            "tick{tick} 节日互惠：{a}←{b} {item}×{qty} @{price:.0f}币（节日庆典·互惠）"
        ),
        trade=_TradeSpec(item="灯笼", qty=3, base_price=6.0),
        location="工坊",
    ),
    _StoryBeat(
        kind="conversation",
        lines=(
            ("initiator", "王婶，彩带挂上了——今晚广场真热闹。"),
            ("target", "是啊。涨价那阵子的气，今天先放下。"),
            ("mediator", "这就对了。节日里和解，比任何公告都管用。"),
            ("initiator", "干杯——为小镇。"),
        ),
        mood_initiator=0.14,
        mood_target=0.14,
        relation=0.12,
        summary_template=("tick{tick} 广场干杯和解（节日庆典·干杯）"),
        world_event_blurb=("广场庆典进入高潮，灯火与笑语交织；市场恩怨暂搁一边。"),
        include_mediator=True,
    ),
    _StoryBeat(
        kind="conversation",
        lines=(
            ("target", "灯还亮着。赵老板，明天市场照常——别再藏货。"),
            ("initiator", "行。节日过了也别把气氛弄僵。"),
            ("mediator", "散场吧。有事还是走镇政厅。"),
        ),
        mood_initiator=0.1,
        mood_target=0.1,
        relation=0.08,
        summary_template=("tick{tick} 庆典余韵，关系巩固（节日庆典·余韵）"),
        include_mediator=True,
    ),
)

# Town-hall pack (6 beats) — notice → lobby → debate → vote → announce → settle.
_TOWN_HALL_STORY_BEATS: tuple[_StoryBeat, ...] = (
    _StoryBeat(
        kind="conversation",
        lines=(
            ("mediator", "镇政厅贴了告示：下周是否举办镇民大会，今晚表决。"),
            ("initiator", "终于要开会了？涨价那阵子就该开。"),
            ("target", "开就开。别又变成吵架场。"),
        ),
        mood_initiator=-0.02,
        mood_target=-0.02,
        relation=-0.04,
        summary_template=("tick{tick} 镇政厅公告即将表决（镇政厅·公告）"),
        world_event_blurb=(
            "镇政厅张贴公告：今晚就「是否举办镇民大会」进行表决，请镇民到场。"
        ),
        include_mediator=True,
    ),
    _StoryBeat(
        kind="conversation",
        lines=(
            ("initiator", "王婶，你投赞成吧——大会能把限价规矩说清楚。"),
            ("target", "我还在想。开会是好事，别变成你单方面压我。"),
            ("initiator", "规矩对大家都好。晚上镇政厅见。"),
        ),
        mood_initiator=0.0,
        mood_target=-0.04,
        relation=-0.04,
        summary_template=("tick{tick} {a}游说{b}支持开会（镇政厅·游说）"),
        location="图书馆",
    ),
    _StoryBeat(
        kind="conversation",
        lines=(
            ("mediator", "议题宣读前，双方各说一句。赵老板？"),
            ("initiator", "赞成开会——市场纠纷需要公开规则。"),
            ("target", "我也赞成，但要保证菜贩有发言席。"),
            ("mediator", "记下了。请入座，准备表决。"),
        ),
        mood_initiator=0.04,
        mood_target=0.04,
        relation=0.06,
        summary_template=("tick{tick} 镇政厅辩论后准备表决（镇政厅·辩论）"),
        include_mediator=True,
    ),
    _StoryBeat(
        kind="vote",
        lines=(
            ("mediator", "议题：是否下周举办镇民大会。请表决。"),
            ("initiator", "支持——把规矩摆到台面上。"),
            ("target", "支持。有席位我就投。"),
        ),
        mood_initiator=0.06,
        mood_target=0.06,
        relation=0.1,
        summary_template=(
            "tick{tick} 镇政厅投票「{motion}」→ {outcome} "
            "(支持{yes}/反对{no}/弃权{abstain})（镇政厅·表决）"
        ),
        vote_motion="是否下周举办镇民大会？",
        world_event_blurb=(
            "镇政厅表决通过：下周举办镇民大会；广场将张灯迎接公开议事。"
        ),
        include_mediator=True,
    ),
    _StoryBeat(
        kind="conversation",
        lines=(
            ("mediator", "表决结果：通过。下周镇民大会正式排期。"),
            ("initiator", "好。到时候限价、夜市都摊开说。"),
            ("target", "行。刘警官，菜贩席位别忘了。"),
        ),
        mood_initiator=0.08,
        mood_target=0.08,
        relation=0.08,
        summary_template=("tick{tick} 表决结果宣读（镇政厅·宣读）"),
        include_mediator=True,
    ),
    _StoryBeat(
        kind="trade",
        lines=(
            ("initiator", "大会定了，我缺份告示纸——跟你换点？"),
            ("target", "换。把「菜贩发言席」也写上。"),
            ("initiator", "成交。下周镇政厅见。"),
        ),
        mood_initiator=0.08,
        mood_target=0.1,
        relation=0.1,
        summary_template=(
            "tick{tick} 落定成交：{a}←{b} {item}×{qty} @{price:.0f}币（镇政厅·落定）"
        ),
        trade=_TradeSpec(item="告示纸", qty=1, base_price=4.0),
    ),
)


def normalize_demo_pack(pack: str | None) -> str:
    """Normalize pack id; unknown → price_surge (default 涨价风波)."""
    if not pack:
        return DEMO_PACK_PRICE_SURGE
    key = pack.strip().lower()
    if key in DEMO_PACK_IDS:
        return key
    return DEMO_PACK_PRICE_SURGE


def _beats_for_pack(pack: str) -> tuple[_StoryBeat, ...]:
    resolved = normalize_demo_pack(pack)
    if resolved == DEMO_PACK_FESTIVAL:
        return _FESTIVAL_STORY_BEATS
    if resolved == DEMO_PACK_TOWN_HALL:
        return _TOWN_HALL_STORY_BEATS
    return _STORY_BEATS


def _presets_for_pack(pack: str) -> tuple[str, ...]:
    resolved = normalize_demo_pack(pack)
    if resolved == DEMO_PACK_FESTIVAL:
        return _FESTIVAL_PRESETS
    if resolved == DEMO_PACK_TOWN_HALL:
        return _TOWN_HALL_PRESETS
    return _DEMO_PRESETS


async def run_scripted_agent_tick(
    *,
    world: WorldState,
    persona: SimPersona,
) -> AgentTickOutcome:
    """Advance one resident by schedule + active world modifiers (deterministic)."""
    t0 = time.monotonic()
    agent = world.agents[persona.agent_id]
    override = _modifier_destination(world, persona, agent)
    if override is not None:
        dest, activity, reason = override
        return await _emit_move_or_stay(
            world=world,
            persona=persona,
            agent=agent,
            dest=dest,
            activity=activity,
            reason=reason,
            t0=t0,
        )

    slot = schedule_hint_for_persona(persona, world.hour)
    return await _emit_move_or_stay(
        world=world,
        persona=persona,
        agent=agent,
        dest=slot.location,
        activity=slot.activity,
        reason="scripted_schedule",
        t0=t0,
    )


async def _emit_move_or_stay(
    *,
    world: WorldState,
    persona: SimPersona,
    agent: WorldAgent,
    dest: str,
    activity: str,
    reason: str,
    t0: float,
) -> AgentTickOutcome:
    moved = agent.location != dest
    if moved:
        old = agent.location
        await world.set_location(persona.agent_id, dest)
        await world.update_agent_activity(persona.agent_id, f"前往{dest}")
        thought = _thought_for_reason(reason, old=old, dest=dest, activity=activity)
        detail = f"scripted move_to {dest} ({reason})"
        action = SimAgentAction(
            agent_id=persona.agent_id,
            action="move_to",
            thought=thought,
            tool_name="move_to",
            tool_args={"destination": dest, "reason": reason},
            success=True,
            detail=detail,
        )
        await world.record(
            f"tick{world.tick} {agent.name} 按脚本从{old}走到{dest}（{activity}·{reason}）"
        )
    else:
        await world.update_agent_activity(persona.agent_id, activity)
        thought = _thought_for_reason(reason, old=dest, dest=dest, activity=activity)
        detail = f"scripted stay_here {activity} ({reason})"
        action = SimAgentAction(
            agent_id=persona.agent_id,
            action="stay_here",
            thought=thought,
            tool_name="stay_here",
            tool_args={"activity": activity, "reason": reason},
            success=True,
            detail=detail,
        )
        await world.record(
            f"tick{world.tick} {agent.name} 按脚本在{dest}{activity}（{reason}）"
        )

    async with world.mutation_lock():
        world.agents[persona.agent_id].last_thought = thought

    return AgentTickOutcome(
        action=action,
        rounds=0,
        latency_ms=int((time.monotonic() - t0) * 1000),
        usage={},
        cost_usd=0.0,
    )


def _thought_for_reason(
    reason: str, *, old: str, dest: str, activity: str
) -> str:
    if reason == "storm_shelter":
        if old != dest:
            return f"暴风雨来了，从{old}赶往{dest}避险。"
        return f"暴风雨中留在{dest}避险，暂缓户外活动。"
    if reason == "festival_gather":
        if old != dest:
            return f"节日气氛浓，从{old}前往{dest}与镇民同乐。"
        return f"留在{dest}参与节日聚集。"
    if reason == "price_surge_market":
        if old != dest:
            return f"物价上涨，赶往{dest}看行情、谈进货。"
        return f"涨价风中留在{dest}盯盘口与交易。"
    if reason == "announcement_vote":
        if old != dest:
            return f"镇政厅有公告议题，从{old}前往{dest}参加表决。"
        return f"留在{dest}等待投票议题。"
    if old != dest:
        return f"按日程从{old}前往{dest}，准备{activity}。"
    return f"按日程留在{dest}，继续{activity}。"


def _modifier_destination(
    world: WorldState,
    persona: SimPersona,
    agent: WorldAgent,
) -> tuple[str, str, str] | None:
    """Return (dest, activity, reason) when world modifiers override schedule."""
    mods = world.modifiers
    if _has_pending_vote(world):
        return _TOWN_HALL, "参加镇政厅表决", "announcement_vote"
    if mods.storm_active:
        dest = _shelter_destination(persona, agent)
        return dest, "因风暴避险", "storm_shelter"
    if mods.festival_active:
        dest = _gather_destination(persona, agent)
        return dest, "节日聚集", "festival_gather"
    if mods.market_price_multiplier > 1.05 and _is_market_role(persona, agent):
        return _MARKET, "关注涨价行情", "price_surge_market"
    return None


def _has_pending_vote(world: WorldState) -> bool:
    bus = getattr(world, "interaction_bus", None)
    if bus is None:
        return False
    has_kind = getattr(bus, "has_pending_kind", None)
    if callable(has_kind):
        return bool(has_kind("vote"))
    return False


def _shelter_destination(persona: SimPersona, agent: WorldAgent) -> str:
    if agent.location in _SHELTER_REGIONS:
        return agent.location
    home = (persona.location or "").strip()
    if home in _SHELTER_REGIONS:
        return home
    if agent.role in ("镇长秘书", "镇派出所民警"):
        return _TOWN_HALL
    return _HOME


def _gather_destination(persona: SimPersona, agent: WorldAgent) -> str:
    if agent.location in _PUBLIC_GATHER:
        return agent.location
    # Stagger slightly by agent id so not everyone stacks on one cell.
    idx = sum(ord(c) for c in persona.agent_id) % len(_PUBLIC_GATHER)
    return _PUBLIC_GATHER[idx]


def _is_market_role(persona: SimPersona, agent: WorldAgent) -> bool:
    if persona.agent_id in (_RIVAL_LEFT, _RIVAL_RIGHT):
        return True
    blob = f"{agent.role}{persona.goal}"
    return any(token in blob for token in ("商", "贩", "市场", "进货", "卖"))


async def run_scripted_ticks(
    *,
    world: WorldState,
    personas: list[SimPersona],
) -> list[AgentTickOutcome]:
    """Run scripted decisions for every persona (activation already applied)."""
    outcomes: list[AgentTickOutcome] = []
    for persona in personas:
        if persona.agent_id not in world.agents:
            continue
        outcomes.append(await run_scripted_agent_tick(world=world, persona=persona))
    return outcomes


async def run_scripted_demo_pulse(
    world: WorldState,
    *,
    demo_pack: str | None = None,
) -> tuple[list[InteractionResult], list[WorldEvent]]:
    """Emit the next beat of the scripted rivalry arc for Unity demos.

    Called only on the scripted path. Every ``SCRIPTED_DEMO_INTERVAL`` ticks
    produces one conversation / trade / vote; every
    ``SCRIPTED_WORLD_EVENT_INTERVAL`` ticks also injects a story-aligned
    preset world event.

    ``demo_pack`` selects the story arc (``price_surge`` | ``festival`` |
    ``town_hall``). Prefer ``world.demo_pack`` when unset. Not part of REST
    create schema — Offline Unity is the multi-pack source of truth; backend
    default remains ``price_surge``.
    """
    tick = world.tick
    if tick <= 0 or tick % SCRIPTED_DEMO_INTERVAL != 0:
        return [], []

    pack = normalize_demo_pack(
        demo_pack if demo_pack is not None else getattr(world, "demo_pack", None)
    )
    beats = _beats_for_pack(pack)
    presets = _presets_for_pack(pack)

    interactions: list[InteractionResult] = []
    world_events: list[WorldEvent] = []

    pulse_index = tick // SCRIPTED_DEMO_INTERVAL
    beat = beats[(pulse_index - 1) % len(beats)]
    pair = _pick_demo_pair(world)
    if pair is not None:
        left, right = pair
        result = await _play_story_beat(world, left, right, beat)
        interactions.append(result)

    if tick % SCRIPTED_WORLD_EVENT_INTERVAL == 0:
        preset = presets[(tick // SCRIPTED_WORLD_EVENT_INTERVAL - 1) % len(presets)]
        event = build_preset_event(preset, tick=tick)
        event.source = "scripted_demo"
        # Only attach story blurbs when the beat's causal blurb matches this preset
        # (avoids festival copy on a recycled price_surge after the 9-beat arc wraps).
        if beat.world_event_blurb and _blurb_matches_preset(beat.world_event_blurb, preset):
            event.description = beat.world_event_blurb
        world_events.append(event)

    return interactions, world_events


async def drain_scripted_pending(
    world: WorldState,
    interaction_bus: InteractionBus,
) -> list[InteractionResult]:
    """Deterministically complete queued interactions (esp. announcement votes).

    Scripted path never calls ``InteractionBus.process_tick`` (LLM protocols).
    Announcement injects enqueue votes on the bus — drain them here so they
    are not dropped.
    """
    pending: list[InteractionRequest] = interaction_bus.take_pending()
    if not pending:
        return []

    results: list[InteractionResult] = []
    for request in pending:
        if request.kind == "vote":
            motion = str(request.params.get("motion", "")).strip() or (
                "是否同意下周举办镇民大会？"
            )
            results.append(
                await _run_scripted_vote(
                    world,
                    initiator_id=request.initiator_id,
                    motion=motion,
                    detail="scripted_announcement_vote",
                    arc_label=None,
                )
            )
        else:
            results.append(
                InteractionResult(
                    request_id=request.request_id,
                    kind=request.kind,
                    status="cancelled",
                    initiator_id=request.initiator_id,
                    target_id=request.target_id,
                    summary=f"scripted 路径跳过非投票排队交互：{request.kind}",
                    detail="scripted_skip",
                )
            )
    return results


def _blurb_matches_preset(blurb: str, preset: str) -> bool:
    if preset == "price_surge":
        return any(token in blurb for token in ("价格", "涨价", "物价"))
    if preset == "storm":
        return any(token in blurb for token in ("暴风", "雨", "避险"))
    if preset == "festival":
        return any(token in blurb for token in ("节日", "庆典", "广场张灯"))
    if preset == "announcement":
        return any(token in blurb for token in ("公告", "镇政厅", "表决", "镇民大会"))
    return False


def _pick_demo_pair(world: WorldState) -> tuple[WorldAgent, WorldAgent] | None:
    """Prefer the seeded rivals (Zhao/Wang); else colocated pair; else any two."""
    left = world.agents.get(_RIVAL_LEFT)
    right = world.agents.get(_RIVAL_RIGHT)
    if left is not None and right is not None:
        return left, right

    agents = list(world.agents.values())
    if len(agents) < 2:
        return None
    by_loc: dict[str, list[WorldAgent]] = {}
    for agent in agents:
        by_loc.setdefault(agent.location, []).append(agent)
    for group in by_loc.values():
        if len(group) >= 2:
            return group[0], group[1]
    return agents[0], agents[1]


async def _play_story_beat(
    world: WorldState,
    initiator: WorldAgent,
    target: WorldAgent,
    beat: _StoryBeat,
) -> InteractionResult:
    if beat.kind == "trade":
        return await _scripted_story_trade(world, initiator, target, beat)
    if beat.kind == "vote":
        motion = beat.vote_motion or "是否临时限价并延长夜市开放时间？"
        # Prefer beat.summary_template (pack-specific); arc_label only for non-beat votes.
        return await _run_scripted_vote(
            world,
            initiator_id=_vote_initiator_id(world),
            motion=motion,
            detail="scripted_demo",
            arc_label=None,
            beat=beat,
            rivals=(initiator, target),
        )
    return await _scripted_story_conversation(world, initiator, target, beat)


def _vote_initiator_id(world: WorldState) -> str:
    for agent in world.agents.values():
        if agent.role == "镇长秘书":
            return agent.agent_id
    mediator = world.agents.get(_MEDIATOR)
    if mediator is not None:
        return mediator.agent_id
    return next(iter(world.agents))


def _build_transcript(
    initiator: WorldAgent,
    target: WorldAgent,
    lines: tuple[tuple[Speaker, str], ...],
    *,
    mediator: WorldAgent | None = None,
) -> list[InteractionTranscriptLine]:
    transcript: list[InteractionTranscriptLine] = []
    for round_i, (speaker, text) in enumerate(lines):
        if speaker == "mediator" and mediator is not None:
            agent = mediator
        elif speaker == "target":
            agent = target
        else:
            agent = initiator
        transcript.append(
            InteractionTranscriptLine(
                speaker_id=agent.agent_id,
                speaker_name=agent.name,
                text=text,
                round=round_i,
            )
        )
    return transcript


async def _ensure_colocated(
    world: WorldState,
    initiator: WorldAgent,
    target: WorldAgent,
    *,
    location: str | None = None,
) -> tuple[WorldAgent, WorldAgent]:
    dest = location or initiator.location
    if initiator.location != dest:
        await world.set_location(initiator.agent_id, dest)
        initiator = world.agents[initiator.agent_id]
    if target.location != dest:
        await world.set_location(target.agent_id, dest)
        target = world.agents[target.agent_id]
    return initiator, target


async def _scripted_story_conversation(
    world: WorldState,
    initiator: WorldAgent,
    target: WorldAgent,
    beat: _StoryBeat,
) -> InteractionResult:
    location = beat.location or _MARKET
    initiator, target = await _ensure_colocated(
        world, initiator, target, location=location
    )
    mediator: WorldAgent | None = None
    if beat.include_mediator:
        mediator = world.agents.get(_MEDIATOR)
        if mediator is not None and mediator.location != location:
            await world.set_location(mediator.agent_id, location)
            mediator = world.agents[mediator.agent_id]

    transcript = _build_transcript(
        initiator, target, beat.lines, mediator=mediator
    )
    mood_i, mood_t, rel = beat.mood_initiator, beat.mood_target, beat.relation

    async with world.mutation_lock():
        initiator.mood = clamp(initiator.mood + mood_i, -1.0, 1.0)
        target.mood = clamp(target.mood + mood_t, -1.0, 1.0)
        adjust_relation(initiator, target.agent_id, rel)
        adjust_relation(target, initiator.agent_id, rel)
        if mediator is not None:
            mediator.mood = clamp(mediator.mood + 0.03, -1.0, 1.0)
        summary = beat.summary_template.format(
            tick=world.tick, a=initiator.name, b=target.name
        )
        world.event_log.append(summary)

    return InteractionResult(
        request_id=new_id(),
        kind="conversation",
        status="completed",
        initiator_id=initiator.agent_id,
        target_id=target.agent_id,
        summary=summary,
        transcript=transcript,
        state_changes=InteractionStateChange(
            mood_deltas={
                initiator.agent_id: mood_i,
                target.agent_id: mood_t,
            },
            relation_deltas=[
                (initiator.agent_id, target.agent_id, rel),
                (target.agent_id, initiator.agent_id, rel),
            ],
        ),
        detail="scripted_demo",
    )


async def _scripted_story_trade(
    world: WorldState,
    initiator: WorldAgent,
    target: WorldAgent,
    beat: _StoryBeat,
) -> InteractionResult:
    initiator, target = await _ensure_colocated(
        world, initiator, target, location=beat.location or _MARKET
    )
    spec = beat.trade or _TradeSpec(item="日用品", qty=1, base_price=10.0)
    item, qty = spec.item, spec.qty
    price = spec.base_price
    multiplier = getattr(world.modifiers, "market_price_multiplier", 1.0)
    if multiplier > 1.0:
        price = round(price * multiplier, 1)

    buyer, seller = initiator, target
    if seller.inventory.get(item, 0) < qty:
        seller.inventory[item] = seller.inventory.get(item, 0) + qty
    if buyer.money < price:
        buyer.money = price

    transcript = _build_transcript(initiator, target, beat.lines)
    mood_i, mood_t, rel = beat.mood_initiator, beat.mood_target, beat.relation

    async with world.mutation_lock():
        seller.inventory[item] = seller.inventory.get(item, 0) - qty
        if seller.inventory[item] <= 0:
            seller.inventory.pop(item, None)
        buyer.inventory[item] = buyer.inventory.get(item, 0) + qty
        seller.money += price
        buyer.money -= price
        buyer.mood = clamp(buyer.mood + mood_i, -1.0, 1.0)
        seller.mood = clamp(seller.mood + mood_t, -1.0, 1.0)
        adjust_relation(buyer, seller.agent_id, rel)
        adjust_relation(seller, buyer.agent_id, rel)
        summary = beat.summary_template.format(
            tick=world.tick,
            a=buyer.name,
            b=seller.name,
            item=item,
            qty=qty,
            price=price,
        )
        if multiplier > 1.0 and "涨价" not in summary:
            summary = f"{summary}（市价×{multiplier:.1f}）"
        world.event_log.append(summary)

    return InteractionResult(
        request_id=new_id(),
        kind="trade",
        status="completed",
        initiator_id=initiator.agent_id,
        target_id=target.agent_id,
        summary=summary,
        transcript=transcript,
        state_changes=InteractionStateChange(
            mood_deltas={
                buyer.agent_id: mood_i,
                seller.agent_id: mood_t,
            },
            relation_deltas=[
                (buyer.agent_id, seller.agent_id, rel),
                (seller.agent_id, buyer.agent_id, rel),
            ],
            money_transfers=[
                {"from": buyer.agent_id, "to": seller.agent_id, "amount": price}
            ],
            inventory_transfers=[
                {
                    "from": seller.agent_id,
                    "to": buyer.agent_id,
                    "item": item,
                    "quantity": qty,
                }
            ],
        ),
        detail="scripted_demo",
    )


async def _run_scripted_vote(
    world: WorldState,
    *,
    initiator_id: str,
    motion: str,
    detail: str,
    arc_label: str | None,
    beat: _StoryBeat | None = None,
    rivals: tuple[WorldAgent, WorldAgent] | None = None,
) -> InteractionResult:
    """Deterministic town-hall vote (no LLM) for scripted / announcement paths."""
    initiator = world.agents.get(initiator_id)
    if initiator is None:
        initiator = next(iter(world.agents.values()))
        initiator_id = initiator.agent_id

    # Gather a quorum at town hall.
    gather_ids = {initiator_id, _RIVAL_LEFT, _RIVAL_RIGHT, _MEDIATOR}
    for agent_id in list(gather_ids):
        if agent_id in world.agents and world.agents[agent_id].location != _TOWN_HALL:
            await world.set_location(agent_id, _TOWN_HALL)
    # Ensure at least two agents present.
    present = [a for a in world.agents.values() if a.location == _TOWN_HALL]
    if len(present) < 2:
        for agent in world.agents.values():
            if agent.location != _TOWN_HALL:
                await world.set_location(agent.agent_id, _TOWN_HALL)
            present = [a for a in world.agents.values() if a.location == _TOWN_HALL]
            if len(present) >= 2:
                break

    initiator = world.agents[initiator_id]
    voters = [a for a in world.agents.values() if a.location == _TOWN_HALL]

    transcript: list[InteractionTranscriptLine] = []
    if beat is not None and rivals is not None:
        left, right = rivals
        mediator = world.agents.get(_MEDIATOR)
        transcript = _build_transcript(
            left, right, beat.lines, mediator=mediator
        )

    yes_votes = 0
    no_votes = 0
    abstain_votes = 0
    for voter in voters:
        choice, reason = _scripted_vote_choice(voter, motion)
        if choice == "yes":
            yes_votes += 1
        elif choice == "no":
            no_votes += 1
        else:
            abstain_votes += 1
        label = {"yes": "支持", "no": "反对", "abstain": "弃权"}[choice]
        # Avoid duplicating story lines already in transcript.
        if beat is None:
            transcript.append(
                InteractionTranscriptLine(
                    speaker_id=voter.agent_id,
                    speaker_name=voter.name,
                    text=f"{label}：{reason}",
                    round=len(transcript),
                )
            )

    if yes_votes > no_votes:
        outcome = "通过"
    elif no_votes > yes_votes:
        outcome = "否决"
    else:
        outcome = "平局"

    if beat is not None:
        summary = beat.summary_template.format(
            tick=world.tick,
            motion=motion,
            outcome=outcome,
            yes=yes_votes,
            no=no_votes,
            abstain=abstain_votes,
        )
    else:
        label_suffix = f"（{arc_label}）" if arc_label else ""
        summary = (
            f"tick{world.tick} 投票「{motion}」→ {outcome} "
            f"(支持{yes_votes}/反对{no_votes}/弃权{abstain_votes}){label_suffix}"
        )

    mood_i = beat.mood_initiator if beat is not None else 0.03
    mood_t = beat.mood_target if beat is not None else 0.03
    rel = beat.relation if beat is not None else 0.0

    async with world.mutation_lock():
        world.governance.last_motion = motion
        world.governance.last_outcome = outcome
        world.governance.yes_votes = yes_votes
        world.governance.no_votes = no_votes
        world.governance.abstain_votes = abstain_votes
        if outcome == "通过" and motion not in world.governance.policies:
            world.governance.policies.append(motion)
        world.event_log.append(summary)
        for voter in voters:
            voter.mood = clamp(voter.mood + 0.03, -1.0, 1.0)
        if rivals is not None and rel != 0.0:
            left, right = rivals
            left = world.agents[left.agent_id]
            right = world.agents[right.agent_id]
            left.mood = clamp(left.mood + mood_i, -1.0, 1.0)
            right.mood = clamp(right.mood + mood_t, -1.0, 1.0)
            adjust_relation(left, right.agent_id, rel)
            adjust_relation(right, left.agent_id, rel)

    state = InteractionStateChange(
        governance={
            "motion": motion,
            "outcome": outcome,
            "yes": yes_votes,
            "no": no_votes,
            "abstain": abstain_votes,
        }
    )
    if rivals is not None and rel != 0.0:
        left, right = rivals
        state.mood_deltas = {
            left.agent_id: mood_i,
            right.agent_id: mood_t,
        }
        state.relation_deltas = [
            (left.agent_id, right.agent_id, rel),
            (right.agent_id, left.agent_id, rel),
        ]

    return InteractionResult(
        request_id=new_id(),
        kind="vote",
        status="completed",
        initiator_id=initiator.agent_id,
        summary=summary,
        transcript=transcript,
        state_changes=state,
        detail=detail,
    )


def _scripted_vote_choice(voter: WorldAgent, motion: str) -> tuple[str, str]:
    """Deterministic ballot from role / mood (no LLM)."""
    role = voter.role or ""
    if "民警" in role or "秘书" in role:
        return "yes", "按镇政厅程序支持治理议题"
    if voter.agent_id in (_RIVAL_LEFT, _RIVAL_RIGHT):
        return "yes", "与其继续吵，不如用规矩把价稳住"
    if voter.mood < -0.35:
        return "abstain", "心情不佳，暂不表态"
    if "商" in role or "贩" in role:
        return "yes" if "限价" in motion or "夜市" in motion else "no", "看生意影响"
    return "yes", "同意镇政厅安排"
