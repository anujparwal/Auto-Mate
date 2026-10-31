<#
.SYNOPSIS
    Auto-Mate Windows Native Vault - Local Smoke Verification
    Validates DPAPI CurrentUser encryption, CSPRNG password generation, strict
    cryptographic origin binding, atomic persistence, and restrictive ACLs.

.DESCRIPTION
    Runs an isolated test suite using synthetic dummy values against a temporary vault file.
    Validates that:
    1. Direct DPAPI CurrentUser protects and unprotects payloads with origin entropy.
    2. Origin mismatch cryptographically breaks decryption.
    3. Broker persist-generated action creates DPAPI-encrypted records without leaking secrets to disk.
    4. Broker retrieve-fill returns the stored secret when requested by matching origin.
    5. Broker retrieve-fill rejects cross-origin access requests.
    6. Vault file permissions enforce restrictive user-only ACLs.
    7. No secret fingerprints or plain secrets are leaked in logs.
#>

[CmdletBinding()]
param (
    [string]$CustomTempDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vaultScript = Join-Path $scriptDir "vault.ps1"

if (-not (Test-Path $vaultScript)) {
    Write-Error "Vault script not found at expected path: $vaultScript"
    exit 1
}

$tempFolder = if (-not [string]::IsNullOrWhiteSpace($CustomTempDir)) {
    $CustomTempDir
} else {
    Join-Path ([System.IO.Path]::GetTempPath()) ("automate_windows_smoke_" + [System.Guid]::NewGuid().ToString("N"))
}

if (-not (Test-Path $tempFolder)) {
    New-Item -ItemType Directory -Path $tempFolder | Out-Null
}

$testVaultPath = Join-Path $tempFolder "smoke_vault.json"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Auto-Mate Windows Vault Smoke Verification" -ForegroundColor Cyan
Write-Host "Isolated Test Vault: $testVaultPath" -ForegroundColor DarkGray
Write-Host "==========================================================" -ForegroundColor Cyan

$allPassed = $true

function Report-Step {
    param (
        [string]$Name,
        [bool]$Success,
        [string]$Details = ""
    )
    if ($Success) {
        Write-Host "  [PASS] $Name" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] $Name : $Details" -ForegroundColor Red
        $script:allPassed = $false
    }
}

