"""数据表定义（对应文档 12.3 建表 SQL）。

启动时通过 metadata.create_all(checkfirst=True) 自动创建缺失表。
idempotency_records 用于实现写接口 Idempotency-Key（文档 13.1），
uploaded_images 用于追踪未入库图片以便定时清理（文档 4.5 / 10.3）。
"""
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.mysql import DATETIME as MySQLDateTime
from sqlalchemy.dialects.mysql import TINYINT
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


MYSQL_ARGS = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_0900_ai_ci"}

DT3 = DateTime().with_variant(MySQLDateTime(fsp=3), "mysql")


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("openid", name="uk_users_openid"),
        UniqueConstraint("unionid", name="uk_users_unionid"),
        UniqueConstraint("user_code", name="uk_users_code"),
        Index("idx_users_default_family", "default_family_id"),
        MYSQL_ARGS,
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    openid: Mapped[str] = mapped_column(String(64), nullable=False)
    # 对外展示的随机用户 ID，家庭组所有者凭它添加成员（不暴露自增主键，防止被枚举）
    user_code: Mapped[str] = mapped_column(String(16), nullable=False)
    unionid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    nickname: Mapped[str | None] = mapped_column(String(64), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # 个人启动偏好；成员移除或家庭解散时在业务事务内清理。
    default_family_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DT3, nullable=False, server_default=func.now(3))
    updated_at: Mapped[datetime] = mapped_column(
        DT3, nullable=False, server_default=func.now(3), onupdate=func.now(3)
    )


class Family(Base):
    __tablename__ = "families"
    __table_args__ = (
        Index("idx_families_owner", "owner_user_id"),
        MYSQL_ARGS,
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    owner_user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", name="fk_families_owner"), nullable=False
    )
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DT3, nullable=False, server_default=func.now(3))
    updated_at: Mapped[datetime] = mapped_column(
        DT3, nullable=False, server_default=func.now(3), onupdate=func.now(3)
    )


class FamilyMember(Base):
    __tablename__ = "family_members"
    __table_args__ = (
        UniqueConstraint("family_id", "user_id", name="uk_family_member"),
        Index("idx_family_members_user", "user_id"),
        MYSQL_ARGS,
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    family_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("families.id", name="fk_family_members_family", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", name="fk_family_members_user", ondelete="CASCADE"),
        nullable=False,
    )
    role: Mapped[str] = mapped_column(
        Enum("owner", "member", name="family_role"), nullable=False, default="member"
    )
    created_at: Mapped[datetime] = mapped_column(DT3, nullable=False, server_default=func.now(3))


class Item(Base):
    __tablename__ = "items"
    __table_args__ = (
        Index("idx_items_family_status_updated", "family_id", "status", "updated_at"),
        Index("idx_items_family_name", "family_id", "name"),
        MYSQL_ARGS,
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    family_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("families.id", name="fk_items_family", ondelete="CASCADE"), nullable=False
    )
    created_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", name="fk_items_creator", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    location_text: Mapped[str] = mapped_column(String(255), nullable=False)
    record_text: Mapped[str] = mapped_column(Text, nullable=False)
    image_url: Mapped[str] = mapped_column(String(1024), nullable=False)
    status: Mapped[int] = mapped_column(TINYINT, nullable=False, default=1, comment="1=active, 0=deleted")
    version: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DT3, nullable=False, server_default=func.now(3))
    updated_at: Mapped[datetime] = mapped_column(
        DT3, nullable=False, server_default=func.now(3), onupdate=func.now(3)
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DT3, nullable=True)


class IdempotencyRecord(Base):
    """写接口幂等：同一用户携带相同 Idempotency-Key 时返回首次结果。"""

    __tablename__ = "idempotency_records"
    __table_args__ = (
        UniqueConstraint("user_id", "idem_key", name="uk_idem_user_key"),
        Index("idx_idem_response_expires", "response_expires_at"),
        MYSQL_ARGS,
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    idem_key: Mapped[str] = mapped_column(String(128), nullable=False)
    operation: Mapped[str] = mapped_column(String(32), nullable=False)
    family_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    request_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    state: Mapped[str] = mapped_column(
        Enum("processing", "completed", "failed", name="idem_state"),
        nullable=False,
        default="processing",
    )
    lease_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DT3, nullable=True)
    response_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    response_expires_at: Mapped[datetime | None] = mapped_column(DT3, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DT3, nullable=False, server_default=func.now(3))


class UploadedImage(Base):
    """图片上传登记：入库成功后标记 used=1，未使用图片由清理任务删除。"""

    __tablename__ = "uploaded_images"
    __table_args__ = (
        UniqueConstraint("object_key", name="uk_uploaded_object_key"),
        Index("idx_uploaded_used_created", "bound_item_id", "created_at"),
        MYSQL_ARGS,
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    family_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    uploader_user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", name="fk_uploaded_uploader", ondelete="SET NULL"),
        nullable=True,
    )
    bound_item_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    object_key: Mapped[str] = mapped_column(String(512), nullable=False)
    image_url: Mapped[str] = mapped_column(String(1024), nullable=False)
    delete_state: Mapped[str] = mapped_column(
        Enum("none", "pending_delete", name="image_delete_state"),
        nullable=False,
        default="none",
    )
    delete_after: Mapped[datetime | None] = mapped_column(DT3, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DT3, nullable=False, server_default=func.now(3))


class RecordSession(Base):
    """保存用户最近一轮收纳对话及更正上一笔操作所需的数据。"""

    __tablename__ = "record_sessions"
    __table_args__ = (UniqueConstraint("user_id", name="uk_record_sessions_user"), MYSQL_ARGS)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    family_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    context_json: Mapped[str] = mapped_column(Text, nullable=False)
    undo_json: Mapped[str] = mapped_column(Text, nullable=False)
