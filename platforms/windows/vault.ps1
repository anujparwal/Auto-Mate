<#
.SYNOPSIS
    Auto-Mate Native Encrypted Vault for Windows.
    Provides DPAPI CurrentUser encrypted storage with v2 metadata-protecting envelope,
    CSPRNG password generation, cryptographic origin binding, lossless atomic v1 migration,
    atomic persistence, restrictive ACLs, and default mandatory Windows Hello gating.

.DESCRIPTION
    Security Design & Boundaries:
    1. Cryptography & v2 Envelope:
       - The outer vault file envelope exposes ONLY schema version and ciphertext:
         { "version": 2, "cipherText": "<base64 DPAPI blob>" }
       - No origin, recordId, usernames, timestamps, secrets, or digests are exposed at rest.
       - Authenticated internal vault is protected via DPAPI (DataProtectionScope.CurrentUser)
         with fixed version-specific public entropy SHA-256("AutoMate:Vault:Entropy:v2").
       - Decrypted records are strictly verified for canonical HTTPS origin and recordId match.
    2. Windows Hello Biometric/PIN Verification:
       - Windows Hello authentication via native WinRT desktop interop is mandatory by default
         for ALL normal vault operations (Store, Generate, List, Reveal, Broker).
       - Verification occurs before any vault files are read, written, or migrated, and before
         acquiring the vault concurrency mutex.
       - Hardware availability is NOT authentication. If Hello is unconfigured, absent, canceled,
         busy, or times out, access is denied immediately (VAULT_AUTHENTICATION_REQUIRED).
       - Authentication messages display the requested action and destination origin only;
         secrets and record identifiers are never included in prompts.
    3. Isolated Synthetic Mode (-Synthetic):
       - For automated tests and CI environments where biometric hardware is unavailable.
       - Cryptographically separated DPAPI entropy namespaces:
         * Normal v2:    SHA-256("AutoMate:Vault:Entropy:v2")
         * Synthetic v2: SHA-256("AutoMate:Synthetic:Vault:Entropy:v2")
         * Normal v1:    SHA-256("AutoMate:Vault:OriginEntropy:v1:" + origin)
         * Synthetic v1: SHA-256("AutoMate:Synthetic:Vault:OriginEntropy:v1:" + origin)
       - Strict path isolation: requires explicit -VaultPath inside a child directory under
         [IO.Path]::GetTempPath()/AutoMate-Synthetic/<child>/...; default production path is denied.
       - Strict origin isolation: origins must use reserved .test domains.
       - A synthetic flag CANNOT decrypt normal production v1 or v2 vaults even if files are copied.
       - Successful broker responses declare authentication mode:
         'windows-hello' (normal) or 'synthetic-isolated' (synthetic).
    4. Lossless Atomic v1 Migration:
       - Legacy v1 vaults exposing plaintext origin/recordId metadata with per-record DPAPI
         ciphertext are decrypted, validated, and atomically converted to v2 on load.
       - Preserves record createdAt/updatedAt timestamps, secret, and global created timestamp.
       - Fail-closed: corrupt/tampered records, duplicate identities, or schema errors refuse
         mutation without modifying existing data.
    5. Storage Security: Vault directory and files are configured with restrictive NTFS
       ACLs permitting access ONLY to the current user SID. File inheritance is disabled.
       Fails closed if restrictive permissions cannot be applied.
    6. Threat Boundary: DPAPI CurrentUser does NOT provide per-use biometric prompts by itself;
       Windows Hello provides the per-use owner consent barrier. This CLI is TRUSTED-OWNER ONLY
       and MUST NOT be exposed as an agent tool to AI models.
    7. Secret Hygiene: Secrets are never accepted as command-line arguments.
       Interactive input uses SecureStrings. Error messages never echo sensitive values.
       No secret fingerprints or hashes are stored or returned.
    8. Broker IPC: A dedicated stdin/stdout JSON protocol is provided for the trusted
       parent browser executor over private process pipes. Output is strictly machine JSON.
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

    [Parameter(ParameterSetName = "Diagnostic", Mandatory = $true)]
    [switch]$CheckAvailability,

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

    [Parameter()]
    [switch]$Synthetic,

    [Parameter()]
    [string]$VaultPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Child processes may inherit PowerShell 7 module paths. Resolve native cmdlets
# from this host's built-ins, not an incompatible parent's module directory.
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, "Modules")

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

