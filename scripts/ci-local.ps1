# ci-local.ps1 — rejoue la CI GitHub Actions en local (push-green-first).
#
# MIROIR de .github/workflows/ci.yml (la source de verite reste le .yml ;
# si tu changes une etape la-bas, reporte-la ici). A lancer AVANT de pousser
# pour ne pas bruler de minutes GitHub Actions sur des runs rouges.
#
#   powershell -File scripts/ci-local.ps1            # typecheck + build + test
#   powershell -File scripts/ci-local.ps1 -SkipTest  # iteration rapide (sans jest)
#
# Differe du .yml sur un seul point : pas de `npm ci` (reinstall destructive
# des node_modules locaux). On suppose les deps deja installees ; lance
# `npm ci` toi-meme si package-lock a change.

param([switch]$SkipTest)

$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $repo

$script:failed = @()

function Invoke-Step([string]$name, [scriptblock]$action) {
  Write-Host "`n=== [$name] ===" -ForegroundColor Cyan
  & $action
  if ($LASTEXITCODE -ne 0) {
    $script:failed += $name
    Write-Host "[$name] FAIL (exit $LASTEXITCODE)" -ForegroundColor Red
  } else {
    Write-Host "[$name] PASS" -ForegroundColor Green
  }
}

Invoke-Step 'typecheck' { npm run typecheck }
Invoke-Step 'build'     { npm run build }
if (-not $SkipTest) { Invoke-Step 'test' { npm run test:ci } }

Write-Host ""
if ($script:failed.Count -gt 0) {
  Write-Host ("CI LOCAL : ROUGE - echec sur : " + ($script:failed -join ', ') + ". Ne pousse pas.") -ForegroundColor Red
  exit 1
}
Write-Host "CI LOCAL : VERT - sur de pousser." -ForegroundColor Green
exit 0
