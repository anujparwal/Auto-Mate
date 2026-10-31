<#
.SYNOPSIS
    Auto-Mate Native Encrypted Vault for Windows.
    Provides DPAPI CurrentUser encrypted storage, CSPRNG password generation,
    cryptographic origin binding, atomic persistence, and restrictive ACLs.

.DESCRIPTION
    Security Design & Boundaries:
    1. Cryptography: Protected via DPAPI (DataProtectionScope.CurrentUser).
    2. Strict Origin Binding: Every entry is bound cryptographically to a canonical HTTPS origin.
       Decryption entropy incorporates SHA-256 of the canonical origin. Decryption
       fails cryptographically if attempted under a different origin.
    3. Storage Security: Vault directory and files are configured with restrictive NTFS
       ACLs permitting access ONLY to the current user SID. File inheritance is disabled.
       Fails closed if restrictive permissions cannot be applied.
    4. Threat Boundary: DPAPI CurrentUser does NOT provide per-use biometric prompts.
       This CLI is TRUSTED-OWNER ONLY and MUST NOT be exposed as an agent tool to AI models.
    5. Windows Hello authentication is not implemented. -RequireHello always denies use.
       Checking hardware availability is not proof of user authentication.
    6. Secret Hygiene: Secrets are never accepted as command-line arguments.
       Interactive input uses SecureStrings. Error messages never echo sensitive values.
       No secret fingerprints are stored or returned.
    7. Broker IPC: A dedicated stdin/stdout JSON protocol is provided for the trusted
       parent browser executor (autofill & signup workflows) over private process pipes.
#>

[CmdletBinding(DefaultParameterSetName = "Help")]
param (
    [Parameter(ParameterSetName = "Store", Mandatory = $true)]
    [switch]$Store,

    [Parameter(ParameterSetName = "Generate", Mandatory = $true)]
    [switch]$Generate,

    [Parameter(ParameterSetName = "List", Mandatory = $true)]
    [switch]$List,

    [Parameter(ParameterSetName = "Reveal", Mandatory = $true)]
    [switch]$Reveal,

    [Parameter(ParameterSetName = "Broker", Mandatory = $true)]
    [switch]$Broker,

    [Parameter(ParameterSetName = "Help")]
    [switch]$Help,

    # Options
    [Parameter(ParameterSetName = "Store", Mandatory = $true)]
    [Parameter(ParameterSetName = "Generate", Mandatory = $true)]
    [Parameter(ParameterSetName = "Reveal", Mandatory = $true)]
    [Parameter(ParameterSetName = "List", Mandatory = $false)]
    [string]$Origin,

    [Parameter(ParameterSetName = "Store", Mandatory = $true)]
    [Parameter(ParameterSetName = "Generate", Mandatory = $true)]
    [Parameter(ParameterSetName = "Reveal", Mandatory = $true)]
    [string]$RecordId,

    [Parameter(ParameterSetName = "Generate")]
    [int]$Length = 24,

    [Parameter(ParameterSetName = "Store")]
    [Parameter(ParameterSetName = "Generate")]
    [Parameter(ParameterSetName = "Reveal")]
    [Parameter(ParameterSetName = "Broker")]
    [switch]$RequireHello,

    [Parameter()]
    [string]$VaultPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Ensure Cryptography Assemblies are loaded
try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
} catch {
    try {
        Add-Type -AssemblyName "System.Security.Cryptography.ProtectedData" -ErrorAction Stop
    } catch {
        # Fallback to standard environment type resolution
    }
}

# ==============================================================================
# Helpers: Paths, Origin, Cryptography, ACLs
# ==============================================================================