function Assert-SyntheticVaultPath {
    param ([string]$PathInput)
    if ([string]::IsNullOrWhiteSpace($PathInput)) {
        throw "Synthetic mode requires an explicit -VaultPath."
    }
    $resolved = [System.IO.Path]::GetFullPath($PathInput)
    $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $syntheticRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($tempBase, "AutoMate-Synthetic"))

    $rootWithSep = $syntheticRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($rootWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Synthetic vault path denied: path must be located inside '$syntheticRoot'."
    }

    $relative = $resolved.Substring($rootWithSep.Length)
    $parts = $relative.Split([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    if ($parts.Length -lt 2 -or [string]::IsNullOrWhiteSpace($parts[0])) {
        throw "Synthetic vault path denied: path must be inside a child directory under '$syntheticRoot'."
    }
}

function Resolve-VaultFilePath {
    param (
        [string]$PathInput,
        [switch]$Synthetic
    )
    $candidate = $PathInput
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        if (-not [string]::IsNullOrWhiteSpace($VaultPath)) {
            $candidate = $VaultPath
        } elseif (-not [string]::IsNullOrWhiteSpace($env:AUTOMATE_VAULT_PATH)) {
            $candidate = $env:AUTOMATE_VAULT_PATH
        }
    }

    if ($Synthetic) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            throw "Synthetic mode requires an explicit -VaultPath."
        }
        Assert-SyntheticVaultPath -PathInput $candidate
    } else {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            $localAppData = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
            if ([string]::IsNullOrWhiteSpace($localAppData)) {
                $localAppData = [System.IO.Path]::Combine($env:USERPROFILE, "AppData", "Local")
            }
            return [System.IO.Path]::Combine($localAppData, "Auto-Mate", "vault.json")
        }
    }

    if ([System.IO.Directory]::Exists($candidate) -or $candidate.EndsWith("\") -or $candidate.EndsWith("/")) {
        $candidate = [System.IO.Path]::Combine($candidate, "vault.json")
    }
    $fullPath = [System.IO.Path]::GetFullPath($candidate)
    if ($Synthetic) {
        Assert-SyntheticVaultPath -PathInput $fullPath
    }
    return $fullPath
}

function Get-CanonicalOrigin {
    param (
        [string]$OriginInput,
        [switch]$Synthetic
    )
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

    if ($Synthetic) {
        if (-not $hostName.EndsWith(".test")) {
            throw "Synthetic origin denied: origin host must end with '.test'."
        }
    }

    if ($uriResult.IsDefaultPort) {
        return ("https://{0}" -f $hostName)
    } else {
        return ("https://{0}:{1}" -f $hostName, $uriResult.Port)
    }
}

function Get-V2VaultEntropy {
    param ([switch]$Synthetic)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $entropyString = if ($Synthetic) {
            "AutoMate:Synthetic:Vault:Entropy:v2"
        } else {
            "AutoMate:Vault:Entropy:v2"
        }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($entropyString)
        return $sha256.ComputeHash($bytes)
    } finally {
        $sha256.Dispose()
    }
}

function Get-V1OriginEntropy {
    param (
        [string]$CanonicalOrigin,
        [switch]$Synthetic
    )
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $prefix = if ($Synthetic) {
            "AutoMate:Synthetic:Vault:OriginEntropy:v1:"
        } else {
            "AutoMate:Vault:OriginEntropy:v1:"
        }
        $saltString = $prefix + $CanonicalOrigin
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
            if ([System.IO.File]::Exists($tempFile)) {
                try { [System.IO.File]::Delete($tempFile) } catch {}
            }
            throw "Atomic vault replacement failed. Existing vault was not overwritten."
        }
    } else {
        [System.IO.File]::Move($tempFile, $FilePath)
    }
}

