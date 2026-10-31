<#
.SYNOPSIS
    Auto-Mate Windows Hello Native Interop Helper.
    Exposes Get-WindowsHelloAvailability and Confirm-WindowsHello for platform gating.

.DESCRIPTION
    Integrates with Windows 11 desktop UserConsentVerifier via IUserConsentVerifierInterop
    using an owned window and STA thread message pump.
    Fail-closed security invariants:
    - Minimum OS requirement: Windows 11 build 22000+.
    - Availability is diagnostic only, never proof of authentication.
    - Confirm-WindowsHello returns $true ONLY when OS reports UserConsentVerificationResult.Verified.
    - Unconfigured, absent hardware, policy disablement, cancel, and timeout return $false.
    - No vault access or secret logging occurs in this helper.
#>

[CmdletBinding(DefaultParameterSetName = 'None')]
param (
    [Parameter(ParameterSetName = 'CheckAvailability', Mandatory = $true)]
    [switch]$CheckAvailability,

    [Parameter(ParameterSetName = 'Confirm', Mandatory = $true)]
    [switch]$Confirm,

    [Parameter(ParameterSetName = 'Confirm', Mandatory = $false)]
    [string]$Message = 'Auto-Mate Security Verification',

    [Parameter(ParameterSetName = 'Confirm', Mandatory = $false)]
    [int]$TimeoutSeconds = 60,

    [Parameter(ParameterSetName = 'Help', Mandatory = $false)]
    [switch]$Help
)

Set-StrictMode -Version Latest

function Ensure-WindowsHelloNativeType {
    [CmdletBinding()]
    param()

    if (-not ([System.Management.Automation.PSTypeName]'AutoMate.Platforms.Windows.WindowsHello').Type) {
        $csPath = Join-Path -Path $PSScriptRoot -ChildPath 'WindowsHello.cs'
        Add-Type -Path $csPath -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -ErrorAction Stop
    }
}

function Get-WindowsHelloAvailability {
    <#
    .SYNOPSIS
        Queries the current Windows Hello availability from the operating system.
    .OUTPUTS
        [string] One of: 'Available', 'DeviceNotPresent', 'NotConfiguredForUser',
                         'DisabledByPolicy', 'DeviceBusy', or 'Unavailable'.
    #>
    [CmdletBinding()]
    param()
    $op = $null

    try {
        # Check OS version first (Windows 11 build 22000 minimum)
        Ensure-WindowsHelloNativeType
        if (-not [AutoMate.Platforms.Windows.WindowsHello]::IsWindows11OrGreater()) {
            return 'Unavailable'
        }

        # Query WinRT UserConsentVerifier via AsTask reflection
        Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
        $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
        $op = [Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()

        $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
            $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } | Select-Object -First 1

        if ($null -eq $asTaskGeneric) {
            return 'Unavailable'
        }

        $asTask = $asTaskGeneric.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
        $task = $asTask.Invoke($null, @($op))
        $waited = $task.Wait(5000)

        if ($waited -and $task.IsCompleted) {
            return [string]$task.Result
        } else {
            return 'Unavailable'
        }
    } catch {
        return 'Unavailable'
    }
    } finally {
        if ($null -ne $op) {
            try { $op.Cancel() } catch { }
            try { $op.Close() } catch { }
        }
}

function Confirm-WindowsHello {
    <#
    .SYNOPSIS
        Executes interactive Windows Hello verification for an owned desktop window.
    .PARAMETER Message
        Sanitized prompt message shown in the verification context.
    .PARAMETER TimeoutSeconds
        Timeout bound in seconds (default 60, valid range 1-300).
    .OUTPUTS
        [bool] $true ONLY if OS UserConsentVerificationResult.Verified; otherwise $false.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $false)]
        [string]$Message = 'Auto-Mate Security Verification',

        [Parameter(Mandatory = $false)]
        [int]$TimeoutSeconds = 60
    )

    try {
        Ensure-WindowsHelloNativeType
        $result = [AutoMate.Platforms.Windows.WindowsHello]::Confirm($Message, $TimeoutSeconds)
        return [bool]$result
    } catch {
        return $false
    }
}

# CLI / Diagnostic Dispatch
if ($Help) {
    Write-Output "Auto-Mate Windows Hello Native Interop Helper"
    Write-Output "Usage:"
    Write-Output "  . .\hello.ps1                                          (dot-source functions into session)"
    Write-Output "  .\hello.ps1 -CheckAvailability                         (diagnostic OS availability check)"
    Write-Output "  .\hello.ps1 -Confirm [-Message <str>] [-TimeoutSeconds <sec>] (request interactive verification)"
    return
}

if ($CheckAvailability) {
    $availability = Get-WindowsHelloAvailability
    Write-Output $availability
    return
}

if ($Confirm) {
    $verified = Confirm-WindowsHello -Message $Message -TimeoutSeconds $TimeoutSeconds
    Write-Output $verified
    if ($verified) {
        exit 0
    } else {
        exit 1
    }
}
