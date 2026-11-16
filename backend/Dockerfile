FROM node:22-bookworm-slim AS agent-build
WORKDIR /app
COPY agent/package.json agent/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY agent/tsconfig.json ./
COPY agent/src ./src
RUN npm run build && npm prune --omit=dev

FROM python:3.12-slim-bookworm

WORKDIR /srv/wuji

# Python 与 Node 使用同一 Debian 基础版本，最终镜像只携带 Node 运行时。
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=agent-build /usr/local/bin/node /usr/local/bin/node
COPY --from=agent-build /app/package.json /app/package.json
COPY --from=agent-build /app/node_modules /app/node_modules
COPY --from=agent-build /app/dist /app/dist
ENV AGENT_DIR=/app \
    AGENT_DATA_DIR=/app/data \
    PYTHONUTF8=1 \
    PYTHONUNBUFFERED=1

# 依赖使用 uv 编译的带哈希锁定文件，构建结果可复现
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/alembic.ini ./
COPY backend/alembic ./alembic
COPY backend/app ./app
COPY backend/start.sh ./
# Windows 检出为 CRLF 时仍可在 Linux 容器中启动
RUN sed -i 's/\r$//' start.sh

EXPOSE 8000
# python -m 使 /srv/wuji 进入 sys.path：app 从源码导入，check_migration 能找到 alembic/
ENTRYPOINT ["/bin/bash", "/srv/wuji/start.sh"]
