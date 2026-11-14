import os
import subprocess
import sys
from io import StringIO
from unittest.mock import patch

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.models.tables import Base, Item
from tests.integration import helpers
from tests.integration.conftest import BACKEND_DIR, derived_test_url, create_db

pytestmark = pytest.mark.integration


def _alembic(args, url):
    env = dict(os.environ, DATABASE_URL=url.render_as_string(hide_password=False))
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=300,
    )


async def test_empty_db_migration_and_check():
    url = derived_test_url()
    name = url.database
    await create_db(url)
    proc = _alembic(["upgrade", "head"], url)
    assert proc.returncode == 0, proc.stderr

    engine = create_async_engine(url)
    async with engine.connect() as conn:
        tables = {
            row[0]
            for row in (await conn.execute(text(
                "SELECT table_name FROM information_schema.tables WHERE table_schema=:d"
            ), {"d": name})).all()
        }
        assert {
            "users", "families", "family_members", "items", 
            "idempotency_records", "uploaded_images", "alembic_version",
        } <= tables
        ver = (await conn.execute(text("SELECT version_num FROM alembic_version"))).scalar_one()
        assert ver == "0001_initial"
        col = (await conn.execute(text(
            "SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA "
            f"FROM information_schema.columns WHERE table_schema='{name}' "
            "AND table_name='items' AND column_name='updated_at'"
        ))).one()
        assert col[0] == "datetime(3)" and col[1] == "NO" and "CURRENT_TIMESTAMP" in col[2]
        created_by = (await conn.execute(text(
            "SELECT IS_NULLABLE FROM information_schema.columns "
            f"WHERE table_schema='{name}' AND table_name='items' AND column_name='created_by'"
        ))).scalar_one()
        assert created_by == "YES"
    await engine.dispose()

    proc = _alembic(["check"], url)
    assert proc.returncode == 0, proc.stderr


async def test_migration_frozen_schema_ignores_later_metadata():
    import sqlalchemy as sa

    tmp = sa.Table("tmp_extra_table", Base.metadata, sa.Column("id", sa.Integer, primary_key=True))
    try:
        output = StringIO()
        config = Config(output_buffer=output)
        config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
        config.set_main_option("sqlalchemy.url", "mysql+asyncmy://unused@localhost/wuji_test_offline")
        command.upgrade(config, "head", sql=True)
        sql = output.getvalue()
        assert "CREATE TABLE users" in sql
        assert "tmp_extra_table" not in sql
    finally:
        Base.metadata.remove(tmp)
    url = derived_test_url()
    await create_db(url)
    proc = _alembic(["upgrade", "head"], url)
    assert proc.returncode == 0, proc.stderr
    proc = _alembic(["check"], url)
    assert proc.returncode == 0, proc.stderr


async def test_check_migration_rejects_uninitialized_db():
    from app.db import session as session_module

    url = derived_test_url()
    await create_db(url)
    engine = create_async_engine(url)
    with patch.object(session_module, "engine", engine):
        with pytest.raises(RuntimeError, match="迁移"):
            await session_module.check_migration()
    proc = _alembic(["upgrade", "head"], url)
    assert proc.returncode == 0, proc.stderr
    with patch.object(session_module, "engine", engine):
        await session_module.check_migration()
    await engine.dispose()


async def test_model_constraints(db: AsyncSession):
    owner = await helpers.make_user(db)
    member = await helpers.make_user(db)
    family = await helpers.make_family(db, owner)
    await helpers.add_member(db, family.id, member.id)
    item = await helpers.make_item(db, family.id, created_by=member.id)
    await db.commit()
    await db.refresh(item)

    assert family.revision == 1
    assert item.version == 1
    assert item.created_at is not None
    assert item.updated_at is not None

    await db.delete(member)
    await db.commit()
    row = (await db.execute(select(Item.created_by).where(Item.id == item.id))).one_or_none()
    assert row is not None and row[0] is None