function Save-VaultData {
    param (
        [string]$FilePath,
        [hashtable]$VaultData,
        [switch]$Synthetic
    )
    if ($VaultData.version -ne 2) {
        throw "Cannot save vault: version must be 2."
    }
    if ([string]::IsNullOrWhiteSpace($VaultData.created)) {
        throw "Cannot save vault: created timestamp is missing."
    }
    if ($null -eq $VaultData.records) {
        throw "Cannot save vault: records collection is missing."
    }

    $seenIdentities = New-Object 'System.Collections.Generic.HashSet[string]'
    $cleanRecords = New-Object System.Collections.ArrayList
    foreach ($r in $VaultData.records) {
        if ([string]::IsNullOrWhiteSpace($r.origin)) { throw "Cannot save vault: record missing origin." }
        if ([string]::IsNullOrWhiteSpace($r.recordId)) { throw "Cannot save vault: record missing recordId." }
        if ($null -eq $r.secret -or [string]$r.secret -eq "") { throw "Cannot save vault: record missing secret." }
        if ([string]::IsNullOrWhiteSpace($r.createdAt)) { throw "Cannot save vault: record missing createdAt." }
        if ([string]::IsNullOrWhiteSpace($r.updatedAt)) { throw "Cannot save vault: record missing updatedAt." }
        $canonOrigin = Get-CanonicalOrigin -OriginInput $r.origin -Synthetic:$Synthetic
        $key = "$canonOrigin|$($r.recordId)"
        if ($seenIdentities.Contains($key)) {
            throw "Cannot save vault: duplicate identity detected for origin '$canonOrigin' and recordId '$($r.recordId)'."
        }
        [void]$seenIdentities.Add($key)
        $cleanRecords.Add([PSCustomObject]@{
            origin    = $canonOrigin
            recordId  = [string]$r.recordId
            secret    = [string]$r.secret
            createdAt = [string]$r.createdAt
            updatedAt = [string]$r.updatedAt
        }) | Out-Null
    }

    $internalObj = [PSCustomObject]@{
        version = 2
        created = [string]$VaultData.created
        records = $cleanRecords
    }

    $internalJson = $internalObj | ConvertTo-Json -Depth 10 -Compress
    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($internalJson)
    $v2Entropy = Get-V2VaultEntropy -Synthetic:$Synthetic
    $cipherBytes = $null

    try {
        $cipherBytes = [System.Security.Cryptography.ProtectedData]::Protect(
            $payloadBytes,
            $v2Entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
    } finally {
        [System.Array]::Clear($payloadBytes, 0, $payloadBytes.Length)
        [System.Array]::Clear($v2Entropy, 0, $v2Entropy.Length)
    }

    $cipherBase64 = [System.Convert]::ToBase64String($cipherBytes)

    # v2 envelope exposes ONLY schema version + cipherText
    $envelope = [ordered]@{
        version    = 2
        cipherText = $cipherBase64
    }
    $envelopeJson = $envelope | ConvertTo-Json -Compress

    Save-VaultFileAtomic -FilePath $FilePath -JsonContent $envelopeJson
}

function Assert-VaultObjectSchema {
    param ([object]$Value, [string[]]$Required, [string[]]$Optional = @())
    if ($Value -isnot [System.Management.Automation.PSCustomObject]) { throw "Invalid vault object." }
    $names = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($name in $Required) {
        if ($names -cnotcontains $name) { throw "Missing vault property." }
    }
    foreach ($name in $names) {
        if ($Required -cnotcontains $name -and $Optional -cnotcontains $name) { throw "Unknown vault property." }
    }
}

function Load-VaultData {
    param (
        [string]$FilePath,
        [switch]$AllowMissing,
        [switch]$Synthetic
    )
    if (-not [System.IO.File]::Exists($FilePath)) {
        if ($AllowMissing) {
            return @{
                version = 2
                created = [System.DateTime]::UtcNow.ToString("o")
                records = New-Object System.Collections.ArrayList
            }
        }
        return $null
    }

    $fileInfo = New-Object System.IO.FileInfo($FilePath)
    if ($fileInfo.Length -eq 0) {
        throw "Vault file is empty. Refusing silent fallback."
    }

    $content = [System.IO.File]::ReadAllText($FilePath, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($content)) {
        throw "Vault file contains only whitespace. Refusing silent fallback."
    }

    $rawJson = $null
    try {
        $rawJson = $content | ConvertFrom-Json
    } catch {
        throw "Failed to parse vault file: invalid JSON format."
    }
    if ($rawJson -isnot [System.Management.Automation.PSCustomObject]) {
        throw "Vault must be a JSON object."
    }

    if (-not $rawJson.PSObject.Properties["version"]) {
        throw "Vault file missing required 'version' property."
    }

    if ($rawJson.version -isnot [int] -and $rawJson.version -isnot [long]) { throw "Invalid vault version type." }
    $version = [int]$rawJson.version
    if ($version -ne 1 -and $version -ne 2) {
        throw "Unsupported vault schema version: $version."
    }

    if ($version -eq 2) {
        Assert-VaultObjectSchema -Value $rawJson -Required @("version", "cipherText")
        if ($rawJson.cipherText -isnot [string]) { throw "Invalid vault ciphertext type." }
        $cipherBase64 = $rawJson.cipherText
        if ([string]::IsNullOrWhiteSpace($cipherBase64)) {
            throw "Vault v2 envelope missing or empty 'cipherText'."
        }

        $cipherBytes = $null
        try {
            $cipherBytes = [System.Convert]::FromBase64String($cipherBase64)
        } catch {
            throw "Invalid base64 encoding in vault cipherText."
        }

        $v2Entropy = Get-V2VaultEntropy -Synthetic:$Synthetic
        $plainBytes = $null
        try {
            $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
                $cipherBytes,
                $v2Entropy,
                [System.Security.Cryptography.DataProtectionScope]::CurrentUser
            )
        } catch {
            throw "Vault v2 decryption failed: cryptographic integrity check or entropy mismatch."
        } finally {
            [System.Array]::Clear($v2Entropy, 0, $v2Entropy.Length)
        }

        $innerData = $null
        try {
            $innerJson = [System.Text.Encoding]::UTF8.GetString($plainBytes)
            $innerData = $innerJson | ConvertFrom-Json
        } catch {
            throw "Failed to parse decrypted vault JSON."
        } finally {
            [System.Array]::Clear($plainBytes, 0, $plainBytes.Length)
        }

        Assert-VaultObjectSchema -Value $innerData -Required @("version", "created", "records")
        if ($innerData.version -isnot [int] -and $innerData.version -isnot [long]) { throw "Invalid inner version type." }
        if ($innerData.created -isnot [string] -or $innerData.records -isnot [array]) { throw "Invalid vault payload types." }
        if ($innerData.version -ne 2) {
            throw "Decrypted vault schema version mismatch."
        }
        if ([string]::IsNullOrWhiteSpace($innerData.created)) {
            throw "Decrypted vault missing 'created' timestamp."
        }
        if ($null -eq $innerData.records) {
            throw "Decrypted vault missing 'records' array."
        }

        $recordsList = New-Object System.Collections.ArrayList
        $seenIdentities = New-Object 'System.Collections.Generic.HashSet[string]'
        foreach ($rec in $innerData.records) {
            Assert-VaultObjectSchema -Value $rec -Required @("origin", "recordId", "secret", "createdAt", "updatedAt")
            foreach ($name in @("origin", "recordId", "secret", "createdAt", "updatedAt")) {
                if ($rec.$name -isnot [string]) { throw "Invalid vault record property type." }
            }
            if ([string]::IsNullOrWhiteSpace($rec.origin)) { throw "Vault record missing required 'origin'." }
            if ([string]::IsNullOrWhiteSpace($rec.recordId)) { throw "Vault record missing required 'recordId'." }
            if ($null -eq $rec.secret -or [string]$rec.secret -eq "") { throw "Vault record missing required 'secret'." }
            if ([string]::IsNullOrWhiteSpace($rec.createdAt)) { throw "Vault record missing required 'createdAt'." }
            if ([string]::IsNullOrWhiteSpace($rec.updatedAt)) { throw "Vault record missing required 'updatedAt'." }
            $canonOrigin = Get-CanonicalOrigin -OriginInput $rec.origin -Synthetic:$Synthetic
            $key = "$canonOrigin|$($rec.recordId)"
            if ($seenIdentities.Contains($key)) {
                throw "Duplicate identity detected for origin '$canonOrigin' and recordId '$($rec.recordId)'."
            }
            [void]$seenIdentities.Add($key)
            $recordsList.Add([PSCustomObject]@{
                origin    = $canonOrigin
                recordId  = [string]$rec.recordId
                secret    = [string]$rec.secret
                createdAt = [string]$rec.createdAt
                updatedAt = [string]$rec.updatedAt
            }) | Out-Null
        }

        return @{
            version = 2
            created = [string]$innerData.created
            records = $recordsList
        }
    }

    # Version 1 Legacy Migration: strictly validate and decrypt all per-origin records
    Assert-VaultObjectSchema -Value $rawJson -Required @("version", "records") -Optional @("created")
    if ($rawJson.records -isnot [array]) { throw "Invalid legacy record collection." }
    if ($rawJson.PSObject.Properties["created"] -and
        ($rawJson.created -isnot [string] -or [string]::IsNullOrWhiteSpace($rawJson.created))) { throw "Invalid legacy creation timestamp." }
    if ($null -eq $rawJson.records) {
        throw "Vault v1 missing required 'records' array."
    }

    $seenIdentities = New-Object 'System.Collections.Generic.HashSet[string]'
    $decryptedRecords = New-Object System.Collections.ArrayList

    foreach ($r in $rawJson.records) {
        Assert-VaultObjectSchema -Value $r -Required @("origin", "recordId", "cipherText", "createdAt", "updatedAt")
        foreach ($name in @("origin", "recordId", "cipherText", "createdAt", "updatedAt")) {
            if ($r.$name -isnot [string]) { throw "Invalid legacy record property type." }
        }
        if ([string]::IsNullOrWhiteSpace($r.origin)) { throw "V1 record missing required 'origin'." }
        if ([string]::IsNullOrWhiteSpace($r.recordId)) { throw "V1 record missing required 'recordId'." }
        if ([string]::IsNullOrWhiteSpace($r.cipherText)) { throw "V1 record missing required 'cipherText'." }
        if ([string]::IsNullOrWhiteSpace($r.createdAt)) { throw "V1 record missing required 'createdAt'." }
        if ([string]::IsNullOrWhiteSpace($r.updatedAt)) { throw "V1 record missing required 'updatedAt'." }

        $canonOrigin = Get-CanonicalOrigin -OriginInput $r.origin -Synthetic:$Synthetic
        $key = "$canonOrigin|$($r.recordId)"
        if ($seenIdentities.Contains($key)) {
            throw "Duplicate identity detected in v1 vault for origin '$canonOrigin' and recordId '$($r.recordId)'."
        }
        [void]$seenIdentities.Add($key)

        $cipherBytes = $null
        try {
            $cipherBytes = [System.Convert]::FromBase64String($r.cipherText)
        } catch {
            throw "Invalid base64 encoding in v1 record cipherText."
        }

        $entropy = Get-V1OriginEntropy -CanonicalOrigin $canonOrigin -Synthetic:$Synthetic
        $plainBytes = $null
        try {
            $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
                $cipherBytes,
                $entropy,
                [System.Security.Cryptography.DataProtectionScope]::CurrentUser
            )
        } catch {
            throw "V1 record decryption failed for origin '$canonOrigin': cryptographic integrity check or origin entropy mismatch."
        } finally {
            [System.Array]::Clear($entropy, 0, $entropy.Length)
        }

        $payload = $null
        try {
            $payloadJson = [System.Text.Encoding]::UTF8.GetString($plainBytes)
            $payload = $payloadJson | ConvertFrom-Json
        } catch {
            throw "Failed to parse decrypted v1 record payload JSON."
        } finally {
            [System.Array]::Clear($plainBytes, 0, $plainBytes.Length)
        }

        Assert-VaultObjectSchema -Value $payload -Required @("origin", "recordId", "secret") -Optional @("savedAt")
        foreach ($name in @("origin", "recordId", "secret")) {
            if ($payload.$name -isnot [string]) { throw "Invalid legacy payload property type." }
        }
        if ($payload.origin -cne $canonOrigin) {
            throw "V1 record origin mismatch between metadata and decrypted payload."
        }
        if ($payload.recordId -cne $r.recordId) {
            throw "V1 record recordId mismatch between metadata and decrypted payload."
        }
        if ($null -eq $payload.secret -or [string]$payload.secret -eq "") {
            throw "V1 record secret missing in decrypted payload."
        }

        $decryptedRecords.Add([PSCustomObject]@{
            origin    = $canonOrigin
            recordId  = [string]$r.recordId
            secret    = [string]$payload.secret
            createdAt = [string]$r.createdAt
            updatedAt = [string]$r.updatedAt
        }) | Out-Null
    }

    $v2Created = if ($rawJson.PSObject.Properties["created"] -and -not [string]::IsNullOrWhiteSpace($rawJson.created)) {
        [string]$rawJson.created
    } else {
        [System.DateTime]::UtcNow.ToString("o")
    }

    $v2Data = @{
        version = 2
        created = $v2Created
        records = $decryptedRecords
    }

    # Atomically replace v1 vault with fully encrypted v2 envelope
    Save-VaultData -FilePath $FilePath -VaultData $v2Data -Synthetic:$Synthetic
    return $v2Data
}

