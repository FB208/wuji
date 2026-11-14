"""请求 / 响应模型（对应文档 13 章接口字段）。"""
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from typing_extensions import Annotated


# ---------- 认证 ----------
class WechatLoginRequest(BaseModel):
    code: str = Field(min_length=1)
    nickname: str | None = None
    avatar_url: str | None = None


class UserOut(BaseModel):
    id: int
    nickname: str | None
    avatar_url: str | None


class LoginOut(BaseModel):
    access_token: str
    user: UserOut
    current_family_id: int


# ---------- 家庭组 ----------
class FamilyOut(BaseModel):
    id: int
    name: str
    owner_user_id: int
    role: str
    member_count: int | None = None


class FamilyCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class FamilyPatchRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class FamilyMemberOut(BaseModel):
    user_id: int
    nickname: str | None
    avatar_url: str | None
    role: str
    joined_at: datetime


class InviteOut(BaseModel):
    invite_token: str
    share_path: str
    expires_at: datetime


class FamilyJoinRequest(BaseModel):
    invite_token: str = Field(min_length=1)


class InvitePreviewOut(BaseModel):
    family_id: int
    family_name: str
    owner_nickname: str | None


class FamilyTransferRequest(BaseModel):
    user_id: int = Field(gt=0)


# ---------- 物品 ----------
class ItemOut(BaseModel):
    id: int
    name: str
    location_text: str
    record_text: str | None = None
    image_url: str
    version: int
    updated_at: datetime


class ItemBriefOut(BaseModel):
    id: int
    name: str
    location_text: str
    image_url: str


class ItemRecordRequest(BaseModel):
    family_id: int
    image_token: str = Field(min_length=1, max_length=2048)
    transcript: str = Field(min_length=1, max_length=2000)


class ItemRecordOut(BaseModel):
    operation: str
    item: ItemOut


class ItemListOut(BaseModel):
    items: list[ItemOut]
    page: int
    page_size: int
    total: int


class ItemPatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    location_text: str | None = Field(default=None, min_length=1, max_length=255)
    image_token: str | None = Field(default=None, max_length=2048)
    expected_version: int = Field(ge=1)


# ---------- 查找 ----------
def _positive_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("物品 id 必须为正整数")
    return value


SearchItemId = Annotated[int, BeforeValidator(_positive_int)]


class SearchTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(max_length=512)
    status: Literal["found", "multiple", "not_found"] | None = None
    item_ids: list[SearchItemId] = Field(default_factory=list, max_length=5)


class SearchContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    family_id: int | None = None
    initial_query: str | None = Field(default=None, max_length=512)
    turns: list[SearchTurn] = Field(default_factory=list, max_length=6)
    shown_item_ids: list[SearchItemId] = Field(default_factory=list, max_length=500)
    excluded_item_ids: list[SearchItemId] = Field(default_factory=list, max_length=500)
    last_item_ids: list[SearchItemId] = Field(default_factory=list, max_length=5)
    last_status: Literal["found", "multiple", "not_found"] | None = None


class SearchTextRequest(BaseModel):
    family_id: int
    query: str = Field(min_length=1, max_length=512)
    context: dict | None = None


class SearchOut(BaseModel):
    transcript: str | None
    status: str
    prompt: str | None
    items: list[ItemBriefOut]


# ---------- 媒体 ----------
class ImageUploadOut(BaseModel):
    image_url: str
    image_token: str


class TranscribeOut(BaseModel):
    transcript: str