function Resolve-VaultFilePath {
    param ([string]$PathInput)
    $candidate = $PathInput
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        if (-not [string]::IsNullOrWhiteSpace($VaultPath)) {
            $candidate = $VaultPath
        } elseif (-not [string]::IsNullOrWhiteSpace($env:AUTOMATE_VAULT_PATH)) {
            $candidate = $env:AUTOMATE_VAULT_PATH
        } else {
            $localAppData = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
            if ([string]::IsNullOrWhiteSpace($localAppData)) {
                $localAppData = [System.IO.Path]::Combine($env:USERPROFILE, "AppData", "Local")
            }
            return [System.IO.Path]::Combine($localAppData, "Auto-Mate", "vault.json")
        }
    }

    if ([System.IO.Directory]::Exists($candidate) -or $candidate.EndsWith("\") -or $candidate.EndsWith("/")) {
        return [System.IO.Path]::Combine($candidate, "vault.json")
    }
    return [System.IO.Path]::GetFullPath($candidate)
}

function Get-CanonicalOrigin {
    param ([string]$OriginInput)
    if ([string]::IsNullOrWhiteSpace($OriginInput)) {
        throw "Invalid origin: origin cannot be empty."
    }

    $trimmed = $OriginInput.Trim()
    $uriResult = $null
    $isValid = [System.Uri]::TryCreate($trimmed, [System.UriKind]::Absolute, [ref]$uriResult)
    if (-not $isValid -or $null -eq $uriResult) {
        throw "Invalid origin: origin must be a valid absolute HTTPS URI."
    }

    if ($uriResult.Scheme -ne [System.Uri]::UriSchemeHttps) {
        throw "Invalid origin: scheme must be strictly 'https'."
    }

    if (-not [string]::IsNullOrEmpty($uriResult.UserInfo)) {
        throw "Invalid origin: userinfo is not permitted in origin."
    }

    if ($uriResult.AbsolutePath -ne "/" -and -not [string]::IsNullOrEmpty($uriResult.AbsolutePath)) {
        throw "Invalid origin: path components are not permitted in origin."
    }

    if (-not [string]::IsNullOrEmpty($uriResult.Query)) {
        throw "Invalid origin: query parameters are not permitted in origin."
    }

    if (-not [string]::IsNullOrEmpty($uriResult.Fragment)) {
        throw "Invalid origin: fragments are not permitted in origin."
    }

    $hostName = $uriResult.DnsSafeHost.ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($hostName)) {
        throw "Invalid origin: hostname is missing or invalid."
    }

    if ($uriResult.IsDefaultPort) {
        return ("https://{0}" -f $hostName)
    } else {
        return ("https://{0}:{1}" -f $hostName, $uriResult.Port)
    }
}

function Get-OriginEntropy {
    param ([string]$CanonicalOrigin)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $saltString = "AutoMate:Vault:OriginEntropy:v1:" + $CanonicalOrigin
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($saltString)
        return $sha256.ComputeHash($bytes)
    } finally {
        $sha256.Dispose()
    }
}

function Generate-SecurePassword {
    param ([int]$Length = 24)
    if ($Length -lt 12) { $Length = 12 }
    if ($Length -gt 128) { $Length = 128 }

    $charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_=+"
    $charsetLen = $charset.Length
    $maxValid = 256 - (256 % $charsetLen)

    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $sb = New-Object System.Text.StringBuilder
        $buffer = New-Object byte[] 1

        while ($sb.Length -lt $Length) {
            $rng.GetBytes($buffer)
            $val = [int]$buffer[0]
            if ($val -lt $maxValid) {
                [void]$sb.Append($charset[$val % $charsetLen])
            }
        }
        return $sb.ToString()
    } finally {
        $rng.Dispose()
    }
}

function Set-RestrictiveAcl {
    param (
        [string]$Path,
        [bool]$IsDirectory = $false
    )
    try {
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        if ($IsDirectory) {
            $acl = New-Object System.Security.AccessControl.DirectorySecurity
            $acl.SetAccessRuleProtection($true, $false)
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $currentUser,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow
            )
            $acl.AddAccessRule($rule)
            Set-Acl -Path $Path -AclObject $acl
        } else {
            $acl = New-Object System.Security.AccessControl.FileSecurity
            $acl.SetAccessRuleProtection($true, $false)
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $currentUser,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                [System.Security.AccessControl.AccessControlType]::Allow
            )
            $acl.AddAccessRule($rule)
            Set-Acl -Path $Path -AclObject $acl
        }
    } catch {
        throw "Failed to enforce restrictive ACL on vault storage. Refusing to operate on insecure storage."
    }
}

