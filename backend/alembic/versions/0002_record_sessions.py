"""收纳本轮会话及操作快照。"""
from alembic import op
import sqlalchemy as sa

revision = "0002_record_sessions"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """创建每位用户最近一轮的收纳临时记录。"""
    op.create_table(
        "record_sessions",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("user_id", sa.BigInteger, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("family_id", sa.BigInteger, sa.ForeignKey("families.id", ondelete="CASCADE"), nullable=False),
        sa.Column("context_json", sa.Text, nullable=False),
        sa.Column("undo_json", sa.Text, nullable=False),
        sa.UniqueConstraint("user_id", name="uk_record_sessions_user"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_0900_ai_ci",
    )


def downgrade() -> None:
    """删除收纳临时表，保留正式物品记录。"""
    op.drop_table("record_sessions")
