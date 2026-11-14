"""唔叽 · 家庭收纳工具 后端入口。"""
import asyncio
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError

from app.api.v1 import auth, families, items
from app.core.errors import (
    AppError,
    app_error_handler,
    unhandled_error_handler,
    validation_error_handler,
)
from app.core.logging import get_logger, setup_logging
from app.db.session import check_migration
from app.services.cleanup_service import cleanup_loop

setup_logging()
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await check_migration()
    cleanup_task = asyncio.create_task(cleanup_loop())
    logger.info("唔叽后端启动完成")
    yield
    cleanup_task.cancel()


app = FastAPI(title="wuji", version="1.0.0", lifespan=lifespan)

app.add_exception_handler(AppError, app_error_handler)
app.add_exception_handler(RequestValidationError, validation_error_handler)
app.add_exception_handler(Exception, unhandled_error_handler)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request.state.request_id = f"req_{uuid.uuid4().hex}"
    started = time.monotonic()
    response = await call_next(request)
    response.headers["X-Request-Id"] = request.state.request_id
    elapsed_ms = (time.monotonic() - started) * 1000
    logger.info(
        "%s %s -> %d %.0fms",
        request.method, request.url.path, response.status_code, elapsed_ms,
    )
    return response


app.include_router(auth.router, prefix="/api/v1", tags=["auth"])
app.include_router(families.router, prefix="/api/v1", tags=["families"])
app.include_router(items.router, prefix="/api/v1", tags=["items"])


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}
