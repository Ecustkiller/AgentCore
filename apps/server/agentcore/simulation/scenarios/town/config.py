"""AI Town scenario configuration: residents, regions, daily schedule (M2)."""

from __future__ import annotations

from pydantic import BaseModel, Field

from agentcore.simulation.agents.models import SimPersona
from agentcore.simulation.vec3 import Vec3
from agentcore.simulation.world.locations import (
    LOCATION_NEIGHBORS,
    LOCATIONS,
    REGION_POSITIONS,
    position_for_location,
)
from agentcore.simulation.world.state import WorldAgent, WorldState

# --- Region map (re-export M1 coordinate contract) ---------------------------------

TOWN_REGIONS: tuple[str, ...] = LOCATIONS
TOWN_REGION_POSITIONS: dict[str, Vec3] = REGION_POSITIONS
TOWN_REGION_NEIGHBORS: dict[str, list[str]] = LOCATION_NEIGHBORS


# --- Daily schedule (24 ticks / hours, index = hour 0–23) ----------------------------


class ScheduleSlot(BaseModel):
    """Default location + activity for one hour of the town day."""

    location: str
    activity: str


def _slot(location: str, activity: str) -> ScheduleSlot:
    return ScheduleSlot(location=location, activity=activity)


# Baseline town rhythm; residents may deviate via LLM decisions.
HOURLY_SCHEDULE: tuple[ScheduleSlot, ...] = (
    _slot("住宅区", "睡觉"),
    _slot("住宅区", "睡觉"),
    _slot("住宅区", "睡觉"),
    _slot("住宅区", "睡觉"),
    _slot("住宅区", "睡觉"),
    _slot("住宅区", "起床洗漱"),
    _slot("住宅区", "做早饭"),
    _slot("面包店", "开门准备"),
    _slot("市场", "早市开张"),
    _slot("广场", "晨练聚集"),
    _slot("市场", "买卖高峰"),
    _slot("餐厅", "午餐营业"),
    _slot("公园", "午休散步"),
    _slot("市场", "下午交易"),
    _slot("面包店", "烘焙补货"),
    _slot("广场", "闲聊社交"),
    _slot("镇政厅", "公务办理"),
    _slot("市场", "收摊准备"),
    _slot("餐厅", "晚餐高峰"),
    _slot("住宅区", "回家休息"),
    _slot("公园", "晚间散步"),
    _slot("住宅区", "居家放松"),
    _slot("住宅区", "洗漱就寝"),
    _slot("住宅区", "入睡"),
)

# Role-specific overrides keyed by hour; falls back to HOURLY_SCHEDULE.
ROLE_HOURLY_OVERRIDES: dict[str, dict[int, ScheduleSlot]] = {
    "面包师": {
        7: _slot("面包店", "和面开炉"),
        8: _slot("面包店", "出炉摆柜"),
        14: _slot("面包店", "下午烘焙"),
    },
    "退休教师": {
        9: _slot("公园", "下棋"),
        15: _slot("公园", "晒太阳聊天"),
    },
    "杂货店老板": {10: _slot("市场", "守店揽客"), 16: _slot("市场", "盘点库存")},
    "菜贩": {8: _slot("市场", "摆摊卖菜"), 17: _slot("市场", "清仓甩卖")},
    "镇派出所民警": {9: _slot("广场", "巡逻"), 16: _slot("市场", "维持秩序")},
    "餐馆老板": {11: _slot("餐厅", "后厨忙"), 18: _slot("餐厅", "招待客人")},
    "图书管理员": {10: _slot("镇政厅", "整理借阅"), 14: _slot("镇政厅", "读者服务")},
    "社区护士": {9: _slot("住宅区", "上门随访"), 15: _slot("广场", "健康咨询")},
    "手工艺人": {10: _slot("市场", "摆摊售卖"), 14: _slot("面包店", "送货换原料")},
    "镇长秘书": {9: _slot("镇政厅", "整理公文"), 16: _slot("镇政厅", "接待来访")},
}


def schedule_for_hour(hour: int) -> ScheduleSlot:
    """Default town schedule slot for clock hour ``0–23``."""
    return HOURLY_SCHEDULE[hour % 24]


def schedule_hint_for_persona(persona: SimPersona, hour: int) -> ScheduleSlot:
    """Schedule hint for one resident; role overrides take precedence."""
    overrides = ROLE_HOURLY_OVERRIDES.get(persona.role, {})
    return overrides.get(hour % 24, schedule_for_hour(hour))


# --- Residents (10 placeholder personas) ---------------------------------------------


def _prompt(name: str, role: str, traits: str) -> str:
    return (
        f"你是{name}，{role}，{traits}。"
        "每 tick 必须做出一个具体行动（move_to / stay_here / speak_to），"
        "然后简短总结本 tick 打算（一两句）。不要复读上一 tick 的原话。"
    )


LIN_PERSONA = SimPersona(
    agent_id="lin",
    name="林小梅",
    role="面包师",
    location="面包店",
    goal="今天多卖二十个可颂，攒够房租",
    system_prompt=_prompt("林小梅", "25岁面包师", "勤快但爱操心钱，说话朴实"),
)

CHEN_PERSONA = SimPersona(
    agent_id="chen",
    name="陈大爷",
    role="退休教师",
    location="公园",
    goal="在公园下棋、跟年轻人聊天，维持体面",
    system_prompt=_prompt("陈大爷", "68岁退休语文教师", "爱引经据典，好为人师但善良"),
)

