"""请求 / 响应模型（对应文档 13 章接口字段）。"""
from datetime import datetime

from pydantic import BaseModel, Field


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


# ---------- 物品 ----------
class ItemOut(BaseModel):
    id: int
    name: str
    location_text: str
    record_text: str | None = None
    image_url: str
    updated_at: datetime


class ItemBriefOut(BaseModel):
    id: int
    name: str
    location_text: str
    image_url: str


class ItemRecordRequest(BaseModel):
    family_id: int
    image_token: str = Field(min_length=1)
    transcript: str = Field(min_length=1)


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
    image_token: str | None = None


# ---------- 查找 ----------
class SearchTextRequest(BaseModel):
    family_id: int
    query: str = Field(min_length=1)
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
