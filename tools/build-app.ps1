<#
.SYNOPSIS
Builds the standalone offline Windows portable application package under dist/app.
.DESCRIPTION
Requires Windows 11 x64 and Windows PowerShell 5.1+. Compiles the native Auto-Mate.exe
launcher using the built-in Microsoft .NET Framework 64-bit C# compiler (csc.exe),
bundles verified Bun 1.4.4 runtime, Playwright Chromium resources, locked production
dependencies, application source/UI assets, native Windows helpers, third-party licenses,
and release manifest. Strictly validates every source tree and descendant against
reparse points and private artifacts. Excludes private data, keys, vaults, and website/demo artifacts.
.PARAMETER CheckOnly
Validates compiler, runtime, and browser availability without building the package.
.PARAMETER CompressionLevel
Compression level for the portable zip archive (Optimal or Fastest; defaults to Optimal).
.EXAMPLE
powershell.exe -NoProfile -File .\tools\build-app.ps1
.EXAMPLE
powershell.exe -NoProfile -File .\tools\build-app.ps1 -CheckOnly
#>
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [System.IO.Compression.CompressionLevel]$CompressionLevel = [System.IO.Compression.CompressionLevel]::Optimal
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Guard against cross-PowerShell module conflicts (e.g., PS7 modules leaking into Windows PS 5.1)
$env:PSModulePath = Join-Path $PSHOME 'Modules'

# Environment and architecture verification
if ($env:OS -ne 'Windows_NT') { throw 'Auto-Mate Windows portable package must be built on Windows.' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Building Auto-Mate portable package requires 64-bit AMD64 architecture.' }
$build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuild
if ($build -lt 22000) { throw ('Windows 11 x64 build 22000+ is required (found build ' + $build + ').') }
if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw 'Windows PowerShell 5.1 or newer is required.' }

$root = Split-Path -Parent $PSScriptRoot

# 1. Compiler verification
$csc = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    throw ('Microsoft .NET Framework 64-bit C# compiler not found at: ' + $csc)
}

# 2. Bun executable discovery and exact version pinning (1.4.4)
$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
$bunExe = $null
if ($bunCommand) {
    $bunExe = $bunCommand.Source
} elseif (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.bun/bin/bun.exe')) {
    $bunExe = Join-Path $env:USERPROFILE '.bun/bin/bun.exe'
}
if (-not $bunExe -or -not (Test-Path -LiteralPath $bunExe)) {
    throw 'Bun executable is missing. Run powershell.exe -NoProfile -File tools/setup-windows.ps1 first.'
}
$bunVersion = (& $bunExe --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $bunVersion.Split('-')[0] -ne '1.4.4') {
    throw ('Bun 1.4.4 is required for this release bundle (found ' + $bunVersion + ').')
}

# 3. Playwright browser discovery
$browsersSourceDir = $null
if ($env:PLAYWRIGHT_BROWSERS_PATH -and (Test-Path -LiteralPath $env:PLAYWRIGHT_BROWSERS_PATH)) {
    $browsersSourceDir = $env:PLAYWRIGHT_BROWSERS_PATH
} else {
    $browsersSourceDir = Join-Path $env:LOCALAPPDATA 'ms-playwright'
}
$chromiumDir = Join-Path $browsersSourceDir 'chromium-1248'
$headlessShellDir = Join-Path $browsersSourceDir 'chromium_headless_shell-1248'
if (-not (Test-Path -LiteralPath $chromiumDir) -or -not (Test-Path -LiteralPath $headlessShellDir)) {
    if ($CheckOnly) {
        throw ('Playwright Chromium resources missing in: ' + $browsersSourceDir)
    }
    Write-Host 'Playwright Chromium resources missing; installing via Bun...'
    Push-Location $root
    try {
        & $bunExe x playwright install chromium
        if ($LASTEXITCODE -ne 0) { throw 'Playwright Chromium download failed.' }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path -LiteralPath $chromiumDir)) { throw ('Missing Playwright Chromium directory: ' + $chromiumDir) }
if (-not (Test-Path -LiteralPath $headlessShellDir)) { throw ('Missing Playwright headless shell directory: ' + $headlessShellDir) }

# 4. Version and Package metadata
$packageJsonPath = Join-Path $root 'package.json'
if (-not (Test-Path -LiteralPath $packageJsonPath)) { throw 'package.json missing.' }
$pkg = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$version = [string]$pkg.version
if (-not $version) { throw 'Package version not defined in package.json.' }
$expectedVersion = '0.1.0-preview.1'
if ($version -ne $expectedVersion) {
    throw ('Expected version ' + $expectedVersion + ' in package.json, found ' + $version)
}

