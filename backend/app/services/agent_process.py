"""随后端启停的 Pi 子进程，使用 UTF-8 JSON 行协议通信。"""
import asyncio
import json
import logging
import os
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any, Literal

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.logging import get_logger

logger = get_logger(__name__)
agent_logger = get_logger("app.agent")


class AgentProcess:
    """管理一个 Node 子进程及其待完成请求。"""

    def __init__(self) -> None:
        """初始化进程状态；事件循环与就绪信号在启动时创建。"""
        self._process: subprocess.Popen[str] | None = None
        self._reader: threading.Thread | None = None
        self._log_reader: threading.Thread | None = None
        self._ready: asyncio.Future[None] | None = None
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._progress_handlers: dict[str, Callable[[dict], None]] = {}
        self._write_lock = threading.Lock()
        self._error: str | None = "Agent 尚未启动"

    async def start(self) -> None:
        """传入后端统一加载的配置，等待 Pi 初始化完成后再接受业务请求。"""
        settings = get_settings()
        loop = asyncio.get_running_loop()
        self._ready = loop.create_future()
        self._error = None
        self._process = subprocess.Popen(
            ["node", "dist/worker.js"],
            cwd=settings.agent_dir,
            env={
                **os.environ,
                "SEMANTIC_BASE_URL": settings.semantic_base_url,
                "SEMANTIC_MODEL": settings.semantic_model,
                "SEMANTIC_API_KEY": settings.semantic_api_key,
                "AGENT_CONTEXT_WINDOW": str(settings.agent_context_window),
                "AGENT_MAX_TOKENS": str(settings.agent_max_tokens),
                "AGENT_DATA_DIR": settings.agent_data_dir,
            },
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            bufsize=1,
        )
        # 阻塞管道由线程读取，不依赖 Windows 事件循环对异步子进程的支持。
        self._reader = threading.Thread(
            target=self._read_output, args=(self._process, loop), daemon=True,
        )
        self._reader.start()
        self._log_reader = threading.Thread(
            target=self._read_logs, args=(self._process,), daemon=True,
        )
        self._log_reader.start()
        logger.info("Agent 子进程已启动 pid=%s", self._process.pid)
        await self._ready
        logger.info("Agent 子进程已就绪 pid=%s", self._process.pid)

    async def request(
        self, method: Literal["history", "turn", "clear"], params: dict[str, Any],
        *, request_id: str | None = None,
        on_progress: Callable[[dict], None] | None = None,
    ) -> Any:
        """发送内部请求并等待对应响应；模型执行不设置固定总时限。"""
        process = self._process
        if process is None or self._error is not None:
            raise AppError("AGENT_UNAVAILABLE", self._error or "Agent 尚未启动", status_code=503)
        request_id = request_id or uuid.uuid4().hex
        started_at = time.monotonic()
        logger.info("Agent 请求开始 request_id=%s method=%s", request_id, method)
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        if on_progress is not None:
            self._progress_handlers[request_id] = on_progress
        line = json.dumps(
            {"id": request_id, "method": method, "params": params}, ensure_ascii=False,
        ) + "\n"
        try:
            try:
                await asyncio.to_thread(self._write, process, line)
                logger.info("Agent 请求已写入管道 request_id=%s", request_id)
            except (OSError, ValueError) as exc:
                self._fail(f"Agent 管道写入失败：{exc}")
            result = await future
            logger.info(
                "Agent 请求完成 request_id=%s elapsed_ms=%d",
                request_id, (time.monotonic() - started_at) * 1000,
            )
            return result
        finally:
            self._pending.pop(request_id, None)
            self._progress_handlers.pop(request_id, None)
            if not future.done():
                future.cancel()

    def _write(self, process: subprocess.Popen[str], line: str) -> None:
        """在线程中串行写入整条消息，避免大库存阻塞事件循环或多条请求交错。"""
        with self._write_lock:
            process.stdin.write(line)

    def _read_output(
        self, process: subprocess.Popen[str], loop: asyncio.AbstractEventLoop,
    ) -> None:
        """读取完整响应行，将结果和子进程退出通知交回事件循环处理。"""
        try:
            for line in process.stdout:
                response = json.loads(line)
                loop.call_soon_threadsafe(self._receive, response)
            message = f"Agent 子进程已退出（退出码 {process.wait()}），请查看后端日志"
        except (OSError, ValueError) as exc:
            message = f"Agent 管道读取失败：{exc}"
        loop.call_soon_threadsafe(self._fail, message)

    def _read_logs(self, process: subprocess.Popen[str]) -> None:
        """持续消费 stderr；结构化阶段日志及 SDK 原始异常一并写入 app.log。"""
        for line in process.stderr:
            text = line.rstrip("\r\n")
            if not text:
                continue
            prefix, _, message = text.partition(" ")
            if prefix in ("[INFO]", "[ERROR]"):
                level = logging.INFO if prefix == "[INFO]" else logging.ERROR
                agent_logger.log(level, "pid=%s %s", process.pid, message)
            else:
                agent_logger.warning("pid=%s %s", process.pid, text)

    def _receive(self, response: dict[str, Any]) -> None:
        """完成启动握手或指定请求；已取消的请求不再接收结果。"""
        if response["type"] == "ready":
            self._ready.set_result(None)
            return
        future = self._pending.get(response["id"])
        if future is None or future.done():
            return
        if response["type"] == "progress":
            handler = self._progress_handlers.get(response["id"])
            if handler is not None:
                handler(response["progress"])
            return
        if "error" in response:
            error = response["error"]
            future.set_exception(AppError(error["code"], error["message"], status_code=502))
        else:
            future.set_result(response["result"])

    def _fail(self, message: str, level: int = logging.ERROR) -> None:
        """记录进程通信故障并结束所有等待，真实错误直接返回调用方。"""
        if self._error is not None:
            return
        self._error = message
        logger.log(level, "%s pending_requests=%s", message, list(self._pending))
        futures: list[asyncio.Future[Any]] = [*self._pending.values()]
        if self._ready is not None:
            futures.append(self._ready)
        for future in futures:
            if not future.done():
                future.set_exception(AppError("AGENT_UNAVAILABLE", message, status_code=503))

    async def stop(self) -> None:
        """停止子进程并回收读线程与管道，后端关闭后不留下独立 Agent。"""
        process = self._process
        if process is None:
            return
        self._fail("Agent 已停止", logging.INFO)
        if process.poll() is None:
            process.terminate()
        await asyncio.to_thread(process.wait)
        await asyncio.to_thread(self._reader.join)
        await asyncio.to_thread(self._log_reader.join)
        process.stdin.close()
        process.stdout.close()
        process.stderr.close()
        self._process = None


agent_process = AgentProcess()
