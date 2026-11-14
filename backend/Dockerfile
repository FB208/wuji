FROM python:3.12-slim

WORKDIR /srv/wuji

# 依赖使用 uv 编译的带哈希锁定文件，构建结果可复现
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY start.sh ./
# Windows 检出为 CRLF 时仍可在 Linux 容器中启动
RUN sed -i 's/\r$//' start.sh

EXPOSE 8000
# python -m 使 /srv/wuji 进入 sys.path：app 从源码导入，check_migration 能找到 alembic/
ENTRYPOINT ["/bin/bash", "/srv/wuji/start.sh"]
