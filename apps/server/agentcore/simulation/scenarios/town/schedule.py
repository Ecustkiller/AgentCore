"""AI Town daily schedule (leaf module, import-order-independent).

Split out of ``config.py`` so the schedule lookups the agents package needs
(``tick_runner`` / ``activation`` / ``memory``) no longer force a load of
``config`` — which in turn pulls in ``agents.models`` and closes a circular
import. This module depends only on stdlib + pydantic; ``SimPersona`` is a
``TYPE_CHECKING``-only reference (``persona.role`` is plain attribute access at
runtime), keeping it a true leaf.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from agentcore.simulation.agents.models import SimPersona


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
