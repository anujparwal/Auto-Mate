<#
.SYNOPSIS
Installs missing Auto-Mate Windows runtime prerequisites without replacing existing installations.
.DESCRIPTION
Requires Windows 11 x64 build 22000+ and Windows PowerShell 5.1+. Installs Bun 1.4.4
from its official SHA-256-verified release if missing, frozen project dependencies,
and Playwright Chromium. Does not configure or bypass Windows Hello. No GPU, Docker,
Android SDK, vault data, or machine-wide execution policy is changed.
.PARAMETER CheckOnly
Checks existing runtime/dependency/browser availability without installing anything.
.PARAMETER DeveloperTools
Also installs missing Git and GitHub CLI through the official winget source.
.EXAMPLE
powershell.exe -NoProfile -File .\tools\setup-windows.ps1
.EXAMPLE
powershell.exe -NoProfile -File .\tools\setup-windows.ps1 -CheckOnly
#>
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$DeveloperTools)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Auto-Mate requires Windows 11 x64.' }
$build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuild
if ($build -lt 22000 -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Windows 11 x64 build 22000+ and a 64-bit PowerShell process are required.' }
if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw 'Windows PowerShell 5.1 or newer is required.' }
$root = Split-Path -Parent $PSScriptRoot
Write-Host ('Windows build ' + $build + '; PowerShell ' + $PSVersionTable.PSVersion)

if ($DeveloperTools) {
    foreach ($tool in @(@{ Command = 'git'; Id = 'Git.Git' }, @{ Command = 'gh'; Id = 'GitHub.cli' })) {
        $command = Get-Command $tool.Command -ErrorAction SilentlyContinue
        if (-not $command -and $tool.Command -eq 'gh') {
            $installed = Join-Path $env:ProgramFiles 'GitHub CLI/gh.exe'
            if (Test-Path -LiteralPath $installed) { $env:PATH = (Split-Path -Parent $installed) + ';' + $env:PATH; $command = Get-Command gh }
        }
        if (-not $command) {
            if ($CheckOnly) { throw ('Missing developer tool: ' + $tool.Command) }
            if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw ('Install ' + $tool.Id + ' from its official distributor; winget is unavailable.') }
            & winget install --id $tool.Id --exact --source winget --accept-source-agreements --accept-package-agreements
            if ($LASTEXITCODE -ne 0) { throw ('winget failed for ' + $tool.Id) }
            $env:PATH = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
            if (-not (Get-Command $tool.Command -ErrorAction SilentlyContinue)) { throw ('Reopen PowerShell so ' + $tool.Command + ' is on PATH, then rerun setup.') }
        }
        Write-Host ('Developer tool available: ' + $tool.Command)
    }
}

$bunDirectory = Join-Path $env:USERPROFILE '.bun/bin'
if (-not (Get-Command bun -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath (Join-Path $bunDirectory 'bun.exe'))) {
    $env:PATH = $bunDirectory + ';' + $env:PATH
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    if ($CheckOnly) { throw 'Bun is missing. Run setup without -CheckOnly.' }
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('AutoMate-Bun-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $temporary | Out-Null
        $archive = Join-Path $temporary 'bun.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-windows-x64.zip' -OutFile $archive
        # Official release asset digest: https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.4
        $expected = 'cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5'
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Bun archive checksum mismatch; refusing installation.' }
        Expand-Archive -LiteralPath $archive -DestinationPath $temporary
        New-Item -ItemType Directory -Path $bunDirectory -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $temporary 'bun-windows-x64/bun.exe') -Destination (Join-Path $bunDirectory 'bun.exe')
        $env:PATH = $bunDirectory + ';' + $env:PATH
        $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
        if ($userPath.Split(';') -notcontains $bunDirectory) { [Environment]::SetEnvironmentVariable('Path', $userPath.TrimEnd(';') + ';' + $bunDirectory, 'User') }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    }
}
$bunVersion = (& bun --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [version]($bunVersion.Split('-')[0]) -lt [version]'1.4.4') { throw 'Bun 1.4.4+ is required. Existing installations are not silently replaced; update Bun and rerun setup.' }
Write-Host ('Using Bun ' + $bunVersion)
Push-Location $root
try {
    if ($CheckOnly) {
        & bun -e "const {existsSync}=require('node:fs'); const {chromium}=require('playwright'); require('sharp'); if(!existsSync(chromium.executablePath())) throw new Error('Chromium missing'); console.log('Playwright Chromium and Sharp available');"
        if ($LASTEXITCODE -ne 0) { throw 'Dependencies or Chromium are missing. Run setup without -CheckOnly.' }
    } else {
        & bun install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'Frozen dependency installation failed.' }
        & bun x playwright install chromium
        if ($LASTEXITCODE -ne 0) { throw 'Playwright Chromium installation failed.' }
    }
} finally { Pop-Location }
Write-Host 'Prerequisites available. Run bun run typecheck, bun test, and bun run smoke for runtime verification.'
Write-Host 'Use bun start for the local agent workspace. Windows Hello success and workstation lifecycle still require manual hardware checks.'
