param([string]$Python = 'python', [string]$OutputRoot = (Join-Path $env:TEMP 'bdo-package-release'))
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $projectRoot
try {
    & $Python -B -m PyInstaller --clean --noconfirm --distpath (Join-Path $OutputRoot 'dist') --workpath (Join-Path $OutputRoot 'build') (Join-Path $PSScriptRoot 'bdo-suite.spec')
    if ($LASTEXITCODE -ne 0) { throw 'Package build failed.' }
    Write-Output (Join-Path $OutputRoot 'dist/app/BDO 실행.exe')
} finally { Pop-Location }