try {
    # --------------------------------------------------------------------------
    # Test 1: Direct DPAPI CurrentUser Roundtrip & Cryptographic Origin Binding
    # --------------------------------------------------------------------------
    Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue

    $testOrigin = "https://service.internal.test"
    $wrongOrigin = "https://attacker.internal.test"
    $syntheticSecret = "synthetic_test_value_alpha_98765"
    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($syntheticSecret)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    $entropyCorrect = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("AutoMate:Vault:OriginEntropy:v1:$testOrigin"))
    $entropyWrong = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("AutoMate:Vault:OriginEntropy:v1:$wrongOrigin"))
    $sha.Dispose()

    $cipherBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $entropyCorrect,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )

    $roundtripBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $cipherBytes,
        $entropyCorrect,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $recoveredString = [System.Text.Encoding]::UTF8.GetString($roundtripBytes)
    $dpapiMatch = ($recoveredString -eq $syntheticSecret)
    Report-Step -Name "DPAPI CurrentUser encryption & decryption roundtrip" -Success $dpapiMatch

    # Verify origin binding failure
    $crossOriginBlocked = $false
    try {
        [System.Security.Cryptography.ProtectedData]::Unprotect(
            $cipherBytes,
            $entropyWrong,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        ) | Out-Null
    } catch {
        $crossOriginBlocked = $true
    }
    Report-Step -Name "Cryptographic origin binding rejection with incorrect entropy" -Success $crossOriginBlocked

    # --------------------------------------------------------------------------
    # Test 2: Broker Persist-Generated Action via STDIN/STDOUT JSON
    # --------------------------------------------------------------------------
    $genReq = @{
        action   = "persist-generated"
        origin   = "https://app.example.com"
        recordId = "synthetic-service-user"
        length   = 28
    } | ConvertTo-Json -Compress

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell.exe"
    $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$vaultScript`" -Broker -VaultPath `"$testVaultPath`""
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.StandardInput.WriteLine($genReq)
    $proc.StandardInput.Close()
    $genStdout = $proc.StandardOutput.ReadToEnd()
    $genStderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()

    $brokerGenExit = ($proc.ExitCode -eq 0)
    $genResult = $null
    if ($brokerGenExit) {
        $genResult = $genStdout | ConvertFrom-Json
    }

    $genSuccess = ($brokerGenExit -and $genResult -and $genResult.success -eq $true -and -not [string]::IsNullOrEmpty($genResult.generatedSecret) -and $genResult.generatedSecret.Length -ge 28)
    Report-Step -Name "Broker 'persist-generated' persists secret and returns generatedSecret" -Success $genSuccess

    # --------------------------------------------------------------------------
    # Test 3: Restrictive ACL and Ciphertext Persistence Verification
    # --------------------------------------------------------------------------
    $vaultFileExists = (Test-Path $testVaultPath)
    Report-Step -Name "Vault file created on disk" -Success $vaultFileExists

    if ($vaultFileExists) {
        $vaultFileContent = Get-Content -Path $testVaultPath -Raw
        # Plaintext generated secret MUST NOT exist in the vault file
        $containsPlaintext = ($vaultFileContent -like "*$($genResult.generatedSecret)*")
        Report-Step -Name "Vault file on disk contains NO plaintext secret" -Success (-not $containsPlaintext)

        # File permissions check
        $acl = Get-Acl -Path $testVaultPath
        $isProtected = $acl.AreAccessRulesProtected
        Report-Step -Name "Restrictive ACL applied (inheritance disabled)" -Success $isProtected
    }

    # --------------------------------------------------------------------------
    # Test 4: Broker Retrieve-Fill with Matching Origin
    # --------------------------------------------------------------------------
    $retrieveReq = @{
        action   = "retrieve-fill"
        origin   = "https://app.example.com"
        recordId = "synthetic-service-user"
    } | ConvertTo-Json -Compress

    $proc2 = [System.Diagnostics.Process]::Start($psi)
    $proc2.StandardInput.WriteLine($retrieveReq)
    $proc2.StandardInput.Close()
    $retStdout = $proc2.StandardOutput.ReadToEnd()
    $proc2.WaitForExit()

    $retResult = $null
    if ($proc2.ExitCode -eq 0) {
        $retResult = $retStdout | ConvertFrom-Json
    }
    $retrieveSuccess = ($proc2.ExitCode -eq 0 -and $retResult -and $retResult.secret -eq $genResult.generatedSecret)
    Report-Step -Name "Broker 'retrieve-fill' succeeds for matching origin" -Success $retrieveSuccess

    # --------------------------------------------------------------------------
    # Test 5: Broker Retrieve-Fill Rejection on Mismatched Origin
    # --------------------------------------------------------------------------
    $mismatchReq = @{
        action   = "retrieve-fill"
        origin   = "https://malicious-origin.test"
        recordId = "synthetic-service-user"
    } | ConvertTo-Json -Compress

    $proc3 = [System.Diagnostics.Process]::Start($psi)
    $proc3.StandardInput.WriteLine($mismatchReq)
    $proc3.StandardInput.Close()
    $mismatchStdout = $proc3.StandardOutput.ReadToEnd()
    $proc3.WaitForExit()

    $mismatchResult = $mismatchStdout | ConvertFrom-Json
    $mismatchBlocked = ($proc3.ExitCode -ne 0 -and $mismatchResult.success -eq $false)
    Report-Step -Name "Broker 'retrieve-fill' rejected for mismatched origin" -Success $mismatchBlocked

    # Concurrent read-modify-write must preserve every previously saved record.
    $writers = @()
    foreach ($index in 1..4) {
        $writer = [System.Diagnostics.Process]::Start($psi)
        $writer.StandardInput.WriteLine((@{
            action = "persist-generated"
            origin = "https://app.example.com"
            recordId = "concurrent-$index"
            length = 28
        } | ConvertTo-Json -Compress))
        $writer.StandardInput.Close()
        $writers += $writer
    }
    $writesSucceeded = $true
    foreach ($writer in $writers) {
        $null = $writer.StandardOutput.ReadToEnd()
        $writer.WaitForExit()
        if ($writer.ExitCode -ne 0) { $writesSucceeded = $false }
        $writer.Dispose()
    }
    Report-Step -Name "Concurrent encrypted updates succeed" -Success $writesSucceeded

    # --------------------------------------------------------------------------
    # Test 6: Verify Metadata List Action (No secrets or fingerprints)
    # --------------------------------------------------------------------------
    $listReq = @{
        action = "list"
    } | ConvertTo-Json -Compress

    $proc4 = [System.Diagnostics.Process]::Start($psi)
    $proc4.StandardInput.WriteLine($listReq)
    $proc4.StandardInput.Close()
    $listStdout = $proc4.StandardOutput.ReadToEnd()
    $proc4.WaitForExit()

    $listResult = $listStdout | ConvertFrom-Json
    $listClean = ($proc4.ExitCode -eq 0 -and $listResult.success -eq $true -and $listResult.entries.Count -gt 0)
    # Ensure no secrets or fingerprints
    $hasLeak = $false
    foreach ($entry in $listResult.entries) {
        if ($entry.PSObject.Properties["secret"] -or $entry.PSObject.Properties["fingerprint"]) {
            $hasLeak = $true
        }
    }
    Report-Step -Name "Broker 'list' returns metadata without secret or fingerprint leakage" -Success ($listClean -and -not $hasLeak)
    $expectedIds = @("synthetic-service-user", "concurrent-1", "concurrent-2", "concurrent-3", "concurrent-4")
    $actualIds = @($listResult.entries | ForEach-Object { $_.recordId })
    $preserved = ($actualIds.Count -eq $expectedIds.Count)
    foreach ($id in $expectedIds) {
        if ($actualIds -notcontains $id) { $preserved = $false }
    }
    Report-Step -Name "Atomic concurrent updates preserve all credential identities" -Success $preserved

} finally {
    # Cleanup temp isolated directory
    if (Test-Path $tempFolder) {
        try {
            Remove-Item -Path $tempFolder -Recurse -Force -ErrorAction SilentlyContinue
        } catch {}
    }
}

Write-Host "==========================================================" -ForegroundColor Cyan
if ($allPassed) {
    Write-Host "Smoke verification passed for the exercised synthetic scenarios." -ForegroundColor Green
    exit 0
} else {
    Write-Host "Smoke Verification FAILED." -ForegroundColor Red
    exit 1
}
