param(
    [Parameter(Position = 0)]
    [string]$Account = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SetupScript = Join-Path $ScriptDir "setup.mjs"

if ([string]::IsNullOrWhiteSpace($Account)) {
    $Account = Read-Host "请输入要授权登录的账号 ID (例如 plus-1)"
}

& node $SetupScript --login $Account.Trim()
exit $LASTEXITCODE