function Save-VaultFileAtomic {
    param (
        [string]$FilePath,
        [string]$JsonContent
    )
    $dir = [System.IO.Path]::GetDirectoryName($FilePath)
    if (-not [string]::IsNullOrEmpty($dir) -and -not [System.IO.Directory]::Exists($dir)) {
        [System.IO.Directory]::CreateDirectory($dir) | Out-Null
        Set-RestrictiveAcl -Path $dir -IsDirectory $true
    }

    $tempFile = [System.IO.Path]::Combine($dir, "vault_staging_" + [System.Guid]::NewGuid().ToString("N") + ".tmp")
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tempFile, $JsonContent, $utf8NoBom)
    
    Set-RestrictiveAcl -Path $tempFile -IsDirectory $false

    if ([System.IO.File]::Exists($FilePath)) {
        try {
            [System.IO.File]::Replace($tempFile, $FilePath, [System.Management.Automation.Language.NullString]::Value)
        } catch {
            [System.IO.File]::Delete($tempFile)
            throw "Atomic vault replacement failed. Existing vault was not overwritten."
        }
    } else {
        [System.IO.File]::Move($tempFile, $FilePath)
    }
}

function Load-VaultData {
    param ([string]$FilePath)
    if (-not [System.IO.File]::Exists($FilePath)) {
        return @{
            version = 1
            created = [System.DateTime]::UtcNow.ToString("o")
            records = (New-Object System.Collections.ArrayList)
        }
    }
    try {
        $content = [System.IO.File]::ReadAllText($FilePath, [System.Text.Encoding]::UTF8)
        $data = $content | ConvertFrom-Json
        $recordsList = New-Object System.Collections.ArrayList
        if ($data.records) {
            foreach ($rec in $data.records) {
                $recordsList.Add($rec) | Out-Null
            }
        }
        return @{
            version = if ($data.version) { $data.version } else { 1 }
            created = if ($data.created) { $data.created } else { [System.DateTime]::UtcNow.ToString("o") }
            records = $recordsList
        }
    } catch {
        throw "Failed to read vault file: format corrupted or unreadable."
    }
}

function Set-VaultRecord {
    param (
        [string]$Origin,
        [string]$RecordId,
        [string]$Secret,
        [string]$CustomVaultPath
    )
    $canonicalOrigin = Get-CanonicalOrigin $Origin
    if ([string]::IsNullOrWhiteSpace($RecordId)) {
        throw "RecordId cannot be null or empty."
    }
    if ($null -eq $Secret -or $Secret.Length -eq 0) {
        throw "Secret cannot be empty."
    }

    $secretBytes = [System.Text.Encoding]::UTF8.GetBytes($Secret)
    try {
        $now = [System.DateTime]::UtcNow.ToString("o")
        $payloadObj = @{
            origin   = $canonicalOrigin
            recordId = $RecordId
            secret   = $Secret
            savedAt  = $now
        }
        $payloadJson = $payloadObj | ConvertTo-Json -Compress
        $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payloadJson)

        $entropy = Get-OriginEntropy $canonicalOrigin
        $cipherBytes = [System.Security.Cryptography.ProtectedData]::Protect(
            $payloadBytes,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $cipherBase64 = [System.Convert]::ToBase64String($cipherBytes)

        [System.Array]::Clear($secretBytes, 0, $secretBytes.Length)
        [System.Array]::Clear($payloadBytes, 0, $payloadBytes.Length)

        $vaultFilePath = Resolve-VaultFilePath -PathInput $CustomVaultPath
        $vaultData = Load-VaultData -FilePath $vaultFilePath

        $existingIndex = -1
        for ($i = 0; $i -lt $vaultData.records.Count; $i++) {
            $r = $vaultData.records[$i]
            if ($r.origin -eq $canonicalOrigin -and $r.recordId -eq $RecordId) {
                $existingIndex = $i
                break
            }
        }

        $createdAt = $now
        if ($existingIndex -ge 0) {
            $createdAt = $vaultData.records[$existingIndex].createdAt
        }

        $recordItem = [PSCustomObject]@{
            origin     = $canonicalOrigin
            recordId   = $RecordId
            cipherText = $cipherBase64
            createdAt  = $createdAt
            updatedAt  = $now
        }

        if ($existingIndex -ge 0) {
            $vaultData.records[$existingIndex] = $recordItem
        } else {
            $vaultData.records.Add($recordItem) | Out-Null
        }

        $outObj = [PSCustomObject]@{
            version = $vaultData.version
            created = $vaultData.created
            records = @($vaultData.records)
        }
        Save-VaultFileAtomic -FilePath $vaultFilePath -JsonContent ($outObj | ConvertTo-Json -Depth 10)
        return $canonicalOrigin
    } finally {
        if ($secretBytes) {
            [System.Array]::Clear($secretBytes, 0, $secretBytes.Length)
        }
    }
}

