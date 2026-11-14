"""日志配置。控制台与文件双输出；不记录录音、图片二进制和第三方密钥（文档 14.2）。"""
import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

# backend/logs/app.log（logging.py 位于 backend/app/core/）
LOG_FILE = Path(__file__).resolve().parents[2] / "logs" / "app.log"

_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"


def setup_logging(level: str = "INFO") -> None:
    formatter = logging.Formatter(_FORMAT)

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    file_handler = RotatingFileHandler(
        LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(level)
    root.handlers = [console, file_handler]
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
