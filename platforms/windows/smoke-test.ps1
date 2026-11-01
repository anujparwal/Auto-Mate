<#
.SYNOPSIS
    Auto-Mate Windows Native Vault - Local Smoke Verification
    Validates DPAPI CurrentUser encrypted storage with v2 metadata-protecting envelope,
    lossless atomic v1 migration in isolated synthetic context, strict cryptographic origin binding,
    atomic persistence, restrictive ACLs, consumer-visible negative security boundaries,
    and mandatory Windows Hello gating.

.DESCRIPTION
    Runs an isolated test suite using synthetic dummy values against temporary vault files
    strictly located under [IO.Path]::GetTempPath()/AutoMate-Synthetic/<child>/...
    Validates actual persist/read/list broker APIs:
    1.  Fresh v2 at-rest metadata and secret absence (envelope exposes ONLY version and cipherText).
    2.  Restrictive NTFS ACL enforcement.
    3.  Broker metadata listing after native decrypt (no secret or fingerprint leaks).
    4.  Broker retrieve-fill success for matching origin (.test).
    5.  Broker retrieve-fill cross-origin rejection.
    6.  Concurrent encrypted updates and identity preservation.
    7.  Lossless atomic v1 migration (secret, timestamps, and no plaintext metadata on disk after).
    8.  Corrupt-v1 operation refusal with zero disk mutation.
    9.  Tampered-v2 operation refusal with zero disk mutation.
    10. Case-sensitive identity preservation.
    11. Format corruption and schema refusal with zero disk mutation.
    12. Synthetic mode CANNOT decrypt copied normal v2 fixture (entropy namespace separation).
    13. Synthetic mode CANNOT decrypt or migrate copied normal v1 fixture (origin entropy namespace separation).
    14. Synthetic mode CANNOT use default production path (explicit -VaultPath required).
    15. Root path escapes (direct root file, parent traversal) denied without creating or mutating files.
    16. Non-.test origins denied under synthetic mode without creating or mutating files.
    17. Normal operation without -Synthetic fails closed as VAULT_AUTHENTICATION_REQUIRED before touching files.
    18. Unicode secret fidelity across detached and UTF-8-console broker processes.
#>