Write-Host ('Auto-Mate Windows Portable Bundle Builder')
Write-Host ('Version: ' + $version)
Write-Host ('Compiler: ' + $csc)
Write-Host ('Bun Runtime: ' + $bunVersion + ' (' + $bunExe + ')')
Write-Host ('Playwright Browsers: ' + $browsersSourceDir)

if ($CheckOnly) {
    Write-Host 'Pre-flight check passed. All compilers, runtimes, and browser resources are present.'
    return
}

$distApp = Join-Path $root 'dist/app'
$staging = Join-Path ([IO.Path]::GetTempPath()) ('AutoMate-Bundle-' + [guid]::NewGuid().ToString('N'))
$bundleFolderName = 'Auto-Mate-' + $version + '-windows-x64'
$bundleRoot = Join-Path $staging $bundleFolderName

# Rejection patterns for private or generated package sources
$privatePattern = '^(\.env(?:\..*)?|\.git|\.local|node_modules|vault\.json)$'
$secretExtPattern = '\.(vault(?:\.json)?|pem|pfx|p12|key|keystore|jks)$'

function Assert-SafePathItem {
    param([Parameter(Mandatory=$true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('Refusing symlink/reparse point source: ' + $item.FullName)
    }
    $ancestor = if ($item.PSIsContainer) { $item.Parent } else { $item.Directory }
    while ($null -ne $ancestor) {
        if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw ('Refusing reparse point source ancestor: ' + $ancestor.FullName)
        }
        $ancestor = $ancestor.Parent
    }
    if ($item.Name -match $privatePattern -or $item.Name -match $secretExtPattern) {
        throw ('Refusing private/secret source file: ' + $item.FullName)
    }
}

function Copy-ValidatedTree {
    param(
        [Parameter(Mandatory=$true)][string]$Source,
        [Parameter(Mandatory=$true)][string]$Destination,
        [string[]]$ExcludeNames = @()
    )
    Assert-SafePathItem -Path $Source
    if (Test-Path -LiteralPath $Source -PathType Container) {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        $descendants = Get-ChildItem -LiteralPath $Source -Recurse -Force
        foreach ($child in $descendants) {
            Assert-SafePathItem -Path $child.FullName
            if ($ExcludeNames -contains $child.Name) { continue }
            $rel = $child.FullName.Substring($Source.Length).TrimStart('\', '/')
            $destPath = Join-Path $Destination $rel
            if ($child.PSIsContainer) {
                New-Item -ItemType Directory -Path $destPath -Force | Out-Null
            } else {
                New-Item -ItemType Directory -Path (Split-Path -Parent $destPath) -Force | Out-Null
                Copy-Item -LiteralPath $child.FullName -Destination $destPath
            }
        }
    } else {
        New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
        Copy-Item -LiteralPath $Source -Destination $Destination
    }
}

try {
    New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null

    # Copy and validate src/ (excluding prototype/demo planning files)
    $srcSource = Join-Path $root 'src'
    Copy-ValidatedTree -Source $srcSource -Destination (Join-Path $bundleRoot 'src') -ExcludeNames @('owner-preview.ts', 'task-planner.ts')

    # Copy and validate ui/ assets for normal owner app (excluding demo page files)
    $uiTarget = Join-Path $bundleRoot 'ui'
    New-Item -ItemType Directory -Path $uiTarget -Force | Out-Null
    foreach ($uiFile in @('autofill.html', 'autofill.js', 'autofill.css', 'owner-preview.css')) {
        $srcFile = Join-Path $root ('ui/' + $uiFile)
        if (-not (Test-Path -LiteralPath $srcFile)) { throw ('Missing required UI asset: ' + $uiFile) }
        Copy-ValidatedTree -Source $srcFile -Destination (Join-Path $uiTarget $uiFile)
    }

    # Copy platforms/windows/ helpers (session-monitor.ps1, vault.ps1, hello.ps1, WindowsHello.cs, README.md)
    $pwTarget = Join-Path $bundleRoot 'platforms/windows'
    New-Item -ItemType Directory -Path $pwTarget -Force | Out-Null
    foreach ($winFile in @('session-monitor.ps1', 'vault.ps1', 'hello.ps1', 'WindowsHello.cs', 'README.md')) {
        $srcFile = Join-Path $root ('platforms/windows/' + $winFile)
        if (-not (Test-Path -LiteralPath $srcFile)) { throw ('Missing required native Windows helper: ' + $winFile) }
        Copy-ValidatedTree -Source $srcFile -Destination (Join-Path $pwTarget $winFile)
    }

    # Copy tools/ entrypoints (run-app.ts, smoke.ts) - strictly excluding preview.ts, demo*, and build scripts
    $toolsTarget = Join-Path $bundleRoot 'tools'
    New-Item -ItemType Directory -Path $toolsTarget -Force | Out-Null
    foreach ($toolFile in @('run-app.ts', 'smoke.ts')) {
        $srcFile = Join-Path $root ('tools/' + $toolFile)
        if (-not (Test-Path -LiteralPath $srcFile)) { throw ('Missing required application tool: ' + $toolFile) }
        Copy-ValidatedTree -Source $srcFile -Destination (Join-Path $toolsTarget $toolFile)
    }

    # Runtime metadata must not advertise source-only scripts absent from the app.
    Assert-SafePathItem -Path (Join-Path $root 'package.json')
    $runtimePackage = [ordered]@{ name = 'auto-mate'; version = $version; private = $true; type = 'module' }
    [IO.File]::WriteAllText((Join-Path $bundleRoot 'package.json'), ($runtimePackage | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath (Join-Path $root 'tsconfig.json')) {
        Copy-ValidatedTree -Source (Join-Path $root 'tsconfig.json') -Destination (Join-Path $bundleRoot 'tsconfig.json')
    }

    # Copy Third Party Licenses
    $licensesSource = Join-Path $root 'platforms/windows/launcher/THIRD_PARTY_LICENSES.txt'
    if (-not (Test-Path -LiteralPath $licensesSource)) { throw 'Missing THIRD_PARTY_LICENSES.txt in platforms/windows/launcher' }
    Copy-ValidatedTree -Source $licensesSource -Destination (Join-Path $bundleRoot 'THIRD_PARTY_LICENSES.txt')
    $licenseTree = Join-Path $root 'platforms/windows/launcher/licenses'
    foreach ($index in @('common/sources.json', 'bun/INDEX.json', 'native/INDEX.json', 'browser/INDEX.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $licenseTree $index))) { throw ('Missing required license source index: ' + $index) }
    }
    Copy-ValidatedTree -Source $licenseTree -Destination (Join-Path $bundleRoot 'licenses')
    $guideSource = Join-Path $root 'use.md'
    Assert-SafePathItem -Path $guideSource
    $guide = [IO.File]::ReadAllText($guideSource, [Text.Encoding]::UTF8)
    $sourceBase = 'https://github.com/anujparwal/Auto-Mate/blob/v' + $version + '/'
    $guide = $guide.Replace('](README.md', ('](' + $sourceBase + 'README.md')).Replace('](docs/', ('](' + $sourceBase + 'docs/'))
    [IO.File]::WriteAllText((Join-Path $bundleRoot 'USE.md'), $guide, (New-Object Text.UTF8Encoding($false)))

    # Copy Bun binary to bin/bun.exe
    Assert-SafePathItem -Path $bunExe
    $binTarget = Join-Path $bundleRoot 'bin'
    New-Item -ItemType Directory -Path $binTarget -Force | Out-Null
    Copy-Item -LiteralPath $bunExe -Destination (Join-Path $binTarget 'bun.exe')
    $bunHash = (Get-FileHash -LiteralPath (Join-Path $binTarget 'bun.exe') -Algorithm SHA256).Hash.ToLowerInvariant()

    # Copy explicit runtime packages, including Sharp's JavaScript colour dependency.
    $nmTarget = Join-Path $bundleRoot 'node_modules'
    New-Item -ItemType Directory -Path $nmTarget -Force | Out-Null
    $prodModules = @('playwright', 'playwright-core', 'sharp', '@img/colour', '@img/sharp-win32-x64', 'detect-libc', 'semver')
    foreach ($mod in $prodModules) {
        $modSource = Join-Path $root ('node_modules/' + $mod)
        if (-not (Test-Path -LiteralPath $modSource)) { throw ('Missing required production dependency: node_modules/' + $mod) }
        $modDest = Join-Path $nmTarget $mod
        Copy-ValidatedTree -Source $modSource -Destination $modDest
    }

    # Copy Playwright browser resources to browsers/ with descendant validation
    $browsersTarget = Join-Path $bundleRoot 'browsers'
    New-Item -ItemType Directory -Path $browsersTarget -Force | Out-Null
    Copy-ValidatedTree -Source $chromiumDir -Destination (Join-Path $browsersTarget 'chromium-1248')
    Copy-ValidatedTree -Source $headlessShellDir -Destination (Join-Path $browsersTarget 'chromium_headless_shell-1248')
    $ffmpegDir = Join-Path $browsersSourceDir 'ffmpeg-1013'
    if (Test-Path -LiteralPath $ffmpegDir) {
        Copy-ValidatedTree -Source $ffmpegDir -Destination (Join-Path $browsersTarget 'ffmpeg-1013')
    }

    # Compile native Auto-Mate.exe launcher
    $launcherSource = Join-Path $root 'platforms/windows/launcher/AutoMateLauncher.cs'
    $manifestSource = Join-Path $root 'platforms/windows/launcher/app.manifest'
    Assert-SafePathItem -Path $launcherSource
    Assert-SafePathItem -Path $manifestSource
    $launcherExe = Join-Path $bundleRoot 'Auto-Mate.exe'
    & $csc /nologo /platform:x64 /target:exe /reference:System.Windows.Forms.dll,System.Drawing.dll /win32manifest:$manifestSource /out:$launcherExe $launcherSource
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherExe)) {
        throw 'Compilation of Auto-Mate.exe launcher failed.'
    }
    $launcherHash = (Get-FileHash -LiteralPath $launcherExe -Algorithm SHA256).Hash.ToLowerInvariant()

    # Generate RELEASE-MANIFEST.json
    $manifestData = [ordered]@{
        name = "Auto-Mate"
        version = $version
        channel = "private-preview"
        platform = "win32-x64"
        releaseType = "portable-application"
        targetOs = "Windows 11 x64 (Build 22000+)"
        unsigned = $true
        security = [ordered]@{
            classification = "Unsigned Developer Preview"
            authenticationRequired = "Windows Hello (biometric/PIN) for normal vaults"
            dpapiScope = "CurrentUser"
            applicationTelemetry = "No Auto-Mate telemetry collector configured; destination and browser networking have separate terms."
            cloudSync = "none"
            auditJournal = "%LOCALAPPDATA%\\AutoMate\\audit"
        }
        binaries = [ordered]@{
            launcher = [ordered]@{
                file = "Auto-Mate.exe"
                compiler = "Microsoft .NET Framework Visual C# Compiler (csc.exe)"
                architecture = "x64"
                sha256 = $launcherHash
            }
            bun = [ordered]@{
                file = "bin/bun.exe"
                version = $bunVersion
                architecture = "x64"
                sha256 = $bunHash
            }
            chromium = [ordered]@{
                engine = "Playwright Chromium"
                revision = "1248"
                browserVersion = "156.0.8078.4"
            }
            headlessShell = [ordered]@{
                revision = "1248"
            }
            ffmpeg = [ordered]@{
                revision = "1013"
            }
        }
        timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $manifestJson = $manifestData | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText((Join-Path $bundleRoot 'RELEASE-MANIFEST.json'), $manifestJson, $utf8NoBom)

    # Ensure output dist/app exists
    if (-not (Test-Path -LiteralPath $distApp)) {
        New-Item -ItemType Directory -Path $distApp -Force | Out-Null
    }

    # Archive creation
    $zipFileName = 'Auto-Mate-' + $version + '-windows-x64.zip'
    $archivePath = Join-Path $distApp $zipFileName
    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }

    Write-Host 'Compressing portable application package (standard forward-slash zip entries)...'
    Add-Type -AssemblyName 'System.IO.Compression'
    Add-Type -AssemblyName 'System.IO.Compression.FileSystem'
    $zipStream = [System.IO.File]::Create($archivePath)
    $zipArchive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $files = Get-ChildItem -LiteralPath $staging -Recurse -File
        $stagingPrefixLength = $staging.TrimEnd('\', '/').Length + 1
        foreach ($file in $files) {
            $relPath = $file.FullName.Substring($stagingPrefixLength).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipArchive, $file.FullName, $relPath, $CompressionLevel) | Out-Null
        }
    } finally {
        $zipArchive.Dispose()
        $zipStream.Dispose()
    }

    # Calculate SHA256 checksum
    $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $archiveSizeMB = [math]::Round(((Get-Item -LiteralPath $archivePath).Length / 1MB), 2)

    # Write SHA256SUMS.txt in dist/app
    $checksumContent = $archiveHash + '  ' + $zipFileName
    Set-Content -LiteralPath (Join-Path $distApp 'SHA256SUMS.txt') -Value $checksumContent -Encoding Ascii

    # Copy release-manifest.json to dist/app
    [System.IO.File]::WriteAllText((Join-Path $distApp 'release-manifest.json'), $manifestJson, $utf8NoBom)

    # Generate RELEASE-NOTES.md in dist/app
    $releaseNotesTemplate = @'
# Auto-Mate v{0} (Windows x64 Portable)

## Overview
This is an unsigned private portable application preview for Windows 11 x64.
It contains the complete runtime environment, including the native C# launcher, bundled
verified Bun runtime, Playwright Chromium browser engine, locked production dependencies,
and native Windows DPAPI/Hello integration helpers.

No global installation of Bun, Node.js, Git, or browser binaries is required.

## Release Metadata
- **Version**: {0}
- **Classification**: Unsigned Developer Preview (Private Release)
- **Architecture**: Windows x64 (AMD64)
- **Artifact**: `{2}`
- **SHA-256 Checksum**: `{3}`
- **Archive Size**: ~{4} MB

## System Prerequisites
1. **Operating System**: Windows 11 x64 (Build 22000 or newer).
2. **Authentication Hardware**: Windows Hello biometric sensor (fingerprint/facial recognition) or configured Windows Hello PIN for normal vault access.
3. **PowerShell**: Windows PowerShell 5.1 (built into Windows 11).

## Package Contents
- `Auto-Mate.exe`: Native 64-bit Windows launcher compiled with Microsoft .NET Framework C# compiler.
- `bin\bun.exe`: Bundled Bun {1} x64 runtime.
- `browsers\`: Bundled Playwright Chromium and headless shell resources.
- `node_modules\`: Locked production dependencies, including Sharp's @img/colour and native Windows package.
- `src\`: Application core workflows, policy broker, and vault interfaces.
- `ui\`: Owner application interface assets.
- `platforms\windows\`: Native session monitor, DPAPI vault, and Windows Hello integration scripts.
- `THIRD_PARTY_LICENSES.txt` and `licenses\`: Original license/copyright materials, source hashes, and source/rebuilding directions; vendor terms differ.
- `RELEASE-MANIFEST.json`: Build provenance and cryptographic checksums.
- `USE.md`: Application installation, owner workflow, and safe testing instructions.
- No marketing homepage, demo film, developer demo page, vault, API key, or maintainer conversation memory is included.

## How to Run

### 1. Launch Owner Autofill Application (Standard GUI)
Extract the ZIP archive and double-click `Auto-Mate.exe`, or run from terminal:
```powershell
.\Auto-Mate.exe
```
This opens the local Owner Autofill interface in Chromium. Inspect an HTTPS website, select
a vault record, and authorize individual fields. Normal vault operations require successful
Windows Hello OS verification; the demonstration/check path does not prove that success.

### 2. Run Offline Verification Smoke Test
To verify DPAPI persistence, isolated browser automation, and local audit logging without
requiring hardware biometric gestures:
```powershell
.\Auto-Mate.exe --check
```

## Security & Privacy Notice
- **Unsigned Preview**: This preview executable is unsigned. SmartScreen warnings during initial launch are expected; review release checksums to verify package integrity.
- **Local Runtime**: Auto-Mate does not configure a telemetry collector or cloud vault sync. Destination websites and the bundled browser have their own networking behavior and terms.
- **Per-User Storage**: Vault: `%LOCALAPPDATA%\Auto-Mate\vault.json`; audit: `%LOCALAPPDATA%\AutoMate\audit\`. Deleting the app folder does not delete these files.
- **Fill Only**: Auto-Mate does not click submit/payment controls. Receiving page scripts can read or react to filled values; Lock cannot undo an earlier disclosure.
- **Remaining Gates**: Successful Hello, actual lock/disconnect, clean-machine/downloaded-file behavior, signing, recovery and independent security/redistribution review remain unverified.
'@
    $releaseNotes = $releaseNotesTemplate -f $version, $bunVersion, $zipFileName, $archiveHash, $archiveSizeMB
    [System.IO.File]::WriteAllText((Join-Path $distApp 'RELEASE-NOTES.md'), $releaseNotes, $utf8NoBom)

    Write-Host ''
    Write-Host '========================================================================'
    Write-Host 'Auto-Mate Portable Windows Package Built Successfully'
    Write-Host '========================================================================'
    Write-Host ('Artifact:    ' + $archivePath)
    Write-Host ('Size:        ' + $archiveSizeMB + ' MB')
    Write-Host ('SHA-256:     ' + $archiveHash)
    Write-Host ('Checksums:   ' + (Join-Path $distApp 'SHA256SUMS.txt'))
    Write-Host ('Manifest:    ' + (Join-Path $distApp 'release-manifest.json'))
    Write-Host ('Notes:       ' + (Join-Path $distApp 'RELEASE-NOTES.md'))
    Write-Host '========================================================================'
    Write-Host 'Unsigned private preview. Verify the extracted application; synthetic checks do not prove Windows Hello success.'
} finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
