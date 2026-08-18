```
# 启动后端
backend\.venv\Scripts\uvicorn app.main:app

把 miniprogram/services/api.ts 顶部的 API_BASE_URL 改成你的后端正式域名，并在小程序后台配置 request/uploadFile 合法域名。
```