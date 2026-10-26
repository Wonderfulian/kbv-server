# Deploy kbv-server and check it the way a user would, right after the deploy.
#
# Why the check: twice (revisions 00025 and 00029, 2026-10-23) a fresh
# revision could not reach the Korea Customs Service host while NTS worked,
# and every customs call answered 503 until a new revision was rolled. It has
# only ever happened right after a deploy, so the deploy is where it is
# checked — the same rule as for scheduled jobs: run it once by hand right
# after it is set up. Rolling a revision needs deploy rights, which stay with
# the person running this script and are never given to the running service.
#
# Usage:  powershell -File scripts/deploy.ps1            (deploy, then check)
#         powershell -File scripts/deploy.ps1 -CheckOnly (check the live revision)

param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$Project = 'kbv-server'
$Region = 'asia-northeast3'
$Base = 'https://kbv-server-f7vfitmlkq-du.a.run.app'

function Probe([string]$Label, [string]$Url, [int]$Expect) {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 45
        $code = [int]$r.StatusCode
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    }
    $ok = $code -eq $Expect
    Write-Host ("{0}  {1,-34} HTTP {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $Label, $code))
    return $ok
}

function Check {
    $health = Probe 'health' "$Base/health" 200
    $nts = Probe 'NTS (test number)' "$Base/v1/business/124-81-00998/status" 200
    $customs = Probe 'customs (test HS code)' "$Base/v1/korea-import/requirements?hs_code=8516710000" 200
    return @{ health = $health; nts = $nts; customs = $customs }
}

function Revision {
    return (gcloud run services describe kbv-server --region $Region --project $Project --format='value(status.latestReadyRevisionName)')
}

if (-not $CheckOnly) {
    gcloud run deploy kbv-server --source . --region $Region --project $Project --quiet
    if ($LASTEXITCODE -ne 0) { throw 'deploy failed' }
}

for ($attempt = 0; $attempt -le 2; $attempt++) {
    Write-Host "--- $(Revision)"
    $c = Check
    if ($c.health -and $c.nts -and $c.customs) { Write-Host 'OK: live revision answers NTS and customs.'; exit 0 }
    if (-not $c.health -or -not $c.nts) {
        # Not the known customs-only failure: do not paper over it with a new revision.
        Write-Host 'STOP: health or NTS failed too. Investigate; this is not the customs-egress case.'
        exit 1
    }
    if ($attempt -eq 2) { break }
    # Customs alone fails: the known post-deploy egress case. A new revision (same image) has fixed it each time.
    Write-Host 'customs alone failed: rolling a new revision of the same image'
    gcloud run services update kbv-server --region $Region --project $Project --update-labels "egress-recheck=$(Get-Date -Format yyyyMMddHHmmss)" --quiet
    if ($LASTEXITCODE -ne 0) { throw 'revision roll failed' }
}
Write-Host 'FAIL: customs still unreachable after two fresh revisions. NTS works, so this is beyond the known case; check the customs API status before anything else.'
exit 1
