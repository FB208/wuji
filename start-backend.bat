@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0agent"

echo [1/3] 构建内置 Pi Agent...
call npm run build
if errorlevel 1 (
    echo.
    echo Agent 构建失败，请检查 Node.js 版本和 agent 目录依赖
    pause
    exit /b 1
)

cd /d "%~dp0backend"

echo [2/3] 数据库迁移...
.venv\Scripts\alembic.exe upgrade head
if errorlevel 1 (
    echo.
    echo 迁移失败，请检查 .env 中 DATABASE_URL 和数据库连通性
    pause
    exit /b 1
)

echo.
echo [3/3] 启动后端及内置 Agent  http://localhost:8000  ...
.venv\Scripts\uvicorn.exe app.main:app --host 0.0.0.0 --port 8000
pause
