"""账号级默认家庭；已有账号保持未设置状态。"""
from alembic import op
import sqlalchemy as sa

revision = "0004_default_family"
down_revision = "0003_user_code"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """新增可空默认家庭字段和清理查询索引。"""
    op.add_column("users", sa.Column("default_family_id", sa.BigInteger(), nullable=True))
    op.create_index("idx_users_default_family", "users", ["default_family_id"])
