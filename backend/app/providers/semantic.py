"""OpenAI-compatible 文本语义服务（附录 A 协议）。

只接收文字和当前家庭组物品文字摘要，不接收图片（文档 10.5 / 14.3）。
"""
import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any, Literal, Optional

import httpx
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictStr, ValidationInfo, model_validator
from typing_extensions import Annotated

from app.core.config import get_settings
from app.core.errors import (
    AppError,
    record_parse_failed,
    semantic_budget_exceeded,
)
from app.core.logging import get_logger
from app.providers.semantic_contracts import (
    RECORD_CANDIDATES_SYSTEM_PROMPT,
    RECORD_SYSTEM_PROMPT,
)

from app.schemas.schemas import RecordContext, RecordOperation

logger = get_logger(__name__)

_FENCE_RE = re.compile(r"^```json\s*\n(?P<body>.*?)\n?```\s*$", re.DOTALL)


def _no_dupes(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    seen: set[str] = set()
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in seen:
            raise ValueError("duplicate key")
        seen.add(key)
        out[key] = value
    return out


def _reject_constant(value: str) -> Any:
    raise ValueError(f"non-finite literal {value}")


def _extract_json(text: str) -> dict[str, Any]:
    body = text.strip()
    match = _FENCE_RE.match(body)
    if match:
        body = match.group("body").strip()
    if not body.startswith("{") or not body.endswith("}"):
        raise ValueError("not a json object")
    parsed = json.loads(body, object_pairs_hook=_no_dupes, parse_constant=_reject_constant)
    if not isinstance(parsed, dict):
        raise ValueError("root is not an object")
    return parsed


def _pos_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("invalid item id")
    return value


PosInt = Annotated[int, BeforeValidator(_pos_int)]


class _StrictBase(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CandidatesOut(_StrictBase):
    item_ids: list[PosInt] = Field(max_length=5)


class RecordJudgeOut(_StrictBase):
    """在模型响应入口解析操作、目标及需要补充的信息。"""

    status: Literal["ready", "ask"]
    operation: RecordOperation | None
    target_item_id: Optional[PosInt]
    name: StrictStr = Field(max_length=128)
    location_text: StrictStr = Field(max_length=255)
    candidate_item_ids: list[PosInt] = Field(max_length=5)
    question_type: Literal["operation", "item", "details"] | None
    prompt: StrictStr

    @model_validator(mode="after")
    def check_decision(self, info: ValidationInfo) -> "RecordJudgeOut":
        """一次检查模型字段关系及本次允许操作的物品范围。"""
        self.name = self.name.strip()
        self.location_text = self.location_text.strip()
        self.prompt = self.prompt.strip()
        allowed = info.context["allowed"]
        referenced = set(self.candidate_item_ids)
        if self.target_item_id is not None:
            referenced.add(self.target_item_id)
        if not referenced <= allowed:
            raise ValueError("物品不在本次候选中")
        selection = info.context["selection"]
        if selection["event"] == "choose_operation" and self.operation != selection["operation"]:
            raise ValueError("不能更改用户选择的操作")
        if selection["event"] == "choose_item" and self.target_item_id != selection["target_item_id"]:
            raise ValueError("不能更改用户选择的物品")
        if self.status == "ask":
            if self.question_type is None or not self.prompt:
                raise ValueError("询问必须包含问题及类型")
        else:
            if self.operation is None or self.question_type is not None or self.prompt:
                raise ValueError("可执行结果必须明确操作")
            if self.operation == "create":
                if not self.name or not self.location_text or self.target_item_id is not None or self.candidate_item_ids:
                    raise ValueError("新增需要名称和位置，不携带已有目标")
            else:
                if self.target_item_id is None or self.candidate_item_ids != [self.target_item_id]:
                    raise ValueError("删除和移位需要一个明确目标")
                if self.operation == "move" and not self.location_text:
                    raise ValueError("移位需要新位置")
        return self


@dataclass
class SemanticBudget:
    max_calls: int
    deadline: float
    used_calls: int = 0

    @classmethod
    def from_settings(cls) -> "SemanticBudget":
        settings = get_settings()
        return cls(
            max_calls=settings.semantic_max_calls,
            deadline=asyncio.get_running_loop().time() + settings.semantic_total_timeout_seconds,
        )

    def reserve(self, count: int) -> None:
        if asyncio.get_running_loop().time() >= self.deadline:
            raise TimeoutError()
        if self.used_calls + count > self.max_calls:
            raise semantic_budget_exceeded()
        self.used_calls += count


def _dedupe(ids: list[int]) -> list[int]:
    seen: set[int] = set()
    out: list[int] = []
    for i in ids:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out


class SemanticProvider:
    def _payload_chars(self, system_prompt: str, payload: dict[str, Any]) -> int:
        return len(system_prompt) + len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    async def _chat(self, system_prompt: str, user_payload: dict[str, Any]) -> dict[str, Any]:
        settings = get_settings()
        if self._payload_chars(system_prompt, user_payload) > settings.semantic_max_input_chars:
            raise semantic_budget_exceeded()
        url = f"{settings.semantic_base_url.rstrip('/')}/chat/completions"
        body = {
            "model": settings.semantic_model,
            "temperature": 0,
            "max_tokens": settings.semantic_max_output_tokens,
            "stream": False,
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": json.dumps(user_payload, ensure_ascii=False, separators=(",", ":")),
                },
            ],
        }
        headers = {"Authorization": f"Bearer {settings.semantic_api_key}"}
        raw = bytearray()
        async with asyncio.timeout(settings.semantic_call_timeout_seconds):
            async with httpx.AsyncClient(timeout=settings.semantic_call_timeout_seconds) as client:
                async with client.stream("POST", url, json=body, headers=headers) as resp:
                    if resp.status_code == 429 or resp.status_code >= 500:
                        raise AppError("SEMANTIC_UNAVAILABLE", "服务暂时不可用，请稍后重试", status_code=503, retryable=True)
                    if resp.status_code >= 400:
                        raise AppError("SEMANTIC_UNAVAILABLE", "服务请求失败", status_code=502, retryable=True)
                    async for chunk in resp.aiter_bytes():
                        if len(raw) + len(chunk) > settings.semantic_max_response_bytes:
                            raise ValueError("response too large")
                        raw.extend(chunk)
        payload = json.loads(bytes(raw).decode("utf-8"))
        content = payload["choices"][0]["message"]["content"]
        if not isinstance(content, str):
            raise ValueError("empty content")
        return _extract_json(content)

    def _summary(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        excerpt = get_settings().semantic_record_excerpt_chars
        return [
            {
                "id": int(i["id"]),
                "name": i["name"],
                "location_text": i["location_text"],
                "record_text": (i["record_text"] or "")[:excerpt],
            }
            for i in items
        ]

    def _plan_batches(
        self,
        system_prompt: str,
        base_payload: dict[str, Any],
        items_key: str,
        items: list[dict[str, Any]],
    ) -> list[list[dict[str, Any]]]:
        settings = get_settings()
        ordered = sorted(items, key=lambda i: i["id"])
        batches: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        for item in ordered:
            if self._payload_chars(
                system_prompt, {**base_payload, items_key: [item]}
            ) > settings.semantic_max_input_chars:
                raise semantic_budget_exceeded()
            candidate = current + [item]
            payload = {**base_payload, items_key: candidate}
            if len(candidate) > settings.semantic_max_batch_items or self._payload_chars(
                system_prompt, payload
            ) > settings.semantic_max_input_chars:
                batches.append(current)
                current = [item]
            else:
                current = candidate
        if current:
            batches.append(current)
        if len(batches) > settings.semantic_max_batches:
            raise semantic_budget_exceeded()
        return batches

    async def _gather_candidates(
        self,
        system_prompt: str,
        base_payload: dict[str, Any],
        items_key: str,
        batches: list[list[dict[str, Any]]],
    ) -> list[int]:
        settings = get_settings()
        semaphore = asyncio.Semaphore(settings.semantic_batch_concurrency)

        async def pick(batch: list[dict[str, Any]]) -> list[int]:
            batch_ids = {i["id"] for i in batch}
            async with semaphore:
                result = await self._chat(system_prompt, {**base_payload, items_key: batch})
            try:
                parsed = CandidatesOut.model_validate(result)
            except Exception as exc:
                raise ValueError("invalid candidates") from exc
            return [i for i in _dedupe(parsed.item_ids) if i in batch_ids]

        tasks = [asyncio.create_task(pick(b)) for b in batches]
        try:
            results = await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        merged: list[int] = []
        for ids in results:
            merged.extend(ids)
        return _dedupe(merged)[:50]

    async def _judge(
        self,
        *,
        candidate_prompt: str,
        final_prompt: str,
        base_payload: dict[str, Any],
        items_key: str,
        items: list[dict[str, Any]],
        budget: SemanticBudget,
    ) -> tuple[dict[str, Any], set[int]]:
        settings = get_settings()
        summary = self._summary(items)

        direct_payload = {**base_payload, items_key: summary}
        if len(summary) <= settings.semantic_max_batch_items and self._payload_chars(
            final_prompt, direct_payload
        ) <= settings.semantic_max_input_chars:
            batches: list[list[dict[str, Any]]] = []
        else:
            batches = self._plan_batches(candidate_prompt, base_payload, items_key, summary)
        budget.reserve(1 + len(batches))

        if batches:
            candidate_ids = await self._gather_candidates(
                candidate_prompt, base_payload, items_key, batches
            )
            by_id = {i["id"]: i for i in summary}
            final_items = [by_id[i] for i in candidate_ids if i in by_id]
        else:
            final_items = summary

        final_payload = {**base_payload, items_key: final_items}
        if self._payload_chars(final_prompt, final_payload) > settings.semantic_max_input_chars:
            raise semantic_budget_exceeded()
        raw = await self._chat(final_prompt, final_payload)
        logger.info("语义判断响应 raw=%s", raw)
        return raw, {i["id"] for i in final_items}

    async def judge_record(
        self,
        transcript: str,
        existing_items: list[dict[str, Any]],
        *,
        context: RecordContext,
        budget: SemanticBudget | None = None,
    ) -> RecordJudgeOut:
        """结合本轮问答判断新增、删除、移位或继续询问。"""
        if budget is None:
            budget = SemanticBudget.from_settings()
        selection = context["turns"][-1]
        if selection["event"] == "choose_item":
            existing_items = [i for i in existing_items if i["id"] == selection["target_item_id"]]
        try:
            async with asyncio.timeout_at(budget.deadline):
                raw, allowed = await self._judge(
                    candidate_prompt=RECORD_CANDIDATES_SYSTEM_PROMPT,
                    final_prompt=RECORD_SYSTEM_PROMPT,
                    base_payload={"transcript": transcript, "context": context},
                    items_key="existing_items",
                    items=existing_items,
                    budget=budget,
                )
            return RecordJudgeOut.model_validate(raw, context={"allowed": allowed, "selection": selection})
        except AppError:
            raise
        except (TimeoutError, httpx.TimeoutException, httpx.HTTPStatusError, httpx.TransportError) as exc:
            logger.error("收纳语义请求失败：%s", type(exc).__name__)
            raise AppError("SEMANTIC_UNAVAILABLE", "服务暂时不可用，请稍后重试", status_code=503, retryable=True) from exc
        except (ValueError, KeyError, TypeError) as exc:
            logger.error("收纳语义解析失败：%s", exc)
            raise record_parse_failed() from exc

semantic_provider = SemanticProvider()
