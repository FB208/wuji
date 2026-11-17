"""用户随机 ID：家庭组所有者凭 ID 添加成员。"""
import secrets

from alembic import op
import sqlalchemy as sa

revision = "0003_user_code"
down_revision = "0002_record_sessions"
branch_labels = None
depends_on = None

_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"


def _code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(8))


def upgrade() -> None:
    """先加可空列，为已有用户回填唯一 ID，再改为非空并加唯一约束。"""
    op.add_column("users", sa.Column("user_code", sa.String(16), nullable=True))
    conn = op.get_bind()
    ids = [row[0] for row in conn.execute(sa.text("SELECT id FROM users"))]
    used: set[str] = set()
    for uid in ids:
        code = _code()
        while code in used:
            code = _code()
        used.add(code)
        conn.execute(sa.text("UPDATE users SET user_code=:c WHERE id=:i"), {"c": code, "i": uid})
    op.alter_column("users", "user_code", existing_type=sa.String(16), nullable=False)
    op.create_unique_constraint("uk_users_code", "users", ["user_code"])


def downgrade() -> None:
    op.drop_constraint("uk_users_code", "users", type_="unique")
    op.drop_column("users", "user_code")
