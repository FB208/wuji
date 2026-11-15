"""OpenAI-compatible 文本语义服务（附录 A 协议）。

只接收文字和当前家庭组物品文字摘要，不接收图片（文档 10.5 / 14.3）。
"""
import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any, Literal, Optional

import httpx
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictStr
from typing_extensions import Annotated

from app.core.config import get_settings
from app.core.errors import (
    AppError,
    record_parse_failed,
    record_unclear,
    search_failed,
    semantic_budget_exceeded,
)
from app.core.logging import get_logger
from app.providers.semantic_contracts import (
    RECORD_CANDIDATES_SYSTEM_PROMPT,
    RECORD_SYSTEM_PROMPT,
    SEARCH_CANDIDATES_SYSTEM_PROMPT,
    SEARCH_SYSTEM_PROMPT,
)

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
    operation: Literal["create", "move", "delete", "confirm"]
    action: Optional[Literal["move", "delete"]] = None
    target_item_id: Optional[PosInt]
    name: StrictStr = Field(max_length=128)
    location_text: StrictStr = Field(max_length=255)
    candidate_item_ids: list[PosInt] = Field(max_length=5)


class SearchJudgeOut(_StrictBase):
    status: Literal["found", "multiple", "not_found"]
    item_ids: list[PosInt] = Field(max_length=5)
    prompt: Optional[StrictStr]


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
        budget: SemanticBudget | None = None,
    ) -> dict[str, Any]:
        """入库判断（附录 A.1 / A.2）：返回 operation、target_item_id、name、location_text。"""
        if budget is None:
            budget = SemanticBudget.from_settings()
        try:
            async with asyncio.timeout_at(budget.deadline):
                raw, allowed = await self._judge(
                    candidate_prompt=RECORD_CANDIDATES_SYSTEM_PROMPT,
                    final_prompt=RECORD_SYSTEM_PROMPT,
                    base_payload={"transcript": transcript},
                    items_key="existing_items",
                    items=existing_items,
                    budget=budget,
                )
            result = RecordJudgeOut.model_validate(raw)
        except AppError:
            raise
        except TimeoutError as exc:
            logger.error("入库语义判断超时：%s", type(exc).__name__)
            raise AppError("SEMANTIC_UNAVAILABLE", "服务暂时不可用，请稍后重试", status_code=503, retryable=True) from exc
        except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.TransportError) as exc:
            logger.error("入库语义请求失败：%s", type(exc).__name__)
            raise AppError("SEMANTIC_UNAVAILABLE", "服务暂时不可用，请稍后重试", status_code=503, retryable=True) from exc
        except Exception as exc:
            logger.error("入库语义解析失败：%s", type(exc).__name__)
            raise record_parse_failed() from exc

        op = result.operation
        candidates = _dedupe(result.candidate_item_ids)
        logger.info(
            "入库判断 transcript=%r operation=%s action=%s name=%r location=%r",
            transcript, op, result.action, result.name, result.location_text,
        )
        # 描述信息不足（如与收纳无关的内容）是 LLM 的合法响应，单独成码区别于契约违规。
        # create 要求名称+位置；move 要求新位置（名称可空保留原名）；delete/confirm 不要求文字字段。
        if (op in ("create", "move") and not result.location_text.strip()) or (
            op == "create" and not result.name.strip()
        ):
            logger.warning("描述信息不足 transcript=%r raw=%s", transcript, raw)
            raise record_unclear()
        if op != "confirm" and result.action is not None:
            logger.warning("入库判断被拒：非 confirm 携带 action raw=%s", raw)
            raise record_parse_failed()
        out: dict[str, Any] | None = None
        if op == "create":
            if result.target_item_id is not None or candidates:
                logger.warning("入库判断被拒：create 却携带 target/candidates raw=%s", raw)
                raise record_parse_failed()
            out = {
                "operation": "create",
                "action": None,
                "target_item_id": None,
                "name": result.name.strip(),
                "location_text": result.location_text.strip(),
                "candidate_item_ids": [],
            }
        elif op == "move":
            if result.target_item_id is None or candidates != [result.target_item_id]:
                logger.warning("入库判断被拒：move 目标与候选不一致 raw=%s", raw)
                raise record_parse_failed()
            if result.target_item_id not in allowed:
                out = {
                    "operation": "create",
                    "action": None,
                    "target_item_id": None,
                    "name": result.name.strip(),
                    "location_text": result.location_text.strip(),
                    "candidate_item_ids": [],
                }
            else:
                out = {
                    "operation": "move",
                    "action": None,
                    "target_item_id": result.target_item_id,
                    "name": result.name.strip(),
                    "location_text": result.location_text.strip(),
                    "candidate_item_ids": [result.target_item_id],
                }
        elif op == "delete":
            if result.target_item_id is None or candidates != [result.target_item_id]:
                logger.warning("入库判断被拒：delete 目标与候选不一致 raw=%s", raw)
                raise record_parse_failed()
            if result.target_item_id not in allowed:
                logger.warning("入库判断被拒：delete 目标不在候选集 raw=%s", raw)
                raise record_parse_failed()
            out = {
                "operation": "delete",
                "action": None,
                "target_item_id": result.target_item_id,
                "name": result.name.strip(),
                "location_text": result.location_text.strip(),
                "candidate_item_ids": [result.target_item_id],
            }
        elif op == "confirm":
            if result.target_item_id is not None:
                logger.warning("入库判断被拒：confirm 携带 target raw=%s", raw)
                raise record_parse_failed()
            valid = [i for i in candidates if i in allowed]
            if not valid:
                logger.warning("入库判断被拒：confirm 候选为空或出界 raw=%s", raw)
                raise record_parse_failed()
            out = {
                "operation": "confirm",
                "action": result.action,
                "target_item_id": None,
                "name": result.name.strip(),
                "location_text": result.location_text.strip(),
                "candidate_item_ids": valid,
            }
        if out is None:
            raise record_parse_failed()
        return out

    async def search_items(
        self,
        query: str,
        context: dict[str, Any],
        items: list[dict[str, Any]],
        *,
        budget: SemanticBudget | None = None,
    ) -> dict[str, Any]:
        """查找判断（附录 A.3 / A.4）：返回 status、item_ids、prompt。"""
        if budget is None:
            budget = SemanticBudget.from_settings()
        try:
            async with asyncio.timeout_at(budget.deadline):
                raw, allowed = await self._judge(
                    candidate_prompt=SEARCH_CANDIDATES_SYSTEM_PROMPT,
                    final_prompt=SEARCH_SYSTEM_PROMPT,
                    base_payload={"query": query, "context": context},
                    items_key="items",
                    items=items,
                    budget=budget,
                )
            result = SearchJudgeOut.model_validate(raw)
        except AppError:
            raise
        except TimeoutError as exc:
            logger.error("查找语义判断超时：%s", type(exc).__name__)
            raise search_failed() from exc
        except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.TransportError) as exc:
            logger.error("查找语义请求失败：%s", type(exc).__name__)
            raise search_failed() from exc
        except Exception as exc:
            logger.error("查找语义解析失败：%s", type(exc).__name__)
            raise search_failed() from exc

        if result.status == "found" and len(result.item_ids) != 1:
            raise search_failed()
        ids = _dedupe(result.item_ids)
        status = result.status
        if (status == "found" and len(ids) != 1) or (
            status == "multiple" and not (2 <= len(ids) <= 5)
        ) or (status == "not_found" and ids):
            raise search_failed()
        filtered = [i for i in ids if i in allowed]
        if not filtered:
            return {"status": "not_found", "item_ids": [], "prompt": result.prompt}
        if len(filtered) == 1:
            return {"status": "found", "item_ids": filtered, "prompt": None}
        return {"status": "multiple", "item_ids": filtered[:5], "prompt": result.prompt}


semantic_provider = SemanticProvider()
