"""Town region graph and 3D anchor positions (M1 coordinate contract)."""

from __future__ import annotations

from agentcore.simulation.vec3 import Vec3

LOCATIONS: tuple[str, ...] = ("广场", "市场", "餐厅", "面包店", "公园", "住宅区", "镇政厅")

LOCATION_NEIGHBORS: dict[str, list[str]] = {
    "广场": ["市场", "公园", "镇政厅"],
    "市场": ["广场", "面包店", "餐厅"],
    "餐厅": ["市场", "住宅区"],
    "面包店": ["市场", "住宅区"],
    "公园": ["广场", "住宅区"],
    "住宅区": ["餐厅", "面包店", "公园"],
    "镇政厅": ["广场"],
}

# Region centers on the XZ ground plane (Y-up). Frontend NavMesh may nudge NPCs locally;
# these anchors are the authoritative sync points for SSE + tick snapshots.
REGION_POSITIONS: dict[str, Vec3] = {
    "广场": Vec3(x=0, y=0, z=0),
    "市场": Vec3(x=24, y=0, z=0),
    "餐厅": Vec3(x=36, y=0, z=12),
    "面包店": Vec3(x=24, y=0, z=-12),
    "公园": Vec3(x=-18, y=0, z=6),
    "住宅区": Vec3(x=12, y=0, z=24),
    "镇政厅": Vec3(x=-12, y=0, z=-10),
}


def position_for_location(location: str) -> Vec3:
    return REGION_POSITIONS.get(location, Vec3()).model_copy()
