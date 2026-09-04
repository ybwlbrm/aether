@echo off
chcp 65001 >nul
title Aether - 打包工具
cd /d "%~dp0"

echo ╔══════════════════════════════════════════╗
echo ║   Aether                                ║
echo ║   一键打包工具                          ║
echo ╚══════════════════════════════════════════╝
echo.
echo 请选择打包方式：
echo.
echo  [1] 版本 A - Localhost 版（浏览器访问）
echo      生成 start.bat + start_dev.bat
echo.
echo  [2] 版本 B - EXE 桌面版（独立窗口）
echo      生成 dist_exe\ 目录下的 EXE 应用
echo      总大小约 350MB
echo.
echo  [3] 两个版本都打包
echo.

set /p choice="请输入数字 (1/2/3): "

if "%choice%"=="1" goto localhost
if "%choice%"=="2" goto exe
if "%choice%"=="3" goto both
echo 无效输入，退出。
pause
exit /b

:localhost
echo.
echo [版本 A] 准备 Localhost 版...
echo.
echo 文件已就绪，可直接使用：
echo   start.bat        - 一键启动
echo   start_dev.bat    - 开发模式
echo.
echo 启动方式: 双击 start.bat
echo 访问地址: http://127.0.0.1:3000
echo.
pause
exit /b

:exe
echo.
echo [版本 B] 打包 EXE 桌面版...
echo.
echo 正在构建... 这可能需要 2-5 分钟
echo.
call npm run build:exe
if %ERRORLEVEL% neq 0 (
    echo [错误] 打包失败
    pause
    exit /b 1
)
echo.
echo ✅ 打包成功!
echo.
echo 输出目录: %~dp0dist_exe
echo 启动文件: %~dp0dist_exe\启动应用.bat
echo 主程序:  %~dp0dist_exe\app\Aether.exe
echo.
echo 直接双击 "启动应用.bat" 即可运行
echo.
pause
exit /b

:both
echo.
echo [版本 A+B] 同时准备两个版本...
echo.
echo 版本 A 文件已就绪:
echo   start.bat
echo   start_dev.bat
echo.
echo 开始打包版本 B...
echo.
call npm run build:exe
if %ERRORLEVEL% neq 0 (
    echo [错误] 打包失败
    pause
    exit /b 1
)
echo.
echo ✅ 两个版本均已就绪!
echo.
echo 版本 A - Localhost 版:
echo   启动: 双击 start.bat
echo   访问: http://127.0.0.1:3000
echo.
echo 版本 B - EXE 桌面版:
echo   目录: %~dp0dist_exe
echo   启动: %~dp0dist_exe\启动应用.bat
echo.
pause
exit /b