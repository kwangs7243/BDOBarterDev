param([string]$Python = 'python', [string]$OutputRoot = (Join-Path $env:TEMP 'bdo-package-release'))
$ErrorActionPreference = 'Stop'
$devRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $devRoot
try {
    & $Python -B -m PyInstaller --clean --noconfirm --distpath (Join-Path $OutputRoot 'dist') --workpath (Join-Path $OutputRoot 'build') (Join-Path $PSScriptRoot 'bdo-barter.spec')
    if ($LASTEXITCODE -ne 0) { throw 'Package build failed.' }
    Write-Output (Join-Path $OutputRoot 'dist/app/BDO 물교 실행.exe')
} finally { Pop-Location }
