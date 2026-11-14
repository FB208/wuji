#requires -Version 5.1

# 将同目录部署凭据同步至指定仓库，不依赖调用者的当前目录。
$ErrorActionPreference = 'Stop'
$repository = 'github.com/FB208/wuji'
$envFile = Join-Path $PSScriptRoot '.env.secrets'

if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw '请复制 docker/.env.secrets.example 为 docker/.env.secrets 并填写配置。'
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw '未安装 GitHub CLI，请先执行 winget install GitHub.cli。'
}

try {
    # Windows PowerShell 5.1 会将原生命令的 stderr 包装为错误，使用退出码判断结果。
    $ErrorActionPreference = 'Continue'
    gh auth status --hostname github.com 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'GitHub authentication failed.' }
} catch {
    throw 'GitHub CLI 尚未登录，请先执行 gh auth login --hostname github.com。'
} finally {
    $ErrorActionPreference = 'Stop'
}

Write-Host "正在同步 GitHub Actions Secrets 到 $repository"
try {
    # 由 gh 原生解析 dotenv 文件，隐藏输出以免错误消息带出密钥内容。
    $ErrorActionPreference = 'Continue'
    gh secret set --repo $repository --app actions --env-file $envFile 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Secret synchronization failed.' }
} catch {
    throw '密钥同步失败，请检查配置格式、网络和仓库 Secrets 写入权限；已成功写入的项不会撤销。'
} finally {
    $ErrorActionPreference = 'Stop'
}
Write-Host "同步完成：$repository"