function Get-VaultRecord {
    param (
        [string]$Origin,
        [string]$RecordId,
        [string]$CustomVaultPath
    )
    $canonicalOrigin = Get-CanonicalOrigin $Origin
    if ([string]::IsNullOrWhiteSpace($RecordId)) {
        throw "RecordId cannot be null or empty."
    }

    $vaultFilePath = Resolve-VaultFilePath -PathInput $CustomVaultPath
    $vaultData = Load-VaultData -FilePath $vaultFilePath

    $matched = $null
    foreach ($r in $vaultData.records) {
        if ($r.origin -eq $canonicalOrigin -and $r.recordId -eq $RecordId) {
            $matched = $r
            break
        }
    }

    if (-not $matched) {
        throw "Record not found for requested origin and recordId."
    }

    $cipherBytes = [System.Convert]::FromBase64String($matched.cipherText)
    $entropy = Get-OriginEntropy $canonicalOrigin
    $plainBytes = $null
    try {
        $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $cipherBytes,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
    } catch {
        throw "Decryption failed: cryptographic integrity check or origin entropy mismatch."
    }

    try {
        $json = [System.Text.Encoding]::UTF8.GetString($plainBytes)
        $payload = $json | ConvertFrom-Json
        if ($payload.origin -ne $canonicalOrigin -or $payload.recordId -ne $RecordId) {
            throw "Integrity error: decrypted record does not match requested entry."
        }
        return $payload.secret
    } finally {
        if ($plainBytes) {
            [System.Array]::Clear($plainBytes, 0, $plainBytes.Length)
        }
    }
}

function Get-VaultList {
    param (
        [string]$Origin,
        [string]$CustomVaultPath
    )
    $vaultFilePath = Resolve-VaultFilePath -PathInput $CustomVaultPath
    $vaultData = Load-VaultData -FilePath $vaultFilePath

    $filterOrigin = $null
    if (-not [string]::IsNullOrWhiteSpace($Origin)) {
        $filterOrigin = Get-CanonicalOrigin $Origin
    }

    $entries = @()
    foreach ($r in $vaultData.records) {
        if ($filterOrigin -and $r.origin -ne $filterOrigin) {
            continue
        }
        $entries += @{
            origin    = $r.origin
            recordId  = $r.recordId
            createdAt = $r.createdAt
            updatedAt = $r.updatedAt
        }
    }
    return $entries
}

function Compare-SecureStrings {
    param (
        [System.Security.SecureString]$S1,
        [System.Security.SecureString]$S2
    )
    if ($null -eq $S1 -or $null -eq $S2) { return $false }
    if ($S1.Length -ne $S2.Length) { return $false }
    $bstr1 = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($S1)
    $bstr2 = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($S2)
    try {
        $len = $S1.Length
        for ($i = 0; $i -lt ($len * 2); $i++) {
            $b1 = [System.Runtime.InteropServices.Marshal]::ReadByte($bstr1, $i)
            $b2 = [System.Runtime.InteropServices.Marshal]::ReadByte($bstr2, $i)
            if ($b1 -ne $b2) { return $false }
        }
        return $true
    } finally {
        if ($bstr1) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr1) }
        if ($bstr2) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr2) }
    }
}

