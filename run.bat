@echo off
chcp 65001 >nul
title Aether - Quick Start
cd /d "%~dp0"

:: Node.js 检查优先（若未安装，后续构建检查给出的错误提示会误导用户）
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
)

if not exist "src\backend\dist\index.js" (
    echo [ERROR] Project not built yet.
    echo Run start.bat first to build the project.
    pause
    exit /b 1
)

:: Kill old process（语言无关：用 PowerShell，避免 netstat 输出列随系统语言变化导致 tokens=5 取错）
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }" >nul 2>&1

echo Starting server...
echo Open: http://127.0.0.1:3000
echo Close this window to stop
echo.

node src/backend/dist/index.js

echo.
echo Server stopped.
pause