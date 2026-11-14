FROM python:3.12-slim

WORKDIR /srv/wuji

# 依赖使用 uv 编译的带哈希锁定文件，构建结果可复现
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app

EXPOSE 8000
# 用 python -m 启动，使工作目录进入 sys.path：
# 1) app 从 /srv/wuji/app 源码导入；2) check_migration 能找到 /srv/wuji/alembic
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
