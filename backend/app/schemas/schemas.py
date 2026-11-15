"""请求 / 响应模型（对应文档 13 章接口字段）。"""
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator
from typing_extensions import Annotated, TypedDict


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


RecordOperation = Literal["create", "delete", "move"]


class ItemRecordRequest(BaseModel):
    """收纳入口的一次描述、选择、补拍或修改。"""

    model_config = ConfigDict(str_strip_whitespace=True)

    family_id: int = Field(gt=0)
    session_id: str | None = Field(default=None, min_length=1, max_length=32)
    event: Literal["start", "reply", "choose_operation", "choose_item", "photo", "revise"]
    transcript: str | None = Field(default=None, min_length=1, max_length=2000)
    operation: RecordOperation | None = None
    target_item_id: int | None = Field(default=None, gt=0, strict=True)
    image_token: str | None = Field(default=None, min_length=1, max_length=2048)

    @model_validator(mode="after")
    def check_event(self) -> "ItemRecordRequest":
        """在请求入口确认输入类型对应的必需字段。"""
        if (self.event == "start") != (self.session_id is None):
            raise ValueError("首次描述不传会话标识，后续输入必须携带会话标识")
        if self.event in ("start", "reply") and not self.transcript:
            raise ValueError("请提供描述文字")
        if self.event == "revise" and not self.transcript and not self.image_token:
            raise ValueError("请填写要补充或修改的内容")
        if (self.event == "choose_operation") != (self.operation is not None):
            raise ValueError("选择操作时必须提供操作类型")
        if (self.event == "choose_item") != (self.target_item_id is not None):
            raise ValueError("选择物品时必须提供物品标识")
        if self.event == "photo" and not self.image_token:
            raise ValueError("请提供照片")
        return self


class RecordDecision(TypedDict):
    """已经解析过的模型判断，供本轮保存和补拍接续使用。"""

    status: Literal["ready", "ask"]
    operation: RecordOperation | None
    target_item_id: int | None
    name: str
    location_text: str
    candidate_item_ids: list[int]
    question_type: Literal["operation", "item", "details"] | None
    prompt: str


class RecordContext(TypedDict):
    """本轮问答、待执行判断、照片和最近保存结果。"""

    turns: list[dict[str, Any]]
    pending: RecordDecision | None
    image_id: int | None
    last_result: dict[str, Any] | None


class RecordItemSnapshot(TypedDict):
    """物品操作前的业务字段，不恢复版本号和更新时间。"""

    id: int
    name: str
    location_text: str
    record_text: str | None
    image_url: str
    status: int
    deleted_at: str | None


class RecordImageSnapshot(TypedDict):
    """图片操作前的绑定及清理状态。"""

    id: int
    bound_item_id: int | None
    delete_state: str
    delete_after: str | None


class RecordUndo(TypedDict):
    """撤回本轮最近保存结果所需的数据。"""

    created_item_id: int | None
    item: RecordItemSnapshot | None
    images: list[RecordImageSnapshot]


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
