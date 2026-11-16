"""聊天公共入口的数据约定，内部调用不再重复校验。"""
from typing import TypedDict

from pydantic import BaseModel, ConfigDict, Field


class ChatMessageRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    family_id: int = Field(gt=0)
    text: str = Field(min_length=1, max_length=2000)


class InventoryItem(TypedDict):
    id: int
    name: str
    location_text: str
    record_text: str
    image_url: str