function Set-VaultRecord {
    param (
        [string]$Origin,
        [string]$RecordId,
        [string]$Secret,
        [string]$CustomVaultPath,
        [switch]$Synthetic
    )
    $canonicalOrigin = Get-CanonicalOrigin -OriginInput $Origin -Synthetic:$Synthetic
    if ([string]::IsNullOrWhiteSpace($RecordId)) {
        throw "RecordId cannot be null or empty."
    }
    if ($null -eq $Secret -or $Secret.Length -eq 0) {
        throw "Secret cannot be empty."
    }

    $vaultFilePath = Resolve-VaultFilePath -PathInput $CustomVaultPath -Synthetic:$Synthetic
    $vaultData = Load-VaultData -FilePath $vaultFilePath -AllowMissing -Synthetic:$Synthetic

    $now = [System.DateTime]::UtcNow.ToString("o")
    $existingIndex = -1
    for ($i = 0; $i -lt $vaultData.records.Count; $i++) {
        $r = $vaultData.records[$i]
        if ($r.origin -ceq $canonicalOrigin -and $r.recordId -ceq $RecordId) {
            $existingIndex = $i
            break
        }
    }

    $createdAt = $now
    if ($existingIndex -ge 0) {
        $createdAt = $vaultData.records[$existingIndex].createdAt
    }

    $recordItem = [PSCustomObject]@{
        origin    = $canonicalOrigin
        recordId  = $RecordId
        secret    = $Secret
        createdAt = $createdAt
        updatedAt = $now
    }

    if ($existingIndex -ge 0) {
        $vaultData.records[$existingIndex] = $recordItem
    } else {
        $vaultData.records.Add($recordItem) | Out-Null
    }

    Save-VaultData -FilePath $vaultFilePath -VaultData $vaultData -Synthetic:$Synthetic
    return $canonicalOrigin
}

