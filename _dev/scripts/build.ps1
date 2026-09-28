param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$devRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Split-Path -Parent $devRoot
$workPath = Join-Path $env:TEMP ('BDOBarterBuild-' + [guid]::NewGuid().ToString('N'))
Push-Location $devRoot
try {
    & $Python -m PyInstaller --clean --noconfirm --distpath $releaseRoot --workpath $workPath (Join-Path $devRoot 'local_app/packaging/bdo-barter.spec')
    if ($LASTEXITCODE -ne 0) { throw '패키지 빌드 실패. 빌드 출력을 확인하세요.' }
    Write-Output (Join-Path $releaseRoot 'app/BDO 물교 실행.exe')
} finally { Pop-Location }
