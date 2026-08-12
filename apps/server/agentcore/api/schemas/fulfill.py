"""Update the root set declared by an online fulfillment session."""

from pydantic import BaseModel, Field


class UpdateFulfillRootsRequest(BaseModel):
    """``POST /v1/fulfill/roots`` — refresh roots without reconnecting the SSE."""

    device_id: str = Field(..., min_length=1, max_length=128)
    roots: list[str] = Field(default_factory=list)