function ConvertTo-PlainString {
    param ([System.Security.SecureString]$SecureString)
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        if ($bstr) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
}

function Assert-WindowsHelloRequirement {
    # Availability is not authentication. Never treat a configured device as consent.
    throw "Windows Hello authentication is not implemented. Credential use requiring Hello is denied."
}

# ==============================================================================
# CLI Operations
# ==============================================================================

function Invoke-Store {
    param (
        [string]$TargetOrigin,
        [string]$TargetRecordId,
        [switch]$RequireHelloCheck,
        [string]$CustomVaultPath
    )
    if ($RequireHelloCheck) { Assert-WindowsHelloRequirement }
    $canonicalOrigin = Get-CanonicalOrigin $TargetOrigin

    $rawSecret = ""
    if ([System.Console]::IsInputRedirected) {
        $rawSecret = [System.Console]::In.ReadLine()
        if ([string]::IsNullOrEmpty($rawSecret)) {
            throw "Input secret received from stdin was empty."
        }
    } else {
        Write-Host "Auto-Mate Windows Vault :: Store Entry" -ForegroundColor Cyan
        Write-Host "Target Origin : $canonicalOrigin"
        Write-Host "Record ID     : $TargetRecordId"
        
        $sec1 = Read-Host -Prompt "Enter secret" -AsSecureString
        if (-not $sec1 -or $sec1.Length -eq 0) {
            throw "Secret cannot be empty."
        }
        $sec2 = Read-Host -Prompt "Confirm secret" -AsSecureString
        if (-not (Compare-SecureStrings $sec1 $sec2)) {
            throw "Secret confirmation failed: entered values do not match."
        }
        $rawSecret = ConvertTo-PlainString $sec1
    }

    [void](Set-VaultRecord -Origin $canonicalOrigin -RecordId $TargetRecordId -Secret $rawSecret -CustomVaultPath $CustomVaultPath)
    Write-Host "Secret securely stored and DPAPI-encrypted." -ForegroundColor Green
    Write-Host "Origin    : $canonicalOrigin"
    Write-Host "Record ID : $TargetRecordId"
}

function Invoke-Generate {
    param (
        [string]$TargetOrigin,
        [string]$TargetRecordId,
        [int]$PasswordLength,
        [switch]$RequireHelloCheck,
        [string]$CustomVaultPath
    )
    if ($RequireHelloCheck) { Assert-WindowsHelloRequirement }
    $canonicalOrigin = Get-CanonicalOrigin $TargetOrigin
    $genSecret = Generate-SecurePassword -Length $PasswordLength
    [void](Set-VaultRecord -Origin $canonicalOrigin -RecordId $TargetRecordId -Secret $genSecret -CustomVaultPath $CustomVaultPath)

    Write-Host "High-entropy password generated and DPAPI-encrypted." -ForegroundColor Green
    Write-Host "Origin    : $canonicalOrigin"
    Write-Host "Record ID : $TargetRecordId"
    Write-Host "Length    : $PasswordLength"
    Write-Host "Note: Plaintext secret was NOT printed to terminal. Use 'reveal' with confirmation to view." -ForegroundColor Yellow
}

function Invoke-List {
    param (
        [string]$TargetOrigin,
        [string]$CustomVaultPath
    )
    $entries = Get-VaultList -Origin $TargetOrigin -CustomVaultPath $CustomVaultPath
    if ($entries.Count -eq 0) {
        Write-Host "No vault records found matching query." -ForegroundColor Yellow
    } else {
        $tableList = @()
        foreach ($e in $entries) {
            $tableList += [PSCustomObject]@{
                Origin    = $e.origin
                RecordId  = $e.recordId
                CreatedAt = $e.createdAt
                UpdatedAt = $e.updatedAt
            }
        }
        $tableList | Format-Table -AutoSize
    }
}

