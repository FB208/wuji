# 唔叽

微信小程序＋FastAPI＋Pi Agent。物品保存在 MySQL，“找东西”的长期对话保存在 Pi JSONL 会话文件中。

## 本地开发（Windows）

需要 Python 3.12、Node.js 22.19 或更高版本，以及现有 MySQL、图片存储和语音识别服务。

1. 按 `backend/.env.example` 配置 `backend/.env`。
2. 在 `agent` 目录运行 `npm ci` 安装 Agent 依赖。
3. 运行根目录的 `start-backend.bat`，脚本构建 Agent、执行数据库迁移并启动后端（8000）。

后端自动启动和关闭 Node 子进程，使用 UTF-8 JSON 行管道通信。Agent 就绪后后端才开始接收请求，日志输出在同一个终端。配置统一由后端读取 `backend/.env` 并传给子进程：

- `SEMANTIC_BASE_URL`：OpenAI-compatible 地址，包含 `/v1`。
- `SEMANTIC_MODEL`：模型名称，需要支持工具调用。
- `SEMANTIC_API_KEY`：该服务的密钥。
- `AGENT_CONTEXT_WINDOW`：实际模型上下文窗口，默认128000。
- `AGENT_MAX_TOKENS`：最大输出 token，默认8192。
- `AGENT_DATA_DIR`：会话目录，默认是 Agent 运行目录下的 `data`。

本地对话保存在 `agent/data/{user_id}/{family_id}/`。重新启动服务会恢复同一用户、同一家庭的会话。

直接运行 Uvicorn 时，需先在 `agent` 目录执行 `npm run build` 生成子进程入口 `dist/worker.js`。使用一个后端 worker，与现有内存任务机制保持一致。

将 `miniprogram/services/api.js` 顶部的 `API_BASE_URL` 设置为实际后端地址，并在小程序后台配置 request/uploadFile 合法域名。

## 对话接口

- `GET /api/v1/chat/history?family_id=...&before=...`：最近30条展示消息、更早历史游标及 `active_task` 任务快照。
- `POST /api/v1/chat/messages`：提交 `{ family_id, text }`，返回任务编号。
- `DELETE /api/v1/chat/history?family_id=...`：清空当前用户在该家庭的全部聊天记录、AI 上下文和任务快照；生成期间拒绝清空。页面右上角提供“清空对话”入口。
- `GET /api/v1/tasks/{task_id}`：返回任务状态、进度版本 `revision` 和 `{ messages, draft }` 进度快照 `progress`，完成后 `result` 返回本轮完整消息。
- 语音先使用 `/api/v1/speech/transcribe` 转写，再进入同一文字消息链路。

Python 每轮读取当前家庭有效物品，将资料作为 Agent 工具的数据源。Agent 默认查询；需要整体理解时读取全部精简资料；展示照片和位置时调用卡片工具。完整库存不会在每轮自动注入模型。

长期历史由 Pi 保存；前端从原始消息与卡片工具结果恢复，压缩不会删除历史。用户、家庭各自隔离。本次不改变物品表结构。

## 页面与任务性能

AI 回复与生成中的草稿使用 Markdown 富文本展示。解析器由 `tools/markdown` 构建并随小程序源码提供，日常开发直接编译小程序即可；修改解析器时，在该目录执行 `npm ci`、`npm run build` 更新运行文件。

登录初始化在本次小程序运行中共享，并发页面等待同一次请求。家庭或资料变更由操作入口显式刷新；冷启动恢复家庭选择，注销时使初始化状态失效。

“找东西”的导航、登录就绪、历史同步和回复生成独立管理。用户可以先编辑草稿，同一家庭返回时保留已有消息。Agent 文字草稿最多每200毫秒经管道更新一次，模型工具轮次结束时立即交付已落盘消息和卡片；前端每秒串行轮询，只应用版本变化的进度。上翻历史后暂停自动滚动。

任务查询校验访问令牌及任务归属，直接读取内存注册表；账户注销同步清理其任务。`/me` 的家庭展示资料与成员数使用一条聚合查询。

## 部署

后端与 Agent 日志统一写入 `backend/logs/app.log`（容器内 `/srv/wuji/logs/app.log`），同时输出到控制台。聊天任务编号与日志的 `request_id` 相同，`model_call` 表示本轮第几次模型请求。

诊断等待问题时，按顺序查看 `model_request_started`、`model_response_headers`、`model_first_stream_event`、`model_message_completed` 和 `tool_completed`。等待期间每30秒记录 `turn_waiting`，包含当前阶段、累计耗时、距最近活动的时间和已收到的流事件数；异常记录错误与堆栈。

模型 HTTP 请求和流式解析直接交给 SDK，不覆盖全局 fetch、不包装响应流。诊断仅订阅 SDK 阶段事件。

发布工作流只构建 `wuji` 镜像，使用仓库根目录作为构建上下文，Dockerfile 位于 `backend/Dockerfile`。镜像包含 Python 后端、Node 运行时和编译后的 Agent。

Compose 只启动一个 `wuji` 服务，对外提供 8000 端口。部署目录的 `.env` 提供统一配置；镜像内 `AGENT_DIR=/app`、`AGENT_DATA_DIR=/app/data`，`agent-data` 卷挂载到 `/app/data` 保存聊天历史。

发布后的 `release.env` 只记录 `WUJI_IMAGE`。手动启动时加载该文件中的镜像变量。