function Get-VaultRecord {
    param (
        [string]$Origin,
        [string]$RecordId,
        [string]$CustomVaultPath,
        [switch]$Synthetic
    )
    $canonicalOrigin = Get-CanonicalOrigin -OriginInput $Origin -Synthetic:$Synthetic
    if ([string]::IsNullOrWhiteSpace($RecordId)) {
        throw "RecordId cannot be null or empty."
    }

    $vaultFilePath = Resolve-VaultFilePath -PathInput $CustomVaultPath -Synthetic:$Synthetic
    $vaultData = Load-VaultData -FilePath $vaultFilePath -Synthetic:$Synthetic
    if ($null -eq $vaultData) {
        throw "Record not found for requested origin and recordId."
    }

    $matched = $null
    foreach ($r in $vaultData.records) {
        if ($r.origin -ceq $canonicalOrigin -and $r.recordId -ceq $RecordId) {
            $matched = $r
            break
        }
    }

    if (-not $matched) {
        throw "Record not found for requested origin and recordId."
    }

    # Exact match verification on inner authenticated payload
    if ($matched.origin -cne $canonicalOrigin -or $matched.recordId -cne $RecordId) {
        throw "Integrity error: decrypted record does not match requested entry."
    }

    return $matched.secret
}

function Get-VaultList {
    param (
        [string]$Origin,
        [string]$CustomVaultPath,
        [switch]$Synthetic
    )
    $vaultFilePath = Resolve-VaultFilePath -PathInput $CustomVaultPath -Synthetic:$Synthetic
    $vaultData = Load-VaultData -FilePath $vaultFilePath -Synthetic:$Synthetic
    if ($null -eq $vaultData) {
        return @()
    }

    $filterOrigin = $null
    if (-not [string]::IsNullOrWhiteSpace($Origin)) {
        $filterOrigin = Get-CanonicalOrigin -OriginInput $Origin -Synthetic:$Synthetic
    }

    $entries = New-Object System.Collections.ArrayList
    foreach ($r in $vaultData.records) {
        if ($filterOrigin -and $r.origin -ne $filterOrigin) {
            continue
        }
        $entries.Add([ordered]@{
            origin    = $r.origin
            recordId  = $r.recordId
            createdAt = $r.createdAt
            updatedAt = $r.updatedAt
        }) | Out-Null
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

# ==============================================================================
# Authentication & Mutex Helpers
# ==============================================================================

function Invoke-WindowsHelloAuth {
    param ([string]$Message)
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw "VAULT_AUTHENTICATION_REQUIRED"
    }
    $helloScript = Join-Path $PSScriptRoot "hello.ps1"
    if (-not (Test-Path $helloScript)) {
        throw "VAULT_AUTHENTICATION_REQUIRED"
    }

    try {
        . $helloScript
    } catch {
        throw "VAULT_AUTHENTICATION_REQUIRED"
    }

    if (-not (Get-Command -Name "Confirm-WindowsHello" -ErrorAction SilentlyContinue)) {
        throw "VAULT_AUTHENTICATION_REQUIRED"
    }

    $verified = $false
    try {
        $verified = Confirm-WindowsHello -Message $Message -TimeoutSeconds 60
    } catch {
        throw "VAULT_AUTHENTICATION_REQUIRED"
    }

    if ($verified -ne $true) {
        throw "VAULT_AUTHENTICATION_REQUIRED"
    }
}

function Invoke-WithVaultMutex {
    param ([scriptblock]$Action)
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = New-Object System.Threading.Mutex($false, "Global\AutoMateVault-$sid")
    $held = $false
    try {
        try {
            $held = $mutex.WaitOne(30000)
        } catch [System.Threading.AbandonedMutexException] {
            $held = $true
        }
        if (-not $held) {
            throw "Vault is busy."
        }
        & $Action
    } finally {
        if ($held) {
            try { $mutex.ReleaseMutex() } catch {}
        }
        $mutex.Dispose()
    }
}

# ==============================================================================
# CLI Operations
# ==============================================================================

function Invoke-Store {
    param (
        [string]$TargetOrigin,
        [string]$TargetRecordId,
        [string]$CustomVaultPath,
        [switch]$Synthetic
    )
    $canonicalOrigin = Get-CanonicalOrigin -OriginInput $TargetOrigin -Synthetic:$Synthetic
    if ([string]::IsNullOrWhiteSpace($TargetRecordId)) {
        throw "RecordId cannot be null or empty."
    }

    if (-not $Synthetic) {
        Invoke-WindowsHelloAuth -Message "Auto-Mate: Store secret for $canonicalOrigin"
    }

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

    Invoke-WithVaultMutex {
        [void](Set-VaultRecord -Origin $canonicalOrigin -RecordId $TargetRecordId -Secret $rawSecret -CustomVaultPath $CustomVaultPath -Synthetic:$Synthetic)
    }
    Write-Host "Secret securely stored and DPAPI-encrypted." -ForegroundColor Green
    Write-Host "Origin    : $canonicalOrigin"
    Write-Host "Record ID : $TargetRecordId"
}

function Invoke-Generate {
    param (
        [string]$TargetOrigin,
        [string]$TargetRecordId,
        [int]$PasswordLength,
        [string]$CustomVaultPath,
        [switch]$Synthetic
    )
    $canonicalOrigin = Get-CanonicalOrigin -OriginInput $TargetOrigin -Synthetic:$Synthetic
    if ([string]::IsNullOrWhiteSpace($TargetRecordId)) {
        throw "RecordId cannot be null or empty."
    }

    if (-not $Synthetic) {
        Invoke-WindowsHelloAuth -Message "Auto-Mate: Generate password for $canonicalOrigin"
    }

    $genSecret = Generate-SecurePassword -Length $PasswordLength
    Invoke-WithVaultMutex {
        [void](Set-VaultRecord -Origin $canonicalOrigin -RecordId $TargetRecordId -Secret $genSecret -CustomVaultPath $CustomVaultPath -Synthetic:$Synthetic)
    }

    Write-Host "High-entropy password generated and DPAPI-encrypted." -ForegroundColor Green
    Write-Host "Origin    : $canonicalOrigin"
    Write-Host "Record ID : $TargetRecordId"
    Write-Host "Length    : $PasswordLength"
    Write-Host "Note: Plaintext secret was NOT printed to terminal. Use 'reveal' with confirmation to view." -ForegroundColor Yellow
}

function Invoke-List {
    param (
        [string]$TargetOrigin,
        [string]$CustomVaultPath,
        [switch]$Synthetic
    )
    $canonicalOrigin = $null
    if (-not [string]::IsNullOrWhiteSpace($TargetOrigin)) {
        $canonicalOrigin = Get-CanonicalOrigin -OriginInput $TargetOrigin -Synthetic:$Synthetic
    }

    if (-not $Synthetic) {
        $msg = if ($canonicalOrigin) {
            "Auto-Mate: List vault entries for $canonicalOrigin"
        } else {
            "Auto-Mate: List vault entries"
        }
        Invoke-WindowsHelloAuth -Message $msg
    }

    $entries = @(Invoke-WithVaultMutex {
        Get-VaultList -Origin $canonicalOrigin -CustomVaultPath $CustomVaultPath -Synthetic:$Synthetic
    })

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
        [string]$CustomVaultPath,
        [switch]$Synthetic
    )
    $canonicalOrigin = Get-CanonicalOrigin -OriginInput $TargetOrigin -Synthetic:$Synthetic
    if ([string]::IsNullOrWhiteSpace($TargetRecordId)) {
        throw "RecordId cannot be null or empty."
    }

    if (-not $Synthetic) {
        Invoke-WindowsHelloAuth -Message "Auto-Mate: Reveal secret for $canonicalOrigin"
    }

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

    $secret = Invoke-WithVaultMutex {
        Get-VaultRecord -Origin $canonicalOrigin -RecordId $TargetRecordId -CustomVaultPath $CustomVaultPath -Synthetic:$Synthetic
    }
    Write-Host "`nSecret for [$TargetRecordId] at [$canonicalOrigin]:" -ForegroundColor Green
    Write-Host $secret -ForegroundColor White
    Write-Host "`nNotice: Clear console when finished.`n" -ForegroundColor DarkGray
}

