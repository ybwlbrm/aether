@echo off
chcp 65001 >nul
title Aether - Dev Mode
cd /d "%~dp0"

echo ========================================
echo   Aether
echo   个人 AI 指挥中心 — 开发模式
echo ========================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [错误] 未找到 Node.js
    pause
    exit /b 1
)

echo [1/3] 安装依赖...
call npm install --no-audit --no-fund
if %ERRORLEVEL% neq 0 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
)
echo      完成

echo [2/3] 构建共享模块...
call npm run build -w src/shared >nul 2>&1
echo      完成

echo.
echo ========================================
echo   开发模式已启动...
echo.
echo   前端: http://127.0.0.1:5173
echo   后端: http://127.0.0.1:3000
echo   API:  http://127.0.0.1:3000/docs
echo.
echo   前端支持热更新，修改代码自动刷新
echo   按 Ctrl+C 停止运行
echo ========================================
echo.

npm run dev