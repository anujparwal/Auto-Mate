<#
.SYNOPSIS
Exercises the actual portable archive with only Windows system tools on PATH.
.DESCRIPTION
Extracts to an owned temporary path containing spaces and Unicode, checks the
application-only boundary, and invokes the bundled executable's real DPAPI and
Chromium smoke. No normal vault or successful Hello operation is authorized.
#>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$version = [string](Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$name = 'Auto-Mate-' + $version + '-windows-x64'
$archive = Join-Path $root ('dist/app/' + $name + '.zip')
$expectedHash = ((Get-Content -LiteralPath (Join-Path $root 'dist/app/SHA256SUMS.txt') -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Application archive checksum mismatch.'
}
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($entry in $zip.Entries) {
        if (-not $entry.FullName.StartsWith($name + '/', [StringComparison]::Ordinal) -or
            $entry.FullName.Contains('..') -or $entry.FullName.Contains('\')) {
            throw ('Unsafe or unexpected archive path: ' + $entry.FullName)
        }
        $relative = $entry.FullName.Substring($name.Length + 1)
        if ($relative -match '^(site|homepage|public)/' -or
            $relative -match '^ui/owner-preview\.(html|js)$' -or
            $relative -match '^tools/(preview|start)\.ts$' -or
            $relative -match '^src/(owner-preview|task-planner)\.ts$' -or
            $relative -match '(^|/)(CONTEXT\.MD|\.env(?:\..*)?|vault\.json|\.git|\.local)(/|$)' -or
            $relative -match '\.(pem|pfx|p12|key|keystore|jks)$') {
            throw ('Forbidden application release content: ' + $relative)
        }
    }
} finally { $zip.Dispose() }

# Construct the accented character without relying on Windows PowerShell's
# interpretation of a UTF-8-without-BOM script source file.
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('AM ' + [char]0x00E9 + ' ' + [guid]::NewGuid().ToString('N'))
$process = $null
try {
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $temporary)
    $application = Join-Path $temporary $name
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $application 'Auto-Mate.exe'
    $start.Arguments = '--check'
    $start.WorkingDirectory = $application
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $start.StandardOutputEncoding = $utf8
    $start.StandardErrorEncoding = $utf8
    $start.EnvironmentVariables['PATH'] = @(
        (Join-Path $env:SystemRoot 'System32'),
        $env:SystemRoot,
        (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0'),
        (Join-Path $env:SystemRoot 'System32/Wbem')
    ) -join ';'
    foreach ($variable in @('NODE_PATH', 'NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_INSTALL')) {
        $start.EnvironmentVariables.Remove($variable)
    }
    $process = [Diagnostics.Process]::Start($start)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(120000)) {
        $process.Kill()
        $process.WaitForExit()
        throw 'Bundled application check timed out; its owned process tree was terminated.'
    }
    $output = $stdout.GetAwaiter().GetResult()
    $errors = $stderr.GetAwaiter().GetResult()
    if ($output) { Write-Host $output }
    if ($errors) { Write-Host $errors }
    if ($process.ExitCode -ne 0) { throw ('Bundled application check failed with exit ' + $process.ExitCode) }
    Write-Host 'PASS: extracted app-only archive runs actual DPAPI/Chromium execution with global Bun/Node excluded from PATH, from a spaced Unicode path.'
} finally {
    if ($process) {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
