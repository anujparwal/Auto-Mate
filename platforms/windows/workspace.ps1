<#
.SYNOPSIS
    Auto-Mate Native Encrypted Workspace Store for Windows.
    Provides DPAPI CurrentUser encrypted storage with v1 envelope,
    atomic persistence, restrictive ACLs, and native Windows Hello gating when appropriate.
#>

[CmdletBinding(DefaultParameterSetName = "Broker")]
param (
    [Parameter(ParameterSetName = "Broker")]
    [switch]$Broker,

    [Parameter(ParameterSetName = "Save")]
    [switch]$Save,

    [Parameter(ParameterSetName = "Load")]
    [switch]$Load,

    [Parameter()]
    [string]$WorkspacePath,

    [Parameter()]
    [switch]$Synthetic,

    [Parameter()]
    [switch]$RequireAuth
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, "Modules")

try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
} catch {
    try {
        Add-Type -AssemblyName "System.Security.Cryptography.ProtectedData" -ErrorAction Stop
    } catch {
        # Fallback to standard environment type resolution
    }
}

function Assert-SyntheticWorkspacePath {
    param ([string]$PathInput)
    if ([string]::IsNullOrWhiteSpace($PathInput)) {
        throw "Synthetic mode requires an explicit -WorkspacePath."
    }
    $resolved = [System.IO.Path]::GetFullPath($PathInput)
    $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $syntheticRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($tempBase, "AutoMate-Synthetic"))

    $rootWithSep = $syntheticRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($rootWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Synthetic workspace path denied: path must be located inside '$syntheticRoot'."
    }
}

function Resolve-WorkspaceFilePath {
    param (
        [string]$PathInput,
        [switch]$Synthetic
    )
    $candidate = $PathInput
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        if (-not [string]::IsNullOrWhiteSpace($WorkspacePath)) {
            $candidate = $WorkspacePath
        } elseif (-not [string]::IsNullOrWhiteSpace($env:AUTOMATE_WORKSPACE_PATH)) {
            $candidate = $env:AUTOMATE_WORKSPACE_PATH
        }
    }

    if ($Synthetic) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            throw "Synthetic mode requires an explicit -WorkspacePath."
        }
        Assert-SyntheticWorkspacePath -PathInput $candidate
    } else {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            $localAppData = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
            if ([string]::IsNullOrWhiteSpace($localAppData)) {
                $localAppData = [System.IO.Path]::Combine($env:USERPROFILE, "AppData", "Local")
            }
            return [System.IO.Path]::Combine($localAppData, "Auto-Mate", "workspace.json")
        }
    }

    if ([System.IO.Directory]::Exists($candidate) -or $candidate.EndsWith("\") -or $candidate.EndsWith("/")) {
        $candidate = [System.IO.Path]::Combine($candidate, "workspace.json")
    }
    $fullPath = [System.IO.Path]::GetFullPath($candidate)
    if ($Synthetic) {
        Assert-SyntheticWorkspacePath -PathInput $fullPath
    }
    return $fullPath
}

function Get-WorkspaceEntropy {
    param ([switch]$Synthetic)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $entropyString = if ($Synthetic) {
            "AutoMate:Synthetic:Workspace:Entropy:v1"
        } else {
            "AutoMate:Workspace:Entropy:v1"
        }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($entropyString)
        return $sha256.ComputeHash($bytes)
    } finally {
        $sha256.Dispose()
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
        throw "Failed to enforce restrictive ACL on workspace storage."
    }
}

function Invoke-WindowsHelloAuth {
    param ([string]$Message = "Auto-Mate: Authenticate to access workspace settings")
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw "WORKSPACE_AUTHENTICATION_REQUIRED"
    }
    $helloScript = Join-Path $PSScriptRoot "hello.ps1"
    if (-not (Test-Path $helloScript)) {
        throw "WORKSPACE_AUTHENTICATION_REQUIRED"
    }

    try {
        . $helloScript
    } catch {
        throw "WORKSPACE_AUTHENTICATION_REQUIRED"
    }

    if (-not (Get-Command -Name "Confirm-WindowsHello" -ErrorAction SilentlyContinue)) {
        throw "WORKSPACE_AUTHENTICATION_REQUIRED"
    }

    $verified = $false
    try {
        $verified = Confirm-WindowsHello -Message $Message -TimeoutSeconds 60
    } catch {
        throw "WORKSPACE_AUTHENTICATION_REQUIRED"
    }

    if ($verified -ne $true) {
        throw "WORKSPACE_AUTHENTICATION_REQUIRED"
    }
}

function Save-WorkspaceData {
    param (
        [string]$FilePath,
        [string]$PayloadJson,
        [switch]$Synthetic
    )
    $dir = [System.IO.Path]::GetDirectoryName($FilePath)
    if (-not [string]::IsNullOrEmpty($dir) -and -not [System.IO.Directory]::Exists($dir)) {
        [System.IO.Directory]::CreateDirectory($dir) | Out-Null
        Set-RestrictiveAcl -Path $dir -IsDirectory $true
    }

    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($PayloadJson)
    $entropy = Get-WorkspaceEntropy -Synthetic:$Synthetic
    $cipherBytes = $null

    try {
        $cipherBytes = [System.Security.Cryptography.ProtectedData]::Protect(
            $payloadBytes,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
    } finally {
        [System.Array]::Clear($payloadBytes, 0, $payloadBytes.Length)
        [System.Array]::Clear($entropy, 0, $entropy.Length)
    }

    $cipherBase64 = [System.Convert]::ToBase64String($cipherBytes)
    $envelope = [ordered]@{
        version    = 1
        cipherText = $cipherBase64
    }
    $envelopeJson = $envelope | ConvertTo-Json -Compress

    $tempFile = [System.IO.Path]::Combine($dir, "workspace_staging_" + [System.Guid]::NewGuid().ToString("N") + ".tmp")
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tempFile, $envelopeJson, $utf8NoBom)
    Set-RestrictiveAcl -Path $tempFile -IsDirectory $false

    if ([System.IO.File]::Exists($FilePath)) {
        try {
            [System.IO.File]::Replace($tempFile, $FilePath, [System.Management.Automation.Language.NullString]::Value)
        } catch {
            if ([System.IO.File]::Exists($tempFile)) {
                try { [System.IO.File]::Delete($tempFile) } catch {}
            }
            throw "Atomic workspace replacement failed."
        }
    } else {
        [System.IO.File]::Move($tempFile, $FilePath)
    }
}