ZHAO_PERSONA = SimPersona(
    agent_id="zhao",
    name="赵老板",
    role="杂货店老板",
    location="市场",
    goal="压低进货价、盯住竞争对手王婶",
    system_prompt=_prompt("赵老板", "45岁杂货店老板", "精明算计，口头客气心里打算盘"),
)

WANG_PERSONA = SimPersona(
    agent_id="wang",
    name="王婶",
    role="菜贩",
    location="市场",
    goal="把今天的青菜卖光，别被赵老板压价",
    system_prompt=_prompt("王婶", "52岁菜贩", "嗓门大、直爽，跟赵老板是老对头"),
)

LIU_PERSONA = SimPersona(
    agent_id="liu",
    name="刘警官",
    role="镇派出所民警",
    location="广场",
    goal="维持秩序，留意市场纠纷和可疑人员",
    system_prompt=_prompt("刘警官", "35岁派出所民警", "冷静务实，说话简短"),
)

SUN_PERSONA = SimPersona(
    agent_id="sun",
    name="孙大厨",
    role="餐馆老板",
    location="餐厅",
    goal="今晚满座，推出新菜品",
    system_prompt=_prompt("孙大厨", "40岁餐馆老板", "热情豪爽，爱打听镇上的八卦"),
)

ZHANG_PERSONA = SimPersona(
    agent_id="zhang",
    name="张静",
    role="图书管理员",
    location="镇政厅",
    goal="整理借阅记录，推荐一本好书给来访者",
    system_prompt=_prompt("张静", "30岁图书管理员", "安静细致，说话温柔"),
)

YANG_PERSONA = SimPersona(
    agent_id="yang",
    name="杨护士",
    role="社区护士",
    location="住宅区",
    goal="随访两位老人，留意流感迹象",
    system_prompt=_prompt("杨护士", "28岁社区护士", "耐心体贴，注重健康提醒"),
)

WU_PERSONA = SimPersona(
    agent_id="wu",
    name="吴师傅",
    role="手工艺人",
    location="市场",
    goal="卖掉三件手作木器，换购木料",
    system_prompt=_prompt("吴师傅", "50岁手工艺人", "寡言务实，看重手艺口碑"),
)

XU_PERSONA = SimPersona(
    agent_id="xu",
    name="徐秘书",
    role="镇长秘书",
    location="镇政厅",
    goal="整理本周议事清单，协调各方诉求",
    system_prompt=_prompt("徐秘书", "32岁镇长秘书", "条理清晰，善于斡旋"),
)

TOWN_PERSONAS: tuple[SimPersona, ...] = (
    LIN_PERSONA,
    CHEN_PERSONA,
    ZHAO_PERSONA,
    WANG_PERSONA,
    LIU_PERSONA,
    SUN_PERSONA,
    ZHANG_PERSONA,
    YANG_PERSONA,
    WU_PERSONA,
    XU_PERSONA,
)

M1_PERSONAS: tuple[SimPersona, ...] = TOWN_PERSONAS[:5]
TOWN_AGENT_IDS: tuple[str, ...] = tuple(p.agent_id for p in TOWN_PERSONAS)
M1_AGENT_IDS: tuple[str, ...] = tuple(p.agent_id for p in M1_PERSONAS)


class TownScenarioConfig(BaseModel):
    """Bundle of town scenario static configuration."""

    personas: tuple[SimPersona, ...] = Field(default=TOWN_PERSONAS)
    regions: tuple[str, ...] = Field(default=TOWN_REGIONS)
    region_positions: dict[str, Vec3] = Field(default_factory=lambda: dict(TOWN_REGION_POSITIONS))
    hourly_schedule: tuple[ScheduleSlot, ...] = Field(default=HOURLY_SCHEDULE)


TOWN_CONFIG = TownScenarioConfig()


# Initial relationship weights (-1..1); symmetric pairs stored on both agents.
INITIAL_RELATIONSHIPS: dict[str, dict[str, float]] = {
    "lin": {"chen": 0.3, "sun": 0.2},
    "chen": {"lin": 0.3, "zhang": 0.4, "yang": 0.5},
    "zhao": {"wang": -0.4, "wu": 0.1},
    "wang": {"zhao": -0.4, "liu": 0.2},
    "liu": {"wang": 0.2, "xu": 0.3},
    "sun": {"lin": 0.2, "zhang": 0.15},
    "zhang": {"chen": 0.4, "sun": 0.15, "xu": 0.25},
    "yang": {"chen": 0.5},
    "wu": {"zhao": 0.1, "wang": 0.05},
    "xu": {"liu": 0.3, "zhang": 0.25},
}


def initial_relationships_for(agent_id: str) -> dict[str, float]:
    return dict(INITIAL_RELATIONSHIPS.get(agent_id, {}))


def seed_town_world(personas: tuple[SimPersona, ...] | None = None) -> WorldState:
    world = WorldState()
    for p in personas or TOWN_PERSONAS:
        world.agents[p.agent_id] = WorldAgent(
            agent_id=p.agent_id,
            name=p.name,
            role=p.role,
            location=p.location,
            position=position_for_location(p.location),
            goal=p.goal,
            activity="刚到镇上",
            relationships=initial_relationships_for(p.agent_id),
        )
    return world


def seed_m1_world(personas: tuple[SimPersona, ...] | None = None) -> WorldState:
    """Backward-compatible alias; defaults to the original five residents."""
    return seed_town_world(personas or M1_PERSONAS)


def persona_by_id(agent_id: str, personas: tuple[SimPersona, ...] | None = None) -> SimPersona:
    for p in personas or TOWN_PERSONAS:
        if p.agent_id == agent_id:
            return p
    raise KeyError(agent_id)
