[CmdletBinding()]
param([ValidateSet('assembleDebug', 'lintDebug')][string]$Task = 'assembleDebug')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$previousJava = $env:JAVA_HOME
$previousAndroid = $env:ANDROID_HOME
try {
    if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME)) {
        $localJdk = Join-Path $root '.local/jdk21'
        if (Test-Path $localJdk) {
            $installed = @(Get-ChildItem -LiteralPath $localJdk -Directory)
            if ($installed.Count -eq 1) { $env:JAVA_HOME = $installed[0].FullName }
        }
    }
    if ([string]::IsNullOrWhiteSpace($env:ANDROID_HOME)) {
        $env:ANDROID_HOME = Join-Path $root '.local/android-sdk'
    }
    if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME) -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin/java.exe'))) {
        throw 'Set JAVA_HOME to JDK 17 or 21.'
    }
    if (-not (Test-Path (Join-Path $env:ANDROID_HOME 'platforms/android-35/android.jar'))) {
        throw 'Set ANDROID_HOME to an SDK containing Android API 35.'
    }
    Push-Location (Join-Path $root 'platforms/android')
    try {
        & .\gradlew.bat $Task --console=plain
        if ($LASTEXITCODE -ne 0) { throw "Android build failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
} finally {
    $env:JAVA_HOME = $previousJava
    $env:ANDROID_HOME = $previousAndroid
}
