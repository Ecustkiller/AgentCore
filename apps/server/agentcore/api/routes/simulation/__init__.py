"""Simulation API routes."""

from fastapi import APIRouter

from .runs import router as runs_router

router = APIRouter()
router.include_router(runs_router)

__all__ = ["router"]
