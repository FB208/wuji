"""数据访问层。所有物品查询必须同时包含 family_id 和 status=1（文档 12.4）。"""
from datetime import datetime, timezone

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tables import Family, FamilyMember, IdempotencyRecord, Item, UploadedImage, User


# ---------- 用户 ----------
async def get_user_by_openid(db: AsyncSession, openid: str) -> User | None:
    return (await db.execute(select(User).where(User.openid == openid))).scalar_one_or_none()


async def get_user_by_code(db: AsyncSession, user_code: str) -> User | None:
    return (await db.execute(select(User).where(User.user_code == user_code))).scalar_one_or_none()


async def get_user(db: AsyncSession, user_id: int) -> User | None:
    return await db.get(User, user_id)


async def get_user_for_update(db: AsyncSession, user_id: int) -> User | None:
    stmt = select(User).where(User.id == user_id).with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


# ---------- 家庭组 ----------
async def get_family(db: AsyncSession, family_id: int) -> Family | None:
    return await db.get(Family, family_id)


async def get_family_for_update(db: AsyncSession, family_id: int) -> Family | None:
    stmt = select(Family).where(Family.id == family_id).with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_membership(db: AsyncSession, family_id: int, user_id: int) -> FamilyMember | None:
    stmt = select(FamilyMember).where(
        FamilyMember.family_id == family_id, FamilyMember.user_id == user_id
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_membership_for_update(
    db: AsyncSession, family_id: int, user_id: int
) -> FamilyMember | None:
    stmt = (
        select(FamilyMember)
        .where(FamilyMember.family_id == family_id, FamilyMember.user_id == user_id)
        .with_for_update().execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_user_families(db: AsyncSession, user_id: int) -> list[tuple[Family, str]]:
    stmt = (
        select(Family, FamilyMember.role)
        .join(FamilyMember, FamilyMember.family_id == Family.id)
        .where(FamilyMember.user_id == user_id)
        .order_by(Family.id)
    )
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]


async def list_user_family_summaries(db: AsyncSession, user_id: int) -> list[dict]:
    """一次聚合查询取得家庭展示资料及成员数，避免逐家庭额外计数。"""
    member_counts = (
        select(FamilyMember.family_id, func.count().label("member_count"))
        .group_by(FamilyMember.family_id)
        .subquery()
    )
    stmt = (
        select(
            Family.id, Family.name, Family.owner_user_id, FamilyMember.role,
            member_counts.c.member_count,
        )
        .join(FamilyMember, FamilyMember.family_id == Family.id)
        .join(member_counts, member_counts.c.family_id == Family.id)
        .where(FamilyMember.user_id == user_id)
        .order_by(Family.id)
    )
    return [dict(row) for row in (await db.execute(stmt)).mappings()]


async def list_family_members(db: AsyncSession, family_id: int) -> list[tuple[FamilyMember, User]]:
    stmt = (
        select(FamilyMember, User)
        .join(User, User.id == FamilyMember.user_id)
        .where(FamilyMember.family_id == family_id)
        .order_by(FamilyMember.created_at)
    )
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]


# ---------- 物品 ----------
def _active_items_stmt(family_id: int):
    return select(Item).where(Item.family_id == family_id, Item.status == 1)


async def get_active_item(db: AsyncSession, family_id: int, item_id: int) -> Item | None:
    stmt = _active_items_stmt(family_id).where(Item.id == item_id)
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_active_item_for_update(
    db: AsyncSession, family_id: int, item_id: int
) -> Item | None:
    stmt = _active_items_stmt(family_id).where(Item.id == item_id).with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_active_items(db: AsyncSession, family_id: int) -> list[Item]:
    stmt = _active_items_stmt(family_id).order_by(Item.updated_at.desc())
    return list((await db.execute(stmt)).scalars().all())


async def search_items_page(
    db: AsyncSession, family_id: int, q: str | None, page: int, page_size: int
) -> tuple[list[Item], int]:
    stmt = _active_items_stmt(family_id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            or_(Item.name.like(like), Item.location_text.like(like), Item.record_text.like(like))
        )
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = stmt.order_by(Item.updated_at.desc()).offset((page - 1) * page_size).limit(page_size)
    items = list((await db.execute(stmt)).scalars().all())
    return items, total


async def count_active_items(db: AsyncSession, family_id: int) -> int:
    stmt = select(func.count()).select_from(Item).where(Item.family_id == family_id, Item.status == 1)
    return (await db.execute(stmt)).scalar_one()


async def list_family_image_urls(db: AsyncSession, family_id: int) -> list[str]:
    stmt = select(Item.image_url).where(Item.family_id == family_id)
    return [r[0] for r in (await db.execute(stmt)).all()]


async def list_deleted_items(db: AsyncSession, family_id: int) -> list[Item]:
    stmt = select(Item).where(Item.family_id == family_id, Item.status == 0)
    return list((await db.execute(stmt)).scalars().all())


# ---------- 幂等 ----------
async def get_idempotency(db: AsyncSession, user_id: int, idem_key: str) -> IdempotencyRecord | None:
    stmt = select(IdempotencyRecord).where(
        IdempotencyRecord.user_id == user_id, IdempotencyRecord.idem_key == idem_key
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_idempotency_for_update(
    db: AsyncSession, user_id: int, idem_key: str
) -> IdempotencyRecord | None:
    stmt = (
        select(IdempotencyRecord)
        .where(IdempotencyRecord.user_id == user_id, IdempotencyRecord.idem_key == idem_key)
        .with_for_update().execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def delete_idempotency_for_user(db: AsyncSession, user_id: int) -> None:
    await db.execute(delete(IdempotencyRecord).where(IdempotencyRecord.user_id == user_id))


# ---------- 图片登记 ----------
async def get_uploaded_image_by_key(db: AsyncSession, object_key: str) -> UploadedImage | None:
    stmt = select(UploadedImage).where(UploadedImage.object_key == object_key)
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_uploaded_image_by_key_for_update(
    db: AsyncSession, object_key: str
) -> UploadedImage | None:
    stmt = (
        select(UploadedImage).where(UploadedImage.object_key == object_key).with_for_update().execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_uploaded_image_by_url(db: AsyncSession, image_url: str) -> UploadedImage | None:
    stmt = select(UploadedImage).where(UploadedImage.image_url == image_url)
    return (await db.execute(stmt)).scalar_one_or_none()


async def mark_image_pending_delete(db: AsyncSession, image_url: str, delete_after: datetime) -> None:
    record = await get_uploaded_image_by_url(db, image_url)
    if record is not None and record.delete_state == "none":
        record.delete_state = "pending_delete"
        record.delete_after = delete_after


async def list_cleanable_images(db: AsyncSession, unused_before: datetime) -> list[UploadedImage]:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    stmt = select(UploadedImage).where(
        or_(
            # 未入库的临时图片
            (UploadedImage.bound_item_id.is_(None))
            & (UploadedImage.delete_state == "none")
            & (UploadedImage.created_at < unused_before),
            # 被替换或软删除后的延迟清理图片
            (UploadedImage.delete_state == "pending_delete") & (UploadedImage.delete_after < now),
        )
    ).limit(200)
    return list((await db.execute(stmt)).scalars().all())
