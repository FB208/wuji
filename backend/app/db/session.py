"""异步数据库会话，启动时自动检查并创建缺失的表。"""
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

engine = create_async_engine(get_settings().database_url, pool_pre_ping=True, pool_recycle=1800)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session


async def init_database() -> None:
    """启动时检查表结构：缺失的表自动创建（checkfirst），已有表不做破坏性变更。"""
    from app.models.tables import Base

    async with engine.begin() as conn:
        await conn.run_sync(lambda sync_conn: Base.metadata.create_all(sync_conn, checkfirst=True))
    logger.info("数据库表结构检查完成")