function Invoke-Reveal {
    param (
        [string]$TargetOrigin,
        [string]$TargetRecordId,
        [switch]$RequireHelloCheck,
        [string]$CustomVaultPath
    )
    if ($RequireHelloCheck) { Assert-WindowsHelloRequirement }
    $canonicalOrigin = Get-CanonicalOrigin $TargetOrigin

    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host "SECURITY WARNING: Explicit Owner Reveal Confirmation" -ForegroundColor Red
    Write-Host "Target Origin : $canonicalOrigin" -ForegroundColor Yellow
    Write-Host "Record ID     : $TargetRecordId" -ForegroundColor Yellow
    Write-Host "==========================================================" -ForegroundColor Red
    
    $confirm = Read-Host "Type 'YES' to confirm revealing secret to console"
    if ($confirm -ne "YES") {
        Write-Host "Reveal aborted by user." -ForegroundColor Yellow
        return
    }

    $secret = Get-VaultRecord -Origin $canonicalOrigin -RecordId $TargetRecordId -CustomVaultPath $CustomVaultPath
    Write-Host "`nSecret for [$TargetRecordId] at [$canonicalOrigin]:" -ForegroundColor Green
    Write-Host $secret -ForegroundColor White
    Write-Host "`nNotice: Clear console when finished.`n" -ForegroundColor DarkGray
}

# ==============================================================================
# Trusted Broker IPC (stdin/stdout JSON)
# ==============================================================================