[CmdletBinding()]
param (
    [Parameter()]
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

$syntheticBase = Join-Path ([System.IO.Path]::GetTempPath()) "AutoMate-Synthetic"
if (-not (Test-Path $syntheticBase)) {
    New-Item -ItemType Directory -Path $syntheticBase -Force | Out-Null
}

$tempFolder = if (-not [string]::IsNullOrWhiteSpace($CustomTempDir)) {
    $CustomTempDir
} else {
    Join-Path $syntheticBase ("smoke_" + [System.Guid]::NewGuid().ToString("N"))
}

if (-not (Test-Path $tempFolder)) {
    New-Item -ItemType Directory -Path $tempFolder -Force | Out-Null
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

$originalInputEncoding = [System.Console]::InputEncoding
$originalOutputEncoding = [System.Console]::OutputEncoding
try {
    # .NET Framework's stdin writer inherits Console.InputEncoding, including BOM.
    $protocolUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    [System.Console]::InputEncoding = $protocolUtf8
    [System.Console]::OutputEncoding = $protocolUtf8
    Add-Type -AssemblyName System.Security

    # Helper: Execute broker action against a specific vault file
    function Invoke-BrokerAction {
        param (
            [hashtable]$Request,
            [string]$VaultFile,
            [switch]$Synthetic = $true,
            [string]$ExtraArgs = ""
        )
        $json = $Request | ConvertTo-Json -Compress
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "powershell.exe"
        $argsList = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$vaultScript`" -Broker"
        if ($Synthetic) {
            $argsList += " -Synthetic"
        }
        if (-not [string]::IsNullOrWhiteSpace($VaultFile)) {
            $argsList += " -VaultPath `"$VaultFile`""
        }
        if (-not [string]::IsNullOrWhiteSpace($ExtraArgs)) {
            $argsList += " $ExtraArgs"
        }
        $psi.Arguments = $argsList
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = $protocolUtf8
        $psi.StandardErrorEncoding = $protocolUtf8
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.StandardInput.WriteLine($json)
        $proc.StandardInput.Close()
        $stdout = $proc.StandardOutput.ReadToEnd()
        $stderr = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()

        $parsed = $null
        if (-not [string]::IsNullOrWhiteSpace($stdout)) {
            try { $parsed = $stdout | ConvertFrom-Json } catch {}
        }

        return [PSCustomObject]@{
            ExitCode = $proc.ExitCode
            Stdout   = $stdout
            Stderr   = $stderr
            Response = $parsed
        }
    }

    # --------------------------------------------------------------------------
    # Test 1: Broker Persist-Generated Action & Fresh v2 At-Rest Absence
    # --------------------------------------------------------------------------
    $genReq = @{
        action   = "persist-generated"
        origin   = "https://app.example.test"
        recordId = "synthetic-service-user"
        length   = 28
    }
    $genRes = Invoke-BrokerAction -Request $genReq -VaultFile $testVaultPath
    $genOk = ($genRes.ExitCode -eq 0 -and $genRes.Response -and
              $genRes.Response.success -eq $true -and
              $genRes.Response.authentication -eq "synthetic-isolated" -and
              -not [string]::IsNullOrEmpty($genRes.Response.generatedSecret) -and
              $genRes.Response.generatedSecret.Length -ge 28)
    Report-Step -Name "Broker 'persist-generated' persists secret and returns generatedSecret with synthetic-isolated auth" -Success $genOk

    $vaultFileExists = (Test-Path $testVaultPath)
    Report-Step -Name "Vault file created on disk" -Success $vaultFileExists

    if ($vaultFileExists) {
        $vaultFileContent = [System.IO.File]::ReadAllText($testVaultPath, [System.Text.Encoding]::UTF8)
        $envelope = $null
        try { $envelope = $vaultFileContent | ConvertFrom-Json } catch {}
        $propNames = if ($envelope) { @($envelope.PSObject.Properties | ForEach-Object { $_.Name }) } else { @() }

        # Outer envelope MUST expose ONLY version (2) and cipherText
        $v2EnvelopeValid = ($envelope -and $envelope.version -eq 2 -and -not [string]::IsNullOrWhiteSpace($envelope.cipherText) -and $propNames.Count -eq 2)
        Report-Step -Name "Fresh v2 on-disk envelope exposes ONLY version and cipherText" -Success $v2EnvelopeValid

        # Assert no metadata, origin, recordId, or secret leakage at rest
        $containsPlaintextSecret = ($vaultFileContent -like "*$($genRes.Response.generatedSecret)*")
        $containsOriginAtRest = ($vaultFileContent -like "*app.example.test*")
        $containsRecordIdAtRest = ($vaultFileContent -like "*synthetic-service-user*")
        $cleanAtRest = (-not $containsPlaintextSecret -and -not $containsOriginAtRest -and -not $containsRecordIdAtRest)
        Report-Step -Name "Vault file on disk contains NO plaintext secret, origin, or recordId" -Success $cleanAtRest

        # File permissions check
        $acl = Get-Acl -Path $testVaultPath
        $isProtected = $acl.AreAccessRulesProtected
        Report-Step -Name "Restrictive ACL applied (inheritance disabled)" -Success $isProtected
    }

    # --------------------------------------------------------------------------
    # Test 2: Broker Metadata List After Native Decrypt
    # --------------------------------------------------------------------------
    $listReq = @{ action = "list" }
    $listRes = Invoke-BrokerAction -Request $listReq -VaultFile $testVaultPath
    $listOk = ($listRes.ExitCode -eq 0 -and $listRes.Response -and
               $listRes.Response.success -eq $true -and
               $listRes.Response.authentication -eq "synthetic-isolated" -and
               $listRes.Response.entries.Count -gt 0)
    $entry = if ($listOk) { $listRes.Response.entries[0] } else { $null }
    $hasMetadata = ($entry -and $entry.origin -eq "https://app.example.test" -and $entry.recordId -eq "synthetic-service-user" -and -not [string]::IsNullOrEmpty($entry.createdAt) -and -not [string]::IsNullOrEmpty($entry.updatedAt))
    $noLeak = ($entry -and -not $entry.PSObject.Properties["secret"] -and -not $entry.PSObject.Properties["fingerprint"])
    Report-Step -Name "Broker 'list' returns decrypted metadata without secret or fingerprint leakage" -Success ($listOk -and $hasMetadata -and $noLeak)

    # --------------------------------------------------------------------------
    # Test 3: Broker Retrieve-Fill with Matching Origin
    # --------------------------------------------------------------------------
    $retrieveReq = @{
        action   = "retrieve-fill"
        origin   = "https://app.example.test"
        recordId = "synthetic-service-user"
    }
    $retRes = Invoke-BrokerAction -Request $retrieveReq -VaultFile $testVaultPath
    $retrieveSuccess = ($retRes.ExitCode -eq 0 -and $retRes.Response -and
                        $retRes.Response.success -eq $true -and
                        $retRes.Response.authentication -eq "synthetic-isolated" -and
                        $retRes.Response.secret -eq $genRes.Response.generatedSecret)
    Report-Step -Name "Broker 'retrieve-fill' succeeds for matching origin" -Success $retrieveSuccess

    # --------------------------------------------------------------------------
    # Test 4: Broker Retrieve-Fill Rejection on Mismatched Origin
    # --------------------------------------------------------------------------
    $mismatchReq = @{
        action   = "retrieve-fill"
        origin   = "https://mismatched-origin.example.test"
        recordId = "synthetic-service-user"
    }
    $mismatchRes = Invoke-BrokerAction -Request $mismatchReq -VaultFile $testVaultPath
    $mismatchBlocked = ($mismatchRes.ExitCode -ne 0 -and $mismatchRes.Response -and $mismatchRes.Response.success -eq $false -and $mismatchRes.Response.error -eq "VAULT_REQUEST_DENIED")
    Report-Step -Name "Broker 'retrieve-fill' rejected for mismatched origin" -Success $mismatchBlocked

    # Detached native processes must preserve UTF-8 independently of console code page.
    $unicodeVaultPath = Join-Path $tempFolder "unicode_vault.json"
    $unicodeSecret = "synthetic-" + [char]0x00E9 + [char]0x0915 + [char]::ConvertFromUtf32(0x1F512)
    $unicodeWrite = Invoke-BrokerAction -Request @{
        action = "store-secret"
        origin = "https://unicode.example.test"
        recordId = "unicode-service-user"
        secret = $unicodeSecret
    } -VaultFile $unicodeVaultPath
    # Read in a UTF-8 console: matching wrong encodings at both ends can hide corruption.
    $utf8ReadCommand = ('[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); & ''{0}'' -Broker -Synthetic -VaultPath ''{1}''' -f
                        $vaultScript.Replace("'", "''"), $unicodeVaultPath.Replace("'", "''"))
    $encodedReadCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($utf8ReadCommand))
    $unicodeReadRequest = @{
        action = "retrieve-fill"
        origin = "https://unicode.example.test"
        recordId = "unicode-service-user"
    } | ConvertTo-Json -Compress
    $unicodeResponse = $unicodeReadRequest | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedReadCommand | ConvertFrom-Json
    $unicodePreserved = ($unicodeWrite.ExitCode -eq 0 -and $LASTEXITCODE -eq 0 -and
                         $unicodeResponse -and $unicodeResponse.secret -ceq $unicodeSecret)
    Report-Step -Name "Unicode secrets survive detached write and UTF-8-console read exactly" -Success $unicodePreserved

    # --------------------------------------------------------------------------
    # Test 5: Concurrent Encrypted Updates & Identity Preservation
    # --------------------------------------------------------------------------
    $psiBase = New-Object System.Diagnostics.ProcessStartInfo
    $psiBase.FileName = "powershell.exe"
    $psiBase.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$vaultScript`" -Broker -Synthetic -VaultPath `"$testVaultPath`""
    $psiBase.RedirectStandardInput = $true
    $psiBase.RedirectStandardOutput = $true
    $psiBase.RedirectStandardError = $true
    $psiBase.StandardOutputEncoding = $protocolUtf8
    $psiBase.StandardErrorEncoding = $protocolUtf8
    $psiBase.UseShellExecute = $false
    $psiBase.CreateNoWindow = $true

    $writers = @()
    foreach ($index in 1..4) {
        $writer = [System.Diagnostics.Process]::Start($psiBase)
        $writer.StandardInput.WriteLine((@{
            action   = "persist-generated"
            origin   = "https://app.example.test"
            recordId = "concurrent-$index"
            length   = 28
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

    $listAllRes = Invoke-BrokerAction -Request @{ action = "list" } -VaultFile $testVaultPath
    $expectedIds = @("synthetic-service-user", "concurrent-1", "concurrent-2", "concurrent-3", "concurrent-4")
    $actualIds = @($listAllRes.Response.entries | ForEach-Object { $_.recordId })
    $preserved = ($actualIds.Count -eq $expectedIds.Count)
    foreach ($id in $expectedIds) {
        if ($actualIds -notcontains $id) { $preserved = $false }
    }
    Report-Step -Name "Atomic concurrent updates preserve all credential identities" -Success $preserved

    # --------------------------------------------------------------------------
    # Test 6: Lossless Atomic v1 Migration (Timestamps, Password, No Plaintext After)
    # --------------------------------------------------------------------------
    $migrationVaultPath = Join-Path $tempFolder "migration_v1_vault.json"
    $v1Origin = "https://legacy-migration.example.test"
    $v1RecordId = "legacy-service-account"
    $v1Secret = "v1_preserved_secret_alpha_98765"
    $v1Created = "2026-01-01T00:00:00.000Z"
    $v1CreatedAt = "2026-01-01T01:00:00.000Z"
    $v1UpdatedAt = "2026-01-01T02:00:00.000Z"

    # Generate legacy v1 per-origin DPAPI ciphertext with Synthetic entropy
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $v1Entropy = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("AutoMate:Synthetic:Vault:OriginEntropy:v1:$v1Origin"))
    $sha.Dispose()

    $v1PayloadJson = @{
        origin   = $v1Origin
        recordId = $v1RecordId
        secret   = $v1Secret
        savedAt  = $v1CreatedAt
    } | ConvertTo-Json -Compress
    $v1PlainBytes = [System.Text.Encoding]::UTF8.GetBytes($v1PayloadJson)
    $v1CipherBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $v1PlainBytes,
        $v1Entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $v1CipherBase64 = [System.Convert]::ToBase64String($v1CipherBytes)
    [System.Array]::Clear($v1PlainBytes, 0, $v1PlainBytes.Length)
    [System.Array]::Clear($v1Entropy, 0, $v1Entropy.Length)

    $v1VaultObj = [ordered]@{
        version = 1
        created = $v1Created
        records = @(
            [ordered]@{
                origin     = $v1Origin
                recordId   = $v1RecordId
                cipherText = $v1CipherBase64
                createdAt  = $v1CreatedAt
                updatedAt  = $v1UpdatedAt
            }
        )
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($migrationVaultPath, ($v1VaultObj | ConvertTo-Json -Depth 10), $utf8NoBom)

    # Trigger migration via broker retrieve-fill
    $migRetReq = @{
        action   = "retrieve-fill"
        origin   = $v1Origin
        recordId = $v1RecordId
    }
    $migRetRes = Invoke-BrokerAction -Request $migRetReq -VaultFile $migrationVaultPath
    $migSecretMatch = ($migRetRes.ExitCode -eq 0 -and $migRetRes.Response -and $migRetRes.Response.success -eq $true -and $migRetRes.Response.secret -eq $v1Secret)
    Report-Step -Name "Migration: retrieved secret matches original v1 secret" -Success $migSecretMatch

    # Verify metadata listing preserves original timestamps
    $migListReq = @{ action = "list"; origin = $v1Origin }
    $migListRes = Invoke-BrokerAction -Request $migListReq -VaultFile $migrationVaultPath
    $migEntry = if ($migListRes.Response -and $migListRes.Response.entries) { $migListRes.Response.entries[0] } else { $null }
    $migTimestampsPreserved = ($migEntry -and $migEntry.createdAt -eq $v1CreatedAt -and $migEntry.updatedAt -eq $v1UpdatedAt)
    Report-Step -Name "Migration: record createdAt and updatedAt timestamps preserved" -Success $migTimestampsPreserved

    # Verify on-disk file is converted to v2 with zero exposed plaintext metadata
    $migRawOnDisk = [System.IO.File]::ReadAllText($migrationVaultPath, [System.Text.Encoding]::UTF8)
    $migEnvelope = $null
    try { $migEnvelope = $migRawOnDisk | ConvertFrom-Json } catch {}
    $migProps = if ($migEnvelope) { @($migEnvelope.PSObject.Properties | ForEach-Object { $_.Name }) } else { @() }
    $migIsV2Only = ($migEnvelope -and $migEnvelope.version -eq 2 -and -not [string]::IsNullOrWhiteSpace($migEnvelope.cipherText) -and $migProps.Count -eq 2)
    $migNoPlaintextSecret = (-not ($migRawOnDisk -like "*$v1Secret*"))
    $migNoOriginAtRest = (-not ($migRawOnDisk -like "*legacy-migration*"))
    $migNoRecordIdAtRest = (-not ($migRawOnDisk -like "*legacy-service-account*"))
    $migNoTimestampsAtRest = (-not ($migRawOnDisk -like "*2026-01-01*"))
    $migAtRestClean = ($migIsV2Only -and $migNoPlaintextSecret -and $migNoOriginAtRest -and $migNoRecordIdAtRest -and $migNoTimestampsAtRest)
    Report-Step -Name "Migration: file on disk atomically converted to v2 with zero exposed plaintext metadata" -Success $migAtRestClean

    # --------------------------------------------------------------------------
    # Test 7: Corrupt-v1 Rejection & Zero Mutation
    # --------------------------------------------------------------------------
    $corruptV1Path = Join-Path $tempFolder "corrupt_v1_vault.json"
    $corruptV1Obj = [ordered]@{
        version = 1
        created = "2026-01-01T00:00:00.000Z"
        records = @(
            [ordered]@{
                origin     = "https://corrupt.example.test"
                recordId   = "corrupt-user"
                cipherText = "INVALID_CORRUPTED_CIPHERTEXT_BLOB"
                createdAt  = "2026-01-01T01:00:00.000Z"
                updatedAt  = "2026-01-01T02:00:00.000Z"
            }
        )
    }
    [System.IO.File]::WriteAllText($corruptV1Path, ($corruptV1Obj | ConvertTo-Json -Depth 10), $utf8NoBom)
    $corruptHashBefore = (Get-FileHash -Path $corruptV1Path -Algorithm SHA256).Hash

    $corruptRes = Invoke-BrokerAction -Request @{ action = "retrieve-fill"; origin = "https://corrupt.example.test"; recordId = "corrupt-user" } -VaultFile $corruptV1Path
    $corruptRejected = ($corruptRes.ExitCode -ne 0 -and $corruptRes.Response -and $corruptRes.Response.success -eq $false -and $corruptRes.Response.error -eq "VAULT_REQUEST_DENIED")

    $corruptHashAfter = (Get-FileHash -Path $corruptV1Path -Algorithm SHA256).Hash
    $corruptNotMutated = ($corruptHashBefore -eq $corruptHashAfter)
    Report-Step -Name "Corrupt-v1: operation rejected and original corrupt file not mutated" -Success ($corruptRejected -and $corruptNotMutated)

    # --------------------------------------------------------------------------
    # Test 8: Tampered-v2 Rejection & Zero Mutation
    # --------------------------------------------------------------------------
    $tamperedV2Path = Join-Path $tempFolder "tampered_v2_vault.json"
    Copy-Item -Path $testVaultPath -Destination $tamperedV2Path
    $tamperedRaw = [System.IO.File]::ReadAllText($tamperedV2Path, [System.Text.Encoding]::UTF8)
    $tamperedObj = $tamperedRaw | ConvertFrom-Json
    $tamperedObj.cipherText = if ($tamperedObj.cipherText.StartsWith("A")) { "B" + $tamperedObj.cipherText.Substring(1) } else { "A" + $tamperedObj.cipherText.Substring(1) }
    [System.IO.File]::WriteAllText($tamperedV2Path, ($tamperedObj | ConvertTo-Json -Compress), $utf8NoBom)
    $tamperedHashBefore = (Get-FileHash -Path $tamperedV2Path -Algorithm SHA256).Hash

    $tamperedRes = Invoke-BrokerAction -Request @{ action = "retrieve-fill"; origin = "https://app.example.test"; recordId = "synthetic-service-user" } -VaultFile $tamperedV2Path
    $tamperedRejected = ($tamperedRes.ExitCode -ne 0 -and $tamperedRes.Response -and $tamperedRes.Response.success -eq $false -and $tamperedRes.Response.error -eq "VAULT_REQUEST_DENIED")

    $tamperedHashAfter = (Get-FileHash -Path $tamperedV2Path -Algorithm SHA256).Hash
    $tamperedNotMutated = ($tamperedHashBefore -eq $tamperedHashAfter)
    Report-Step -Name "Tampered-v2: decryption rejected and tampered file not mutated" -Success ($tamperedRejected -and $tamperedNotMutated)

    # --------------------------------------------------------------------------
    # Test 9: Case-Sensitive Account Identities
    # --------------------------------------------------------------------------
    $caseVault = Join-Path $tempFolder "case_identities.json"
    $upperWrite = Invoke-BrokerAction -VaultFile $caseVault -Request @{ action = "store-secret"; origin = "https://case.example.test"; recordId = "Account"; secret = "upper-account-synthetic-value" }
    $lowerWrite = Invoke-BrokerAction -VaultFile $caseVault -Request @{ action = "store-secret"; origin = "https://case.example.test"; recordId = "account"; secret = "lower-account-synthetic-value" }
    $upperRead = Invoke-BrokerAction -VaultFile $caseVault -Request @{ action = "retrieve-fill"; origin = "https://case.example.test"; recordId = "Account" }
    $lowerRead = Invoke-BrokerAction -VaultFile $caseVault -Request @{ action = "retrieve-fill"; origin = "https://case.example.test"; recordId = "account" }
    $caseIdentitiesPreserved = ($upperWrite.ExitCode -eq 0 -and $lowerWrite.ExitCode -eq 0 -and
        $upperRead.ExitCode -eq 0 -and $lowerRead.ExitCode -eq 0 -and
        $upperRead.Response.secret -ceq "upper-account-synthetic-value" -and
        $lowerRead.Response.secret -ceq "lower-account-synthetic-value")
    Report-Step -Name "Case-sensitive account identities retain their own passwords" -Success $caseIdentitiesPreserved

    # --------------------------------------------------------------------------
    # Test 10: Format Corruption & Schema Refusal
    # --------------------------------------------------------------------------
    $invalidCases = @(
        @{ name = "unknown-version"; content = '{"version":99,"cipherText":"future-format-data"}' },
        @{ name = "coerced-version"; content = '{"version":"2","cipherText":"not-a-v2-vault"}' },
        @{ name = "empty-file"; content = "" },
        @{ name = "non-array-records"; content = ([ordered]@{ version = 1; created = $v1Created; records = $v1VaultObj.records[0] } | ConvertTo-Json -Depth 10) },
        @{ name = "duplicate-legacy-identities"; content = ([ordered]@{ version = 1; created = $v1Created; records = @($v1VaultObj.records[0], $v1VaultObj.records[0]) } | ConvertTo-Json -Depth 10) }
    )
    foreach ($case in $invalidCases) {
        $invalidPath = Join-Path $tempFolder ($case.name + ".json")
        [System.IO.File]::WriteAllText($invalidPath, $case.content, $utf8NoBom)
        $hashBefore = (Get-FileHash -LiteralPath $invalidPath -Algorithm SHA256).Hash
        $denied = Invoke-BrokerAction -VaultFile $invalidPath -Request @{ action = "store-secret"; origin = "https://new.example.test"; recordId = "new-record"; secret = "must-not-be-written" }
        $hashAfter = (Get-FileHash -LiteralPath $invalidPath -Algorithm SHA256).Hash
        Report-Step -Name "$($case.name): write refused without mutating existing data" -Success (
            $denied.ExitCode -ne 0 -and $denied.Response.error -eq "VAULT_REQUEST_DENIED" -and $hashBefore -eq $hashAfter)
    }

    # --------------------------------------------------------------------------
    # Test 11: Consumer-visible negative - Synthetic mode CANNOT decrypt normal v2 fixture
    # --------------------------------------------------------------------------
    $copiedNormalV2Path = Join-Path $tempFolder "copied_normal_v2_vault.json"
    $normalV2Payload = [ordered]@{
        version = 2
        created = "2026-01-01T00:00:00.000Z"
        records = @(
            [ordered]@{
                origin    = "https://prod-fixture.example.test"
                recordId  = "prod-secret-id"
                secret    = "secret-from-normal-production-v2"
                createdAt = "2026-01-01T00:00:00.000Z"
                updatedAt = "2026-01-01T00:00:00.000Z"
            }
        )
    }
    $normalV2PayloadBytes = [System.Text.Encoding]::UTF8.GetBytes(($normalV2Payload | ConvertTo-Json -Depth 10 -Compress))
    $shaNormalV2 = [System.Security.Cryptography.SHA256]::Create()
    $normalV2Entropy = $shaNormalV2.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("AutoMate:Vault:Entropy:v2"))
    $shaNormalV2.Dispose()
    $normalV2CipherBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $normalV2PayloadBytes,
        $normalV2Entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [System.Array]::Clear($normalV2PayloadBytes, 0, $normalV2PayloadBytes.Length)
    [System.Array]::Clear($normalV2Entropy, 0, $normalV2Entropy.Length)
    $normalV2Envelope = [ordered]@{
        version    = 2
        cipherText = [System.Convert]::ToBase64String($normalV2CipherBytes)
    }
    [System.IO.File]::WriteAllText($copiedNormalV2Path, ($normalV2Envelope | ConvertTo-Json -Compress), $utf8NoBom)
    $hashNormalV2Before = (Get-FileHash -LiteralPath $copiedNormalV2Path -Algorithm SHA256).Hash

    $readNormalV2Res = Invoke-BrokerAction -Request @{
        action   = "retrieve-fill"
        origin   = "https://prod-fixture.example.test"
        recordId = "prod-secret-id"
    } -VaultFile $copiedNormalV2Path -Synthetic:$true

    $hashNormalV2After = (Get-FileHash -LiteralPath $copiedNormalV2Path -Algorithm SHA256).Hash
    $normalV2Denied = ($readNormalV2Res.ExitCode -ne 0 -and
                       $readNormalV2Res.Response -and
                       $readNormalV2Res.Response.success -eq $false -and
                       $readNormalV2Res.Response.error -eq "VAULT_REQUEST_DENIED" -and
                       $hashNormalV2Before -eq $hashNormalV2After)
    Report-Step -Name "Consumer-visible negative: synthetic flag cannot decrypt copied normal v2 fixture (entropy mismatch)" -Success $normalV2Denied

    # --------------------------------------------------------------------------
    # Test 12: Consumer-visible negative - Synthetic mode CANNOT decrypt/migrate normal v1 fixture
    # --------------------------------------------------------------------------
    $copiedNormalV1Path = Join-Path $tempFolder "copied_normal_v1_vault.json"
    $normalV1Origin = "https://prod-v1-fixture.example.test"
    $normalV1Secret = "secret-from-normal-production-v1"
    $shaNormalV1 = [System.Security.Cryptography.SHA256]::Create()
    $normalV1Entropy = $shaNormalV1.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("AutoMate:Vault:OriginEntropy:v1:$normalV1Origin"))
    $shaNormalV1.Dispose()
    $normalV1PayloadBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ origin = $normalV1Origin; recordId = "prod-v1-id"; secret = $normalV1Secret } | ConvertTo-Json -Compress))
    $normalV1CipherBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $normalV1PayloadBytes,
        $normalV1Entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [System.Array]::Clear($normalV1PayloadBytes, 0, $normalV1PayloadBytes.Length)
    [System.Array]::Clear($normalV1Entropy, 0, $normalV1Entropy.Length)
    $normalV1VaultObj = [ordered]@{
        version = 1
        created = "2026-01-01T00:00:00.000Z"
        records = @(
            [ordered]@{
                origin     = $normalV1Origin
                recordId   = "prod-v1-id"
                cipherText = [System.Convert]::ToBase64String($normalV1CipherBytes)
                createdAt  = "2026-01-01T00:00:00.000Z"
                updatedAt  = "2026-01-01T00:00:00.000Z"
            }
        )
    }
    [System.IO.File]::WriteAllText($copiedNormalV1Path, ($normalV1VaultObj | ConvertTo-Json -Depth 10), $utf8NoBom)
    $hashNormalV1Before = (Get-FileHash -LiteralPath $copiedNormalV1Path -Algorithm SHA256).Hash

    $readNormalV1Res = Invoke-BrokerAction -Request @{
        action   = "retrieve-fill"
        origin   = $normalV1Origin
        recordId = "prod-v1-id"
    } -VaultFile $copiedNormalV1Path -Synthetic:$true

    $hashNormalV1After = (Get-FileHash -LiteralPath $copiedNormalV1Path -Algorithm SHA256).Hash
    $normalV1Denied = ($readNormalV1Res.ExitCode -ne 0 -and
                       $readNormalV1Res.Response -and
                       $readNormalV1Res.Response.success -eq $false -and
                       $readNormalV1Res.Response.error -eq "VAULT_REQUEST_DENIED" -and
                       $hashNormalV1Before -eq $hashNormalV1After)
    Report-Step -Name "Consumer-visible negative: synthetic flag cannot decrypt/migrate copied normal v1 fixture (origin entropy mismatch)" -Success $normalV1Denied

    # --------------------------------------------------------------------------
    # Test 13: Consumer-visible negative - Synthetic mode denied when -VaultPath is omitted
    # --------------------------------------------------------------------------
    $noPathRes = Invoke-BrokerAction -Request @{ action = "list" } -VaultFile "" -Synthetic:$true
    $noPathDenied = ($noPathRes.ExitCode -ne 0 -and
                     $noPathRes.Response -and
                     $noPathRes.Response.success -eq $false -and
                     $noPathRes.Response.error -eq "VAULT_REQUEST_DENIED")
    Report-Step -Name "Consumer-visible negative: synthetic mode denied when -VaultPath is omitted (no default real vault)" -Success $noPathDenied

    # --------------------------------------------------------------------------
    # Test 14: Consumer-visible negative - Root path escapes denied without creating/mutating files
    # --------------------------------------------------------------------------
    # Direct file in synthetic root (not in a child directory)
    $directRootPath = Join-Path $syntheticBase "direct_root_forbidden.json"
    $directRootRes = Invoke-BrokerAction -Request @{ action = "list" } -VaultFile $directRootPath -Synthetic:$true
    $directRootDenied = ($directRootRes.ExitCode -ne 0 -and
                         $directRootRes.Response -and
                         $directRootRes.Response.success -eq $false -and
                         $directRootRes.Response.error -eq "VAULT_REQUEST_DENIED")

    # Parent directory escape outside AutoMate-Synthetic
    $escapedPath = Join-Path $tempFolder "..\..\escaped_forbidden.json"
    $escapedRes = Invoke-BrokerAction -Request @{ action = "list" } -VaultFile $escapedPath -Synthetic:$true
    $escapedDenied = ($escapedRes.ExitCode -ne 0 -and
                      $escapedRes.Response -and
                      $escapedRes.Response.success -eq $false -and
                      $escapedRes.Response.error -eq "VAULT_REQUEST_DENIED")

    $rootEscapesDenied = ($directRootDenied -and $escapedDenied -and -not (Test-Path $directRootPath) -and -not (Test-Path $escapedPath))
    Report-Step -Name "Consumer-visible negative: root path escapes denied without creating or mutating files" -Success $rootEscapesDenied

    # --------------------------------------------------------------------------
    # Test 15: Consumer-visible negative - Non-.test origins denied under synthetic mode
    # --------------------------------------------------------------------------
    $nonTestVaultPath = Join-Path $tempFolder "non_test_origin_vault.json"
    $nonTestRes = Invoke-BrokerAction -Request @{
        action   = "store-secret"
        origin   = "https://app.example.com"
        recordId = "user1"
        secret   = "secret-value"
    } -VaultFile $nonTestVaultPath -Synthetic:$true

    $nonTestDenied = ($nonTestRes.ExitCode -ne 0 -and
                      $nonTestRes.Response -and
                      $nonTestRes.Response.success -eq $false -and
                      $nonTestRes.Response.error -eq "VAULT_REQUEST_DENIED" -and
                      -not (Test-Path $nonTestVaultPath))
    Report-Step -Name "Consumer-visible negative: non-.test origin (https://app.example.com) denied under synthetic mode without mutation" -Success $nonTestDenied

    # --------------------------------------------------------------------------
    # Test 16: Normal operation fails closed when Hello is unauthenticated
    # --------------------------------------------------------------------------
    $normalNoAuthRes = Invoke-BrokerAction -Request @{ action = "list" } -VaultFile $testVaultPath -Synthetic:$false
    $normalAuthDenied = ($normalNoAuthRes.ExitCode -ne 0 -and
                         $normalNoAuthRes.Response -and
                         $normalNoAuthRes.Response.success -eq $false -and
                         $normalNoAuthRes.Response.error -eq "VAULT_AUTHENTICATION_REQUIRED")
    Report-Step -Name "Normal operation fails closed (VAULT_AUTHENTICATION_REQUIRED) before touching vault when Hello unauthenticated" -Success $normalAuthDenied

} finally {
    [System.Console]::InputEncoding = $originalInputEncoding
    [System.Console]::OutputEncoding = $originalOutputEncoding
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
