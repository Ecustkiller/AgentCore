"""FastAPI application entry point."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from agentcore.api.routes import auth, conversations, system
from agentcore.config import settings
from agentcore.core.errors import AgentCoreError
from agentcore.core.logging import setup_logging


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(debug=settings.debug)
    yield


app = FastAPI(
    title="AgentCore",
    description="Multi-Agent AI Workspace API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AgentCoreError)
async def agentcore_error_handler(request, exc: AgentCoreError):
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


app.include_router(system.router)
app.include_router(auth.router, prefix="/v1")
app.include_router(conversations.router, prefix="/v1")
