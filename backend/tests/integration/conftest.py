import asyncio
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND_DIR))

TEST_DSN = os.environ.get("WUJI_TEST_DATABASE_URL")

_BASE = None
if TEST_DSN:
    _BASE = make_url(TEST_DSN)
    if not re.fullmatch(r"wuji_test(_[a-z0-9]+)?", _BASE.database or ""):
        pytest.exit(
            "集成测试库名必须为 wuji_test 或 wuji_test_*",
            returncode=3,
        )

RUN_ID = uuid.uuid4().hex[:8]
_owned_dbs: list[str] = []


def derived_test_url():
    return _BASE.set(database=f"wuji_test_{RUN_ID}{uuid.uuid4().hex[:6]}")


def derived_test_dsn() -> str:
    return derived_test_url().render_as_string(hide_password=False)


async def create_db(url) -> str:
    name = make_url(url).database
    admin = create_async_engine(_BASE.set(database="mysql"))
    try:
        async with admin.begin() as conn:
            await conn.execute(text(f"CREATE DATABASE `{name}` CHARACTER SET utf8mb4"))
    finally:
        await admin.dispose()
    _owned_dbs.append(name)
    return name


async def _drop_owned_dbs() -> None:
    if not _owned_dbs:
        return
    admin = create_async_engine(_BASE.set(database="mysql"))
    try:
        async with admin.begin() as conn:
            for name in _owned_dbs:
                await conn.execute(text(f"DROP DATABASE `{name}`"))
    finally:
        await admin.dispose()


def _run_migrations(dsn: str) -> None:
    env = dict(os.environ, DATABASE_URL=dsn)
    proc = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0:
        pytest.exit(f"alembic upgrade head 失败：\n{proc.stdout}\n{proc.stderr}", returncode=3)


_TABLES_DELETE_ORDER = [
    
    "idempotency_records",
    "uploaded_images",
    "items",
    "family_members",
    "families",
    "users",
]

_DB_URL = derived_test_url() if TEST_DSN else None
_engine = create_async_engine(_DB_URL) if _DB_URL else None
TestSession = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession) if _engine else None
_MIGRATED = False


@pytest_asyncio.fixture(autouse=True)
async def _prepare_db():
    if _engine is None:
        pytest.skip("WUJI_TEST_DATABASE_URL 未设置，跳过集成测试")
    global _MIGRATED
    if not _MIGRATED:
        await create_db(_DB_URL)
        await asyncio.to_thread(_run_migrations, _DB_URL.render_as_string(hide_password=False))
        _MIGRATED = True
    async with _engine.begin() as conn:
        for table in _TABLES_DELETE_ORDER:
            await conn.execute(text(f"DELETE FROM {table}"))
    yield


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _cleanup_owned_dbs():
    yield
    if _engine is not None:
        await _engine.dispose()
    await _drop_owned_dbs()


@pytest_asyncio.fixture
async def db():
    async with TestSession() as session:
        yield session


@pytest_asyncio.fixture
def session_factory():
    return TestSession
