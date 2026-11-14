"""异步数据库会话，启动时自动检查并创建缺失的表。"""
from collections.abc import AsyncGenerator
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

engine = create_async_engine(
    get_settings().database_url,
    pool_pre_ping=True,
    pool_recycle=1800,
    connect_args={"init_command": "SET time_zone = '+00:00'"},
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

_ALEMBIC_DIR = Path(__file__).resolve().parents[2] / "alembic"


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session


async def check_migration() -> None:
    """启动检查：数据库迁移版本必须与代码 head 一致；未知或未初始化库直接报错。"""
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory

    heads = set(ScriptDirectory(str(_ALEMBIC_DIR)).get_heads())
    async with engine.connect() as conn:
        current = await conn.run_sync(
            lambda sync_conn: MigrationContext.configure(sync_conn).get_current_revision()
        )
    if current is None:
        raise RuntimeError(
            "数据库未初始化或迁移状态缺失，请先执行迁移：python -m alembic upgrade head"
        )
    if current not in heads:
        raise RuntimeError(
            f"数据库迁移版本 {current} 与代码期望版本 {sorted(heads)} 不一致，请先执行迁移"
        )
    logger.info("数据库迁移版本检查通过：%s", current)