# ==============================================================================
# Trusted Broker IPC (stdin/stdout JSON)
# ==============================================================================

function Invoke-Broker {
    param (
        [string]$CustomVaultPath,
        [switch]$Synthetic
    )
    $stdinText = [System.Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($stdinText)) {
        throw "Broker request payload is empty."
    }

    $req = $null
    try {
        $req = $stdinText | ConvertFrom-Json
    } catch {
        throw "Broker request is not valid JSON."
    }

    if ($null -eq $req -or -not $req.PSObject.Properties["action"]) {
        throw "Missing 'action' parameter in broker request."
    }

    $action = [string]$req.action
    $authMode = if ($Synthetic) { "synthetic-isolated" } else { "windows-hello" }

    switch ($action) {
        "persist-generated" {
            if ([string]::IsNullOrWhiteSpace($req.origin)) { throw "Missing 'origin' parameter in broker request." }
            if ([string]::IsNullOrWhiteSpace($req.recordId)) { throw "Missing 'recordId' parameter in broker request." }

            $canonicalOrigin = Get-CanonicalOrigin -OriginInput $req.origin -Synthetic:$Synthetic

            if (-not $Synthetic) {
                Invoke-WindowsHelloAuth -Message "Auto-Mate Broker: Generate password for $canonicalOrigin"
            }

            $pwdLength = 24
            if ($req.PSObject.Properties["length"] -and [int]$req.length -ge 12) {
                $pwdLength = [int]$req.length
            }

            $secret = Generate-SecurePassword -Length $pwdLength
            Invoke-WithVaultMutex {
                [void](Set-VaultRecord -Origin $canonicalOrigin -RecordId $req.recordId -Secret $secret -CustomVaultPath $CustomVaultPath -Synthetic:$Synthetic)
            }

            $res = [ordered]@{
                success         = $true
                authentication  = $authMode
                action          = "persist-generated"
                origin          = $canonicalOrigin
                recordId        = [string]$req.recordId
                generatedSecret = $secret
            }
            [System.Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
            return
        }

        "store-secret" {
            if ([string]::IsNullOrWhiteSpace($req.origin)) { throw "Missing 'origin' parameter in broker request." }
            if ([string]::IsNullOrWhiteSpace($req.recordId)) { throw "Missing 'recordId' parameter in broker request." }
            if ($null -eq $req.secret -or [string]$req.secret -eq "") { throw "Missing 'secret' parameter in broker request." }

            $canonicalOrigin = Get-CanonicalOrigin -OriginInput $req.origin -Synthetic:$Synthetic

            if (-not $Synthetic) {
                Invoke-WindowsHelloAuth -Message "Auto-Mate Broker: Store secret for $canonicalOrigin"
            }

            Invoke-WithVaultMutex {
                [void](Set-VaultRecord -Origin $canonicalOrigin -RecordId $req.recordId -Secret ([string]$req.secret) -CustomVaultPath $CustomVaultPath -Synthetic:$Synthetic)
            }

            $res = [ordered]@{
                success        = $true
                authentication = $authMode
                action         = "store-secret"
                origin         = $canonicalOrigin
                recordId       = [string]$req.recordId
            }
            [System.Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
            return
        }

        "retrieve-fill" {
            if ([string]::IsNullOrWhiteSpace($req.origin)) { throw "Missing 'origin' parameter in broker request." }
            if ([string]::IsNullOrWhiteSpace($req.recordId)) { throw "Missing 'recordId' parameter in broker request." }

            $canonicalOrigin = Get-CanonicalOrigin -OriginInput $req.origin -Synthetic:$Synthetic

            if (-not $Synthetic) {
                Invoke-WindowsHelloAuth -Message "Auto-Mate Broker: Retrieve secret for $canonicalOrigin"
            }

            $secret = Invoke-WithVaultMutex {
                Get-VaultRecord -Origin $canonicalOrigin -RecordId $req.recordId -CustomVaultPath $CustomVaultPath -Synthetic:$Synthetic
            }

            $res = [ordered]@{
                success        = $true
                authentication = $authMode
                action         = "retrieve-fill"
                origin         = $canonicalOrigin
                recordId       = [string]$req.recordId
                secret         = $secret
            }
            [System.Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
            return
        }

        "list" {
            $filterOrigin = $null
            if ($req.PSObject.Properties["origin"] -and -not [string]::IsNullOrWhiteSpace($req.origin)) {
                $filterOrigin = Get-CanonicalOrigin -OriginInput $req.origin -Synthetic:$Synthetic
            }

            if (-not $Synthetic) {
                $msg = if ($filterOrigin) {
                    "Auto-Mate Broker: List entries for $filterOrigin"
                } else {
                    "Auto-Mate Broker: List vault entries"
                }
                Invoke-WindowsHelloAuth -Message $msg
            }

            $entries = @(Invoke-WithVaultMutex {
                Get-VaultList -Origin $filterOrigin -CustomVaultPath $CustomVaultPath -Synthetic:$Synthetic
            })

            $res = [ordered]@{
                success        = $true
                authentication = $authMode
                action         = "list"
                entries        = $entries
            }
            [System.Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
            return
        }

        default {
            throw "Unknown broker action '$action'."
        }
    }
}

function Show-Usage {
    Write-Host @"
Auto-Mate Windows Native Vault CLI
Usage:
  -Store    -Origin <https://url> -RecordId <id> [-VaultPath <path>] [-Synthetic]
            Interactively prompts for secret (SecureString) and stores encrypted.
  -Generate -Origin <https://url> -RecordId <id> [-Length <n>] [-VaultPath <path>] [-Synthetic]
            Generates high-entropy CSPRNG password and persists directly without console display.
  -List     [-Origin <https://url>] [-VaultPath <path>] [-Synthetic]
            Lists stored entry metadata (origins, record IDs, timestamps).
  -Reveal   -Origin <https://url> -RecordId <id> [-VaultPath <path>] [-Synthetic]
            Requires explicit typed confirmation ('YES') before decrypting secret to terminal.
  -Broker   [-VaultPath <path>] [-Synthetic]
            Runs trusted machine IPC protocol over stdin/stdout JSON.
  -CheckAvailability
            Diagnostic: returns Windows Hello hardware availability status without touching vault.

Security:
  - Windows Hello biometric/PIN authentication is mandatory for all normal operations.
  - Synthetic mode (-Synthetic) is restricted to automated tests: requires an explicit
    -VaultPath under Temp/AutoMate-Synthetic/<child>/ and .test origins. Synthetic mode
    uses isolated DPAPI entropy namespaces and cannot read or write production vaults.
"@ -ForegroundColor Yellow
}

# ==============================================================================
# Main Dispatcher
# ==============================================================================

$exitCode = 0
try {
    if ($Synthetic) {
        Assert-SyntheticVaultPath -PathInput $VaultPath
    }

    if ($Broker) {
        Invoke-Broker -CustomVaultPath $VaultPath -Synthetic:$Synthetic
    } elseif ($Store) {
        Invoke-Store -TargetOrigin $Origin -TargetRecordId $RecordId -CustomVaultPath $VaultPath -Synthetic:$Synthetic
    } elseif ($Generate) {
        Invoke-Generate -TargetOrigin $Origin -TargetRecordId $RecordId -PasswordLength $Length -CustomVaultPath $VaultPath -Synthetic:$Synthetic
    } elseif ($List) {
        Invoke-List -TargetOrigin $Origin -CustomVaultPath $VaultPath -Synthetic:$Synthetic
    } elseif ($Reveal) {
        Invoke-Reveal -TargetOrigin $Origin -TargetRecordId $RecordId -CustomVaultPath $VaultPath -Synthetic:$Synthetic
    } elseif ($CheckAvailability) {
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
        if ([string]::IsNullOrWhiteSpace($scriptDir)) {
            $scriptDir = $PSScriptRoot
        }
        if ([string]::IsNullOrWhiteSpace($scriptDir)) {
            $scriptDir = "."
        }
        $helloScript = Join-Path $scriptDir "hello.ps1"
        if (Test-Path $helloScript) {
            . $helloScript
            if (Get-Command -Name "Get-WindowsHelloAvailability" -ErrorAction SilentlyContinue) {
                $avail = Get-WindowsHelloAvailability
                Write-Host $avail
            } else {
                Write-Host "Unavailable"
            }
        } else {
            Write-Host "Unavailable"
        }
    } else {
        Show-Usage
    }
} catch {
    $exitCode = 1
    $isAuthError = ($_.Exception.Message -eq "VAULT_AUTHENTICATION_REQUIRED" -or
                    ($_.Exception.InnerException -and $_.Exception.InnerException.Message -eq "VAULT_AUTHENTICATION_REQUIRED"))
    if ($Broker) {
        $errorCode = if ($isAuthError) { "VAULT_AUTHENTICATION_REQUIRED" } else { "VAULT_REQUEST_DENIED" }
        $errRes = [ordered]@{
            success = $false
            error   = $errorCode
        }
        [System.Console]::Out.WriteLine(($errRes | ConvertTo-Json -Compress))
    } else {
        if ($isAuthError) {
            [System.Console]::Error.WriteLine("VAULT_AUTHENTICATION_REQUIRED")
        } else {
            [System.Console]::Error.WriteLine("VAULT_REQUEST_DENIED")
        }
    }
} finally {
    if ($exitCode -ne 0) { exit $exitCode }
}
