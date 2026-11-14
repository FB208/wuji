"""initial schema"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import DATETIME, TINYINT

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

MYSQL_ARGS = dict(mysql_engine="InnoDB", mysql_charset="utf8mb4", mysql_collate="utf8mb4_0900_ai_ci")

DT3 = DATETIME(fsp=3)


def _ts() -> list:
    return [
        sa.Column("created_at", DT3, nullable=False, server_default=sa.func.now(3)),
        sa.Column("updated_at", DT3, nullable=False, server_default=sa.func.now(3)),
    ]


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("openid", sa.String(64), nullable=False),
        sa.Column("unionid", sa.String(64), nullable=True),
        sa.Column("nickname", sa.String(64), nullable=True),
        sa.Column("avatar_url", sa.String(1024), nullable=True),
        *_ts(),
        sa.UniqueConstraint("openid", name="uk_users_openid"),
        sa.UniqueConstraint("unionid", name="uk_users_unionid"),
        **MYSQL_ARGS,
    )
    op.create_table(
        "families",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("owner_user_id", sa.BigInteger, sa.ForeignKey("users.id", name="fk_families_owner"), nullable=False),
        sa.Column("revision", sa.BigInteger, nullable=False, server_default="1"),
        *_ts(),
        **MYSQL_ARGS,
    )
    op.create_index("idx_families_owner", "families", ["owner_user_id"])
    op.create_table(
        "family_members",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("family_id", sa.BigInteger, sa.ForeignKey("families.id", name="fk_family_members_family", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.BigInteger, sa.ForeignKey("users.id", name="fk_family_members_user", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.Enum("owner", "member", name="family_role"), nullable=False),
        sa.Column("created_at", DT3, nullable=False, server_default=sa.func.now(3)),
        sa.UniqueConstraint("family_id", "user_id", name="uk_family_member"),
        **MYSQL_ARGS,
    )
    op.create_index("idx_family_members_user", "family_members", ["user_id"])
    op.create_table(
        "items",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("family_id", sa.BigInteger, sa.ForeignKey("families.id", name="fk_items_family", ondelete="CASCADE"), nullable=False),
        sa.Column("created_by", sa.BigInteger, sa.ForeignKey("users.id", name="fk_items_creator", ondelete="SET NULL"), nullable=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("location_text", sa.String(255), nullable=False),
        sa.Column("record_text", sa.Text, nullable=False),
        sa.Column("image_url", sa.String(1024), nullable=False),
        sa.Column("status", TINYINT, nullable=False, comment="1=active, 0=deleted"),
        sa.Column("version", sa.BigInteger, nullable=False, server_default="1"),
        *_ts(),
        sa.Column("deleted_at", DT3, nullable=True),
        **MYSQL_ARGS,
    )
    op.create_index("idx_items_family_status_updated", "items", ["family_id", "status", "updated_at"])
    op.create_index("idx_items_family_name", "items", ["family_id", "name"])

    op.create_table(
        "idempotency_records",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("idem_key", sa.String(128), nullable=False),
        sa.Column("operation", sa.String(32), nullable=False),
        sa.Column("family_id", sa.BigInteger, nullable=True),
        sa.Column("request_hash", sa.String(64), nullable=True),
        sa.Column("state", sa.Enum("processing", "completed", "failed", name="idem_state"), nullable=False),
        sa.Column("lease_token", sa.String(64), nullable=True),
        sa.Column("lease_until", DT3, nullable=True),
        sa.Column("response_json", sa.Text, nullable=True),
        sa.Column("error_json", sa.Text, nullable=True),
        sa.Column("response_expires_at", DT3, nullable=True),
        sa.Column("created_at", DT3, nullable=False, server_default=sa.func.now(3)),
        sa.UniqueConstraint("user_id", "idem_key", name="uk_idem_user_key"),
        **MYSQL_ARGS,
    )
    op.create_index("idx_idem_response_expires", "idempotency_records", ["response_expires_at"])
    op.create_table(
        "uploaded_images",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("family_id", sa.BigInteger, nullable=False),
        sa.Column("uploader_user_id", sa.BigInteger, sa.ForeignKey("users.id", name="fk_uploaded_uploader", ondelete="SET NULL"), nullable=True),
        sa.Column("bound_item_id", sa.BigInteger, nullable=True),
        sa.Column("object_key", sa.String(512), nullable=False),
        sa.Column("image_url", sa.String(1024), nullable=False),
        sa.Column("delete_state", sa.Enum("none", "pending_delete", name="image_delete_state"), nullable=False),
        sa.Column("delete_after", DT3, nullable=True),
        sa.Column("created_at", DT3, nullable=False, server_default=sa.func.now(3)),
        sa.UniqueConstraint("object_key", name="uk_uploaded_object_key"),
        **MYSQL_ARGS,
    )
    op.create_index("idx_uploaded_used_created", "uploaded_images", ["bound_item_id", "created_at"])


def downgrade() -> None:
    op.drop_table("uploaded_images")
    op.drop_table("idempotency_records")
    op.drop_table("items")
    op.drop_table("family_members")
    op.drop_table("families")
    op.drop_table("users")