function Invoke-Broker {
    param ([string]$CustomVaultPath)
    try {
        $stdinText = [System.Console]::In.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($stdinText)) {
            throw "Broker request payload is empty."
        }

        $req = $stdinText | ConvertFrom-Json
        $action = $req.action

        switch ($action) {
            "persist-generated" {
                if ([string]::IsNullOrWhiteSpace($req.origin)) { throw "Missing 'origin' parameter in broker request." }
                if ([string]::IsNullOrWhiteSpace($req.recordId)) { throw "Missing 'recordId' parameter in broker request." }

                $pwdLength = 24
                if ($req.PSObject.Properties["length"] -and [int]$req.length -ge 12) {
                    $pwdLength = [int]$req.length
                }

                $secret = Generate-SecurePassword -Length $pwdLength
                $canonicalOrigin = Set-VaultRecord -Origin $req.origin -RecordId $req.recordId -Secret $secret -CustomVaultPath $CustomVaultPath

                $res = @{
                    success         = $true
                    action          = "persist-generated"
                    origin          = $canonicalOrigin
                    recordId        = [string]$req.recordId
                    generatedSecret = $secret
                }
                [System.Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
                exit 0
            }

            "store-secret" {
                if ([string]::IsNullOrWhiteSpace($req.origin)) { throw "Missing 'origin' parameter in broker request." }
                if ([string]::IsNullOrWhiteSpace($req.recordId)) { throw "Missing 'recordId' parameter in broker request." }
                if ($null -eq $req.secret -or [string]$req.secret -eq "") { throw "Missing 'secret' parameter in broker request." }

                $canonicalOrigin = Set-VaultRecord -Origin $req.origin -RecordId $req.recordId -Secret ([string]$req.secret) -CustomVaultPath $CustomVaultPath

                $res = @{
                    success  = $true
                    action   = "store-secret"
                    origin   = $canonicalOrigin
                    recordId = [string]$req.recordId
                }
                [System.Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
                exit 0
            }

            "retrieve-fill" {
                if ([string]::IsNullOrWhiteSpace($req.origin)) { throw "Missing 'origin' parameter in broker request." }
                if ([string]::IsNullOrWhiteSpace($req.recordId)) { throw "Missing 'recordId' parameter in broker request." }

                $secret = Get-VaultRecord -Origin $req.origin -RecordId $req.recordId -CustomVaultPath $CustomVaultPath
                $canonicalOrigin = Get-CanonicalOrigin $req.origin

                $res = @{
                    success  = $true
                    action   = "retrieve-fill"
                    origin   = $canonicalOrigin
                    recordId = [string]$req.recordId
                    secret   = $secret
                }
                [System.Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
                exit 0
            }

            "list" {
                $filterOrigin = if ($req.PSObject.Properties["origin"]) { [string]$req.origin } else { $null }
                $entries = @(Get-VaultList -Origin $filterOrigin -CustomVaultPath $CustomVaultPath)
                $res = @{
                    success = $true
                    action  = "list"
                    entries = $entries
                }
                [System.Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
                exit 0
            }

            default {
                throw "Unknown broker action '$action'."
            }
        }
    } catch {
        $cleanError = "VAULT_REQUEST_DENIED"
        $errRes = @{
            success = $false
            error   = $cleanError
        }
        [System.Console]::Out.WriteLine(($errRes | ConvertTo-Json -Compress))
        exit 1
    }
}

function Show-Usage {
    Write-Host @"
Auto-Mate Windows Native Vault CLI
Usage:
  -Store    -Origin <https://url> -RecordId <id> [-RequireHello] [-VaultPath <path>]
            Interactively prompts for secret (SecureString) and stores encrypted.
  -Generate -Origin <https://url> -RecordId <id> [-Length <n>] [-RequireHello] [-VaultPath <path>]
            Generates high-entropy CSPRNG password and persists directly without console display.
  -List     [-Origin <https://url>] [-VaultPath <path>]
            Lists stored entry metadata (origins, record IDs, timestamps).
  -Reveal   -Origin <https://url> -RecordId <id> [-RequireHello] [-VaultPath <path>]
            Requires explicit typed confirmation ('YES') before decrypting secret to terminal.
  -Broker   [-VaultPath <path>]
            Runs trusted machine IPC protocol over stdin/stdout JSON.
"@ -ForegroundColor Yellow
}

# ==============================================================================
# Main Dispatcher
# ==============================================================================

$vaultMutex = $null
$vaultMutexHeld = $false
try {
    if ($Broker -or $Store -or $Generate -or $List -or $Reveal) {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $vaultMutex = New-Object System.Threading.Mutex($false, "Global\AutoMateVault-$sid")
        try {
            $vaultMutexHeld = $vaultMutex.WaitOne(30000)
        } catch [System.Threading.AbandonedMutexException] {
            $vaultMutexHeld = $true
        }
        if (-not $vaultMutexHeld) { throw "Vault is busy." }
    }
    if ($Broker) {
        if ($RequireHello) { Assert-WindowsHelloRequirement }
        Invoke-Broker -CustomVaultPath $VaultPath
    } elseif ($Store) {
        Invoke-Store -TargetOrigin $Origin -TargetRecordId $RecordId -RequireHelloCheck:$RequireHello -CustomVaultPath $VaultPath
    } elseif ($Generate) {
        Invoke-Generate -TargetOrigin $Origin -TargetRecordId $RecordId -PasswordLength $Length -RequireHelloCheck:$RequireHello -CustomVaultPath $VaultPath
    } elseif ($List) {
        Invoke-List -TargetOrigin $Origin -CustomVaultPath $VaultPath
    } elseif ($Reveal) {
        Invoke-Reveal -TargetOrigin $Origin -TargetRecordId $RecordId -RequireHelloCheck:$RequireHello -CustomVaultPath $VaultPath
    } else {
        Show-Usage
    }
} catch {
    if ($Broker) {
        $errRes = @{
            success = $false
            error   = "VAULT_REQUEST_DENIED"
        }
        [System.Console]::Out.WriteLine(($errRes | ConvertTo-Json -Compress))
        exit 1
    } else {
        [System.Console]::Error.WriteLine("Error: vault operation denied.")
        exit 1
    }
}
finally {
    if ($vaultMutexHeld) { $vaultMutex.ReleaseMutex() }
    if ($vaultMutex) { $vaultMutex.Dispose() }
}
