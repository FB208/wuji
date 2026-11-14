"""任务进度注册表：长耗时接口任务化，前端轮询 GET /tasks/{id} 取阶段。

单进程内存实现：请求内创建任务、后台协程推进 stage、TTL 后惰性清理。
任务归属 user_id；幂等键用于去重（重复提交返回进行中的同一任务）。
"""
import time
import uuid
from dataclasses import dataclass, field

from app.core.errors import AppError

_TTL_SECONDS = 600.0


@dataclass
class Task:
    id: str
    kind: str
    user_id: int
    stage: str = "queued"
    detail: str = ""
    done: bool = False
    result: dict | None = None
    error: dict | None = None
    idem_key: str | None = None
    created_at: float = field(default_factory=time.time)


_tasks: dict[str, Task] = {}
_by_idem: dict[tuple[int, str], str] = {}


def _cleanup() -> None:
    now = time.time()
    stale = [tid for tid, t in _tasks.items() if now - t.created_at > _TTL_SECONDS]
    for tid in stale:
        t = _tasks.pop(tid, None)
        if t is not None and t.idem_key:
            _by_idem.pop((t.user_id, t.idem_key), None)


def create(kind: str, user_id: int, *, idem_key: str | None = None) -> Task:
    _cleanup()
    task = Task(id=uuid.uuid4().hex, kind=kind, user_id=user_id, idem_key=idem_key)
    _tasks[task.id] = task
    if idem_key:
        _by_idem[(user_id, idem_key)] = task.id
    return task


def find_by_idem(user_id: int, idem_key: str) -> Task | None:
    tid = _by_idem.get((user_id, idem_key))
    task = _tasks.get(tid) if tid else None
    if task is None or task.done:
        return None
    return task


def get(task_id: str, user_id: int) -> Task | None:
    task = _tasks.get(task_id)
    if task is None or task.user_id != user_id:
        return None
    return task


def set_stage(task_id: str, stage: str, detail: str = "") -> None:
    task = _tasks.get(task_id)
    if task is not None and not task.done:
        task.stage = stage
        task.detail = detail


def finish(task_id: str, result: dict) -> None:
    task = _tasks.get(task_id)
    if task is not None:
        task.stage = "done"
        task.detail = ""
        task.done = True
        task.result = result


def fail(task_id: str, err: BaseException) -> None:
    task = _tasks.get(task_id)
    if task is None:
        return
    task.stage = "failed"
    task.done = True
    if isinstance(err, AppError):
        task.error = {"code": err.code, "message": err.message, "retryable": err.retryable}
    else:
        task.error = {"code": "TASK_FAILED", "message": "处理失败，请重试", "retryable": True}
