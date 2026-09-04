@echo off
chcp 65001 >nul
title Aether - 快速启动
cd /d "%~dp0"

echo ========================================
echo   Aether
echo   快速启动模式
echo ========================================
echo.

:: 检查构建是否已经完成
if not exist "src\backend\dist\index.js" (
    echo [提示] 还未构建，请先运行 start.bat 完成首次构建
    echo 或直接运行: npm run build
    pause
    exit /b 1
)

echo 正在启动服务器...
echo.
echo 访问地址: http://127.0.0.1:3000
echo 关闭此窗口停止运行
echo.

call npm run start -w src/backend

echo.
echo [信息] 服务器已停止
pause