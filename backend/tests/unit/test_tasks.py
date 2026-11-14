"""任务注册表：创建、阶段推进、幂等去重、归属校验、失败序列化、TTL 清理。"""
import time

import pytest

from app.core.errors import AppError
from app.services import tasks


@pytest.fixture(autouse=True)
def clean_registry():
    tasks._tasks.clear()
    tasks._by_idem.clear()
    yield
    tasks._tasks.clear()
    tasks._by_idem.clear()


def test_create_and_stage_flow():
    t = tasks.create("speech", user_id=1)
    assert tasks.get(t.id, 1) is t
    tasks.set_stage(t.id, "asr_polling", "3")
    assert t.stage == "asr_polling"
    assert t.detail == "3"
    tasks.finish(t.id, {"transcript": "x"})
    assert t.done and t.result == {"transcript": "x"}
    # 完成后不再接受阶段推进
    tasks.set_stage(t.id, "asr_polling", "9")
    assert t.stage == "done"


def test_ownership_scoped():
    t = tasks.create("record", user_id=1)
    assert tasks.get(t.id, 2) is None
    assert tasks.get("nonexistent", 1) is None


def test_idem_dedup_only_inflight():
    t = tasks.create("record", user_id=1, idem_key="k1")
    assert tasks.find_by_idem(1, "k1") is t
    assert tasks.find_by_idem(2, "k1") is None
    tasks.finish(t.id, {})
    assert tasks.find_by_idem(1, "k1") is None  # 已完成任务不去重，允许幂等重放


def test_fail_serialization():
    t = tasks.create("speech", user_id=1)
    tasks.fail(t.id, AppError("RECORD_UNCLEAR", "没说清", status_code=422, retryable=False))
    assert t.done and t.stage == "failed"
    assert t.error == {"code": "RECORD_UNCLEAR", "message": "没说清", "retryable": False}

    t2 = tasks.create("speech", user_id=1)
    tasks.fail(t2.id, RuntimeError("boom"))
    assert t2.error["code"] == "TASK_FAILED"
    assert t2.error["retryable"] is True


def test_ttl_cleanup():
    old = tasks.create("speech", user_id=1, idem_key="old")
    old.created_at = time.time() - tasks._TTL_SECONDS - 1
    tasks.create("speech", user_id=1)  # 触发惰性清理
    assert tasks.get(old.id, 1) is None
    assert tasks.find_by_idem(1, "old") is None
