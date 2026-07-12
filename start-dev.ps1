# AgentCore 一键启动本地开发环境（基础设施 + 后端 + 桌面前端）。
# 用法：双击同目录的 start-dev.cmd；或在 PowerShell 里执行本脚本。
# 后端与前端各自在独立窗口运行，关闭对应窗口即停止；基础设施容器随 Docker 常驻。
# 两端输出同时写入 logs\dev-backend.log / logs\dev-frontend.log，便于让 AI 读取排查。
$root = $PSScriptRoot
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

Write-Host "==> [1/3] 启动基础设施容器 (PostgreSQL / Redis / SearXNG)..." -ForegroundColor Cyan
docker start agentcore-postgres agentcore-redis agentcore-searxng
if ($LASTEXITCODE -ne 0) {
    Write-Host "!! 容器启动失败，请先确认 Docker Desktop 已运行。" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}

Write-Host "    等待 PostgreSQL 可接受连接..." -ForegroundColor Cyan
for ($i = 0; $i -lt 30; $i++) {
    docker exec agentcore-postgres pg_isready -U agentcore -d agentcore 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 1
}
Write-Host "    PostgreSQL 已就绪。" -ForegroundColor Green

Write-Host "==> [2/3] 启动后端 (新窗口, http://localhost:8000)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$root\apps\server'; uv run python -m agentcore 2>&1 | Tee-Object -FilePath '$logDir\dev-backend.log'"

Write-Host "==> [3/3] 启动桌面前端 (新窗口, 应用稍后弹出)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$root\apps\desktop'; pnpm dev 2>&1 | Tee-Object -FilePath '$logDir\dev-frontend.log'"

Write-Host ""
Write-Host "全部已启动。后端 http://localhost:8000；前端 Electron 窗口稍后弹出。" -ForegroundColor Green
Write-Host "提示：关闭某个新窗口即停止对应服务。" -ForegroundColor DarkGray
Write-Host "日志：logs\dev-backend.log 与 logs\dev-frontend.log（出问题可让 AI 读取排查）。" -ForegroundColor DarkGray
Start-Sleep -Seconds 4
