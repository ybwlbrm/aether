# Aether - 启动脚本
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Aether                                ║" -ForegroundColor Cyan
Write-Host "║   个人 AI 工作操作系统                   ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# 切换到项目目录
Set-Location -LiteralPath $PSScriptRoot

# 检查 Node.js
try {
    $nodeVersion = node --version
    Write-Host "✓ Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ 未找到 Node.js，请先安装 https://nodejs.org/" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}

# 检查依赖
if (-not (Test-Path "node_modules")) {
    Write-Host "→ 首次运行，安装依赖..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ 安装失败" -ForegroundColor Red
        Read-Host "按回车退出"
        exit 1
    }
}

# 检查构建
if (-not (Test-Path "src/backend/dist/index.js")) {
    Write-Host "→ 首次运行，构建项目..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ 构建失败" -ForegroundColor Red
        Read-Host "按回车退出"
        exit 1
    }
}

# 杀掉占用端口的旧进程
Write-Host "→ 释放端口 3000..." -ForegroundColor Yellow
# W5-6 修复：统一使用 Get-NetTCPConnection（与 start.bat/run.bat 一致）。
# 原 netstat -ano 的输出格式依赖系统 locale（不同语言 Windows 列顺序不同），易误杀/漏杀。
# 同时不再使用只读自动变量 $pid（当前进程 PID），避免赋值抛异常。
$conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $conns | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 1

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   ✅ 正在启动                          ║" -ForegroundColor Cyan
Write-Host "║                                        ║" -ForegroundColor Cyan
Write-Host "║   打开浏览器访问:                       ║" -ForegroundColor Cyan
Write-Host "║   http://127.0.0.1:3000                ║" -ForegroundColor Cyan
Write-Host "║                                        ║" -ForegroundColor Cyan
Write-Host "║   API 文档:                            ║" -ForegroundColor Cyan
Write-Host "║   http://127.0.0.1:3000/docs           ║" -ForegroundColor Cyan
Write-Host "║                                        ║" -ForegroundColor Cyan
Write-Host "║   关闭此窗口 = 停止服务                ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# 启动服务
npm run start -w src/backend

Write-Host ""
Write-Host "服务已停止" -ForegroundColor Yellow
Read-Host "按回车退出"