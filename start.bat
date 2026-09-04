@echo off
chcp 65001 >nul
title Aether
cd /d "%~dp0"

echo ========================================
echo   Aether
echo   Starting...
echo ========================================
echo.

:: Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found
    echo Please install from: https://nodejs.org/
    pause
    exit /b 1
)

echo [1/3] Node.js found: 
node --version
echo.

:: Check dependencies
if not exist "node_modules" (
    echo [2/3] Installing dependencies...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] Install failed
        pause
        exit /b 1
    )
)

:: Check build
if not exist "src\backend\dist\index.js" (
    echo [3/3] Building project...
    call npm run build
    if errorlevel 1 (
        echo [ERROR] Build failed
        pause
        exit /b 1
    )
)

:: Kill old process（语言无关：用 PowerShell Get-NetTCPConnection，避免 netstat 输出列随系统语言变化导致 tokens=5 取错）
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }" >nul 2>&1

echo.
echo ========================================
echo   Server starting...
echo   Open: http://127.0.0.1:3000
echo ========================================
echo.

node src/backend/dist/index.js

echo.
echo Server stopped.
pause