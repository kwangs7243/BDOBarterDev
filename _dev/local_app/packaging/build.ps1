param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$devRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$appRoot = Join-Path $devRoot 'local_app'
Push-Location $devRoot
try {
    & $Python -B -m PyInstaller --clean --noconfirm --distpath (Join-Path $appRoot 'dist') --workpath (Join-Path $appRoot 'build') (Join-Path $PSScriptRoot 'bdo-barter.spec')
    if ($LASTEXITCODE -ne 0) { throw 'Package build failed.' }
    Write-Output (Join-Path $appRoot 'dist/app/BDO 물교 실행.exe')
} finally { Pop-Location }
