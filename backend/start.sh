#!/bin/bash
set -e

# 启动前先把数据库迁移到 head，再由应用 check_migration 复核版本一致
python -m alembic upgrade head

exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