function Load-WorkspaceData {
    param (
        [string]$FilePath,
        [switch]$Synthetic
    )
    if (-not [System.IO.File]::Exists($FilePath)) {
        return $null
    }

    $fileInfo = New-Object System.IO.FileInfo($FilePath)
    if ($fileInfo.Length -eq 0) {
        throw "WORKSPACE_CORRUPTED"
    }

    $content = [System.IO.File]::ReadAllText($FilePath, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($content)) {
        throw "WORKSPACE_CORRUPTED"
    }

    $rawJson = $null
    try {
        $rawJson = $content | ConvertFrom-Json
    } catch {
        throw "WORKSPACE_CORRUPTED"
    }

    if ($null -eq $rawJson -or $null -eq $rawJson.version -or $rawJson.version -ne 1 -or [string]::IsNullOrWhiteSpace($rawJson.cipherText)) {
        throw "WORKSPACE_CORRUPTED"
    }

    $cipherBytes = $null
    try {
        $cipherBytes = [System.Convert]::FromBase64String($rawJson.cipherText)
    } catch {
        throw "WORKSPACE_CORRUPTED"
    }

    $entropy = Get-WorkspaceEntropy -Synthetic:$Synthetic
    $plainBytes = $null
    try {
        $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $cipherBytes,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
    } catch {
        throw "WORKSPACE_CORRUPTED"
    } finally {
        [System.Array]::Clear($entropy, 0, $entropy.Length)
    }

    $innerJson = [System.Text.Encoding]::UTF8.GetString($plainBytes)
    [System.Array]::Clear($plainBytes, 0, $plainBytes.Length)

    try {
        return ($innerJson | ConvertFrom-Json)
    } catch {
        throw "WORKSPACE_CORRUPTED"
    }
}

function Invoke-Broker {
    param (
        [string]$CustomWorkspacePath,
        [switch]$Synthetic
    )
    $rawInput = [System.Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($rawInput)) {
        throw "Empty broker input."
    }

    $req = $null
    try {
        $req = $rawInput | ConvertFrom-Json
    } catch {
        throw "Invalid broker JSON input."
    }

    if ($null -eq $req -or [string]::IsNullOrWhiteSpace($req.action)) {
        throw "Missing broker action."
    }

    $action = [string]$req.action.Trim().ToLowerInvariant()
    $resolvedPath = Resolve-WorkspaceFilePath -PathInput $CustomWorkspacePath -Synthetic:$Synthetic

    switch ($action) {
        "save" {
            if ($null -eq $req.data) {
                throw "Missing 'data' parameter in save request."
            }
            $payloadJson = if ($req.data -is [string]) {
                $req.data
            } else {
                $req.data | ConvertTo-Json -Depth 10 -Compress
            }
            Save-WorkspaceData -FilePath $resolvedPath -PayloadJson $payloadJson -Synthetic:$Synthetic
            $res = [ordered]@{
                success = $true
                action  = "save"
            }
            [System.Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
            return
        }

        "load" {
            $requireAuth = $false
            if ($req.PSObject.Properties["requireAuth"] -and $req.requireAuth -eq $true) {
                $requireAuth = $true
            }

            if ($requireAuth -and -not $Synthetic) {
                Invoke-WindowsHelloAuth -Message "Auto-Mate: Authenticate to reveal saved workspace settings"
            }

            $data = Load-WorkspaceData -FilePath $resolvedPath -Synthetic:$Synthetic
            if ($null -eq $data) {
                $res = [ordered]@{
                    success = $true
                    action  = "load"
                    missing = $true
                }
                [System.Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
                return
            }

            $res = [ordered]@{
                success = $true
                action  = "load"
                missing = $false
                data    = $data
            }
            [System.Console]::Out.WriteLine(($res | ConvertTo-Json -Depth 10 -Compress))
            return
        }

        default {
            throw "Unknown broker action '$action'."
        }
    }
}

# Main Execution
$exitCode = 0
try {
    $brokerUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    [System.Console]::SetIn((New-Object System.IO.StreamReader([System.Console]::OpenStandardInput(), $brokerUtf8, $false)))
    $brokerOutput = New-Object System.IO.StreamWriter([System.Console]::OpenStandardOutput(), $brokerUtf8)
    $brokerOutput.AutoFlush = $true
    [System.Console]::SetOut($brokerOutput)

    if ($Synthetic) {
        Assert-SyntheticWorkspacePath -PathInput $WorkspacePath
    }

    Invoke-Broker -CustomWorkspacePath $WorkspacePath -Synthetic:$Synthetic
} catch {
    $exitCode = 1
    $errObj = [ordered]@{
        success = $false
        error   = [string]$_.Exception.Message
    }
    [System.Console]::Out.WriteLine(($errObj | ConvertTo-Json -Compress))
} finally {
    exit $exitCode
}
