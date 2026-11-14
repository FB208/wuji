@echo off
chcp 65001 >nul
cd /d "%~dp0backend"

echo [1/2] 数据库迁移...
.venv\Scripts\alembic.exe upgrade head
if errorlevel 1 (
    echo.
    echo 迁移失败，请检查 .env 中 DATABASE_URL 和数据库连通性
    pause
    exit /b 1
)

echo.
echo [2/2] 启动后端服务  http://localhost:8000  ...
.venv\Scripts\uvicorn.exe app.main:app --host 0.0.0.0 --port 8000
pause
