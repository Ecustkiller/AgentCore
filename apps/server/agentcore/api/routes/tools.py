"""Built-in tool catalog (read-only)."""

from fastapi import APIRouter

from agentcore.api.dependencies import AuthUser
from agentcore.api.schemas import ToolInfo, ToolListResponse
from agentcore.tools.builtin import build_builtin_registry

router = APIRouter(prefix="/tools", tags=["tools"])


@router.get("", response_model=ToolListResponse)
async def list_tools(_user: AuthUser) -> ToolListResponse:
    """List the platform's built-in tools (name, description, category, approval).

    Serializes the same registry the chat pipeline equips workers with, minus the
    CEO-only ``delegate`` primitive. The catalog is static platform metadata (not
    user-scoped); auth is required only to match the app's authenticated posture.
    """
    registry = build_builtin_registry()
    tools = [
        ToolInfo(
            name=schema.name,
            description=schema.description,
            category=schema.category,
            approval=schema.approval,
            parameters=schema.parameters,
        )
        for schema in registry.list_all()
    ]
    return ToolListResponse(data=tools, total=len(tools))
