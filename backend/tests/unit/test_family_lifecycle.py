"""家庭组转让、解散、清理与账号注销的单元测试（文档 7.2 / 8.5 / 14.3）。"""
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.core.errors import AppError
from app.services import family_service as svc

pytestmark = pytest.mark.unit


class _FakeBegin:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *args):
        return False


class _FakeDB:
    def __init__(self):
        self.deleted = []
        self.commits = 0

    def begin(self):
        return _FakeBegin()

    async def delete(self, obj):
        self.deleted.append(obj)

    async def commit(self):
        self.commits += 1


def _member(role):
    return SimpleNamespace(role=role)


def _family():
    return SimpleNamespace(id=10, owner_user_id=1, revision=1)


async def test_transfer_swaps_roles_and_owner():
    db = _FakeDB()
    owner = _member("owner")
    target = _member("member")
    family = _family()
    with (
        patch.object(svc.repos, "get_membership", new=AsyncMock(side_effect=lambda d, f, u: {1: owner, 2: target}.get(u))),
        patch.object(svc.repos, "get_family_for_update", new=AsyncMock(return_value=family)),
    ):
        out = await svc.transfer_ownership(db, 10, 1, 2)
    assert owner.role == "member"
    assert target.role == "owner"
    assert family.owner_user_id == 2
    assert family.revision == 2
    assert out["owner_user_id"] == 2
    assert db.commits == 1


async def test_transfer_requires_owner_and_existing_member():
    db = _FakeDB()
    with patch.object(svc.repos, "get_membership", new=AsyncMock(return_value=_member("member"))):
        with pytest.raises(AppError) as ei:
            await svc.transfer_ownership(db, 10, 2, 3)
    assert ei.value.code == "FAMILY_FORBIDDEN"

    db = _FakeDB()
    with patch.object(svc.repos, "get_membership", new=AsyncMock(side_effect=lambda d, f, u: _member("owner") if u == 1 else None)):
        with pytest.raises(AppError) as ei:
            await svc.transfer_ownership(db, 10, 1, 99)
    assert ei.value.code == "NOT_FOUND"

    db = _FakeDB()
    with patch.object(svc.repos, "get_membership", new=AsyncMock(side_effect=lambda d, f, u: _member("owner") if u == 1 else _member("member"))):
        with pytest.raises(AppError):
            await svc.transfer_ownership(db, 10, 1, 1)


async def test_dissolve_owner_only_retires_images_deletes_family():
    db = _FakeDB()
    family = _family()
    marked = []
    with (
        patch.object(svc.repos, "get_membership", new=AsyncMock(return_value=_member("owner"))),
        patch.object(svc.repos, "get_family_for_update", new=AsyncMock(return_value=family)),
        patch.object(svc.repos, "list_family_image_urls", new=AsyncMock(return_value=["u1", "u2"])),
        patch.object(svc.repos, "mark_image_pending_delete", new=AsyncMock(side_effect=lambda d, url, after: marked.append(url))),
    ):
        await svc.dissolve_family(db, 10, 1)
    assert db.deleted == [family]
    assert marked == ["u1", "u2"]
    assert db.commits == 1

    db = _FakeDB()
    with patch.object(svc.repos, "get_membership", new=AsyncMock(return_value=_member("member"))):
        with pytest.raises(AppError) as ei:
            await svc.dissolve_family(db, 10, 2)
    assert ei.value.code == "FAMILY_FORBIDDEN"
    assert db.commits == 0


async def test_purge_deleted_items():
    db = _FakeDB()
    family = _family()
    gone = [SimpleNamespace(id=5, image_url="old1"), SimpleNamespace(id=6, image_url="old2")]
    marked = []
    with (
        patch.object(svc.repos, "get_membership", new=AsyncMock(return_value=_member("member"))),
        patch.object(svc.repos, "get_family_for_update", new=AsyncMock(return_value=family)),
        patch.object(svc.repos, "list_deleted_items", new=AsyncMock(return_value=gone)),
        patch.object(svc.repos, "mark_image_pending_delete", new=AsyncMock(side_effect=lambda d, url, after: marked.append(url))),
    ):
        n = await svc.purge_deleted_items(db, 10, 2)
    assert n == 2
    assert db.deleted == gone
    assert marked == ["old1", "old2"]
    assert family.revision == 2


async def test_purge_requires_membership():
    db = _FakeDB()
    with patch.object(svc.repos, "get_membership", new=AsyncMock(return_value=None)):
        with pytest.raises(AppError) as ei:
            await svc.purge_deleted_items(db, 10, 9)
    assert ei.value.code == "FAMILY_FORBIDDEN"


async def test_delete_account_dissolves_owned_leaves_shared_removes_user():
    db = _FakeDB()
    owned = SimpleNamespace(id=10)
    shared = SimpleNamespace(id=20, revision=3)
    member = _member("member")
    user = SimpleNamespace(id=1)
    dissolved = []
    idem_deleted = []

    async def family_for_update(d, fid):
        return shared if fid == 20 else owned

    with (
        patch.object(svc.repos, "list_user_families", new=AsyncMock(return_value=[(owned, "owner"), (shared, "member")])),
        patch.object(svc.repos, "get_family_for_update", new=AsyncMock(side_effect=family_for_update)),
        patch.object(svc.repos, "get_membership", new=AsyncMock(return_value=member)),
        patch.object(svc.repos, "list_family_image_urls", new=AsyncMock(return_value=["u1"])),
        patch.object(svc.repos, "mark_image_pending_delete", new=AsyncMock()),
        patch.object(svc.repos, "delete_idempotency_for_user", new=AsyncMock(side_effect=lambda d, u: idem_deleted.append(u))),
        patch.object(svc.repos, "get_user", new=AsyncMock(return_value=user)),
        patch.object(svc, "_dissolve_locked", wraps=svc._dissolve_locked) as spy,
    ):
        await svc.delete_account(db, 1)
    assert spy.await_count == 1
    assert member in db.deleted
    assert owned in db.deleted
    assert user in db.deleted
    assert shared.revision == 4
    assert idem_deleted == [1]
    assert db.commits == 1
