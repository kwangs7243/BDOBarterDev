$ErrorActionPreference = 'Stop'
$devPath = Split-Path -Parent $PSScriptRoot
$evidencePath = Join-Path $devPath 'specs/007-feature-restoration/evidence'
New-Item -ItemType Directory -Force -Path $evidencePath | Out-Null
Push-Location $devPath
try {
    $names = @('regression_core', 'followup_regression', 'regression_modes', 'inventory_completion_diagnostics', 'tier7_completion_regression', 'completion_no_hold_regression', 'tier7_threshold_diagnostics', 'scenario_matrix', 'scheduler_preservation_regression')
    foreach ($name in $names) {
        & node "tests/$name.js" --json-out "$evidencePath/$name.json" *> "$evidencePath/$name.log"
        if ($LASTEXITCODE -ne 0) { throw "$name regression failed" }
        Write-Output "$name PASS"
    }
} finally { Pop-Location }
