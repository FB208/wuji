"""集成测试数据夹具：直接操作测试库构造用户/家庭/物品/图片登记。"""
import sys
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

BACKEND_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND_DIR))

from app.core.security import create_signed_token
from app.models.tables import Family, FamilyMember, Item, UploadedImage, User

_counter = {"n": 0}


def _next() -> int:
    _counter["n"] += 1
    return _counter["n"]


async def make_user(db: AsyncSession, nickname: str | None = None) -> User:
    n = _next()
    user = User(openid=f"openid_test_{n}", user_code=f"T{n:07d}", nickname=nickname or f"用户{n}")
    db.add(user)
    await db.flush()
    return user


async def make_family(db: AsyncSession, owner: User, name: str = "测试家庭") -> Family:
    family = Family(name=name, owner_user_id=owner.id)
    db.add(family)
    await db.flush()
    db.add(FamilyMember(family_id=family.id, user_id=owner.id, role="owner"))
    await db.flush()
    return family


async def add_member(db: AsyncSession, family_id: int, user_id: int, role: str = "member") -> None:
    db.add(FamilyMember(family_id=family_id, user_id=user_id, role=role))
    await db.flush()


async def make_item(
    db: AsyncSession,
    family_id: int,
    *,
    name: str = "数据线",
    location_text: str = "客厅抽屉",
    image_url: str = "http://img.test/a.jpg",
    status: int = 1,
    created_by: int | None = None,
) -> Item:
    item = Item(
        family_id=family_id,
        created_by=created_by,
        name=name,
        location_text=location_text,
        record_text="测试记录",
        image_url=image_url,
        status=status,
    )
    db.add(item)
    await db.flush()
    return item


async def seed_items(db: AsyncSession, family_id: int, count: int, created_by: int | None = None) -> None:
    for i in range(count):
        db.add(
            Item(
                family_id=family_id,
                created_by=created_by,
                name=f"物品{i}",
                location_text=f"位置{i}",
                record_text=f"记录{i}",
                image_url=f"http://img.test/{i}.jpg",
                status=1,
            )
        )
    await db.flush()


def make_image_token(family_id: int, object_key: str, image_url: str) -> str:
    return create_signed_token(
        {"key": object_key, "url": image_url, "fid": family_id},
        ttl_seconds=3600,
        purpose="image",
    )


async def register_image(
    db: AsyncSession,
    family_id: int,
    uploader_user_id: int | None,
    object_key: str,
    image_url: str,
    *,
    delete_state: str = "none",
    bound_item_id: int | None = None,
) -> UploadedImage:
    rec = UploadedImage(
        family_id=family_id,
        uploader_user_id=uploader_user_id,
        bound_item_id=bound_item_id,
        object_key=object_key,
        image_url=image_url,
        delete_state=delete_state,
    )
    db.add(rec)
    await db.flush()
    return rec


def fake_judge(**kw):
    base = {"operation": "create", "target_item_id": None, "name": "新物品", "location_text": "新位置"}
    base.update(kw)
    return base
