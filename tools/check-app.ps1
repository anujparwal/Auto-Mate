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
    $entryPaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $zip.Entries) {
        if (-not $entry.FullName.StartsWith($name + '/', [StringComparison]::Ordinal) -or
            $entry.FullName.Contains('..') -or $entry.FullName.Contains('\')) {
            throw ('Unsafe or unexpected archive path: ' + $entry.FullName)
        }
        $relative = $entry.FullName.Substring($name.Length + 1)
        if (-not [string]::IsNullOrEmpty($relative)) {
            $entryPaths.Add($relative) | Out-Null
        }
        if ($relative -match '^(site|homepage|public)/' -or
            $relative -match '^ui/owner-preview\.(html|js)$' -or
            $relative -match '^tools/(preview|start)\.ts$' -or
            $relative -match '^src/(owner-preview|task-planner)\.ts$' -or
            $relative -match '(^|/)(CONTEXT\.MD|\.env(?:\..*)?|vault(?:\.json)?|\.git|\.local|accounts\.json|cookies\.json|model-config\.json)(/|$)' -or
            $relative -match '(^|/)(demo.*)(/|$)' -or
            $relative -match '\.(vault(?:\.json)?|pem|pfx|p12|key|keystore|jks|sqlite|db)$') {
            throw ('Forbidden application release content: ' + $relative)
        }
    }

    $requiredEntries = @(
        'Auto-Mate.exe',
        'bin/bun.exe',
        'tools/run-app.ts',
        'tools/smoke.ts',
        'tools/run-hosted.ts',
        'ui/autofill.html',
        'ui/autofill.js',
        'ui/autofill.css',
        'ui/owner-preview.css',
        'ui/hosted-login.html',
        'ui/hosted-login.js',
        'src/hosted-server.ts',
        'src/hosted-tunnel.ts',
        'src/hosted-accounts.ts',
        'src/hosted-egress.ts',
        'src/website-actions.ts',
        'src/workspace-store.ts',
        'src/agent-engine.ts',
        'src/agent-browser.ts',
        'src/agent-types.ts',
        'src/agent-settings.ts',
        'platforms/windows/workspace.ps1',
        'RELEASE-MANIFEST.json'
    )
    foreach ($req in $requiredEntries) {
        if (-not $entryPaths.Contains($req)) {
            throw ('Required archive entry missing: ' + $req)
        }
    }

    if ($entryPaths.Contains('model-config.json')) {
        throw 'Forbidden obsolete model-config.json present in application archive.'
    }
} finally { $zip.Dispose() }

# Construct the accented character without relying on Windows PowerShell's
# interpretation of a UTF-8-without-BOM script source file.
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('AM ' + [char]0x00E9 + ' ' + [guid]::NewGuid().ToString('N'))
$process = $null
$hostedProcess = $null
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

    # Exercise extracted bundled hosted backend minimally without public exposure or real user data
    $hostedDataDir = Join-Path $temporary 'hosted-test-data'
    $throwawayScript = Join-Path $application 'test-hosted-backend.ts'
    $throwawayScriptContent = @'
import { openHostedServer } from './src/hosted-server.ts';
import { resolveHostedOptions } from './tools/run-hosted.ts';

// 1. Verify option parsing rejects illegal CLI args
let cliRejected = false;
try {
  resolveHostedOptions(['--unexpected']);
} catch {
  cliRejected = true;
}
if (!cliRejected) {
  throw new Error('resolveHostedOptions must reject CLI arguments.');
}

// 2. Start minimal local hosted server on 127.0.0.1:0 (ephemeral port) with synthetic test key
const testDataDir = process.env.TEST_HOSTED_DATA_DIR!;
const server = await openHostedServer({
  port: 0,
  dataDirectory: testDataDir,
});

try {
  // Activate loopback origin (no Cloudflare tunnel, no external network exposure)
  const loopbackOrigin = `http://127.0.0.1:${server.port}`;
  server.activatePublicOrigin(loopbackOrigin);

  // 3. Test unauthenticated / redirects to /login (302)
  const resRoot = await fetch(`${loopbackOrigin}/`, {
    headers: { Host: `127.0.0.1:${server.port}` },
    redirect: 'manual',
  });
  if (resRoot.status !== 302 || resRoot.headers.get('location') !== '/login') {
    throw new Error(`Expected 302 redirect from / to /login, got ${resRoot.status}`);
  }

  // 4. Test unauthenticated /login route serves hosted-login.html asset
  const resLogin = await fetch(`${loopbackOrigin}/login`, {
    headers: { Host: `127.0.0.1:${server.port}` },
  });
  if (resLogin.status !== 200) {
    throw new Error(`Expected 200 from /login, got ${resLogin.status}`);
  }
  const loginType = resLogin.headers.get('content-type') ?? '';
  if (!loginType.includes('text/html')) {
    throw new Error(`Expected text/html from /login, got ${loginType}`);
  }

  // 5. Test static UI assets /hosted-login.js and /owner-preview.css serve scripts/styles
  const resJs = await fetch(`${loopbackOrigin}/hosted-login.js`, {
    headers: { Host: `127.0.0.1:${server.port}` },
  });
  if (resJs.status !== 200 || !(resJs.headers.get('content-type') ?? '').includes('javascript')) {
    throw new Error(`Expected 200 javascript from /hosted-login.js, got ${resJs.status}`);
  }

  const resCss = await fetch(`${loopbackOrigin}/owner-preview.css`, {
    headers: { Host: `127.0.0.1:${server.port}` },
  });
  if (resCss.status !== 200 || !(resCss.headers.get('content-type') ?? '').includes('css')) {
    throw new Error(`Expected 200 css from /owner-preview.css, got ${resCss.status}`);
  }

  // 6. Test registration with username and key (no operator registration key required)
  const resReg = await fetch(`${loopbackOrigin}/api/register`, {
    method: 'POST',
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Origin: loopbackOrigin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: 'testuser',
      key: 'correct-horse-battery-staple-sample',
    }),
  });
  if (resReg.status !== 200) {
    const errText = await resReg.text();
    throw new Error(`Expected 200 from registration, got ${resReg.status}: ${errText}`);
  }
  const setCookie = resReg.headers.get('set-cookie');
  if (!setCookie || !setCookie.includes('automate_session=')) {
    throw new Error('Registration did not set session cookie');
  }
  const sessionCookie = setCookie.split(';')[0];

  // 7. Test consumer-facing authenticated session endpoint
  const resSession = await fetch(`${loopbackOrigin}/api/session`, {
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Cookie: sessionCookie,
    },
  });
  if (resSession.status !== 200) {
    throw new Error(`Expected 200 from /api/session, got ${resSession.status}`);
  }
  const sessionData = await resSession.json();
  if (sessionData.username !== 'testuser' || typeof sessionData.csrfToken !== 'string') {
    throw new Error('Invalid session response data');
  }

  // 8. Test consumer-facing authenticated workspace UI assets (/ and /autofill.js)
  const resWorkspace = await fetch(`${loopbackOrigin}/`, {
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Cookie: sessionCookie,
    },
  });
  if (resWorkspace.status !== 200 || !(resWorkspace.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`Expected 200 text/html from workspace /, got ${resWorkspace.status}`);
  }

  const resWorkspaceJs = await fetch(`${loopbackOrigin}/autofill.js`, {
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Cookie: sessionCookie,
    },
  });
  if (resWorkspaceJs.status !== 200 || !(resWorkspaceJs.headers.get('content-type') ?? '').includes('javascript')) {
    throw new Error(`Expected 200 javascript from /autofill.js, got ${resWorkspaceJs.status}`);
  }

  console.log('PASS: extracted bundled hosted backend successfully exercised on loopback (local port, hosted assets, auth guards, workspace paths).');
} finally {
  await server.close();
}
'@
    [System.IO.File]::WriteAllText($throwawayScript, $throwawayScriptContent, (New-Object System.Text.UTF8Encoding($false)))

    $hostedStart = New-Object System.Diagnostics.ProcessStartInfo
    $hostedStart.FileName = Join-Path $application 'bin\bun.exe'
    $hostedStart.Arguments = 'run "' + $throwawayScript + '"'
    $hostedStart.WorkingDirectory = $application
    $hostedStart.UseShellExecute = $false
    $hostedStart.RedirectStandardInput = $true
    $hostedStart.RedirectStandardOutput = $true
    $hostedStart.RedirectStandardError = $true
    $hostedStart.StandardOutputEncoding = $utf8
    $hostedStart.StandardErrorEncoding = $utf8
    $hostedStart.EnvironmentVariables['PATH'] = @(
        (Join-Path $application 'bin'),
        (Join-Path $env:SystemRoot 'System32'),
        $env:SystemRoot
    ) -join ';'
    $hostedStart.EnvironmentVariables['TEST_HOSTED_DATA_DIR'] = $hostedDataDir
    foreach ($variable in @('NODE_PATH', 'NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_INSTALL', 'AUTOMATE_HOSTED_PUBLIC_ORIGIN', 'AUTOMATE_HOSTED_PORT', 'AUTOMATE_HOSTED_REGISTRATION_KEY')) {
        $hostedStart.EnvironmentVariables.Remove($variable)
    }

    $hostedProcess = [Diagnostics.Process]::Start($hostedStart)
    $hostedProcess.StandardInput.Close()
    $hStdout = $hostedProcess.StandardOutput.ReadToEndAsync()
    $hStderr = $hostedProcess.StandardError.ReadToEndAsync()
    if (-not $hostedProcess.WaitForExit(60000)) {
        $hostedProcess.Kill()
        $hostedProcess.WaitForExit()
        throw 'Bundled hosted backend check timed out.'
    }
    $hOut = $hStdout.GetAwaiter().GetResult()
    $hErr = $hStderr.GetAwaiter().GetResult()
    if ($hOut) { Write-Host $hOut }
    if ($hErr) { Write-Host $hErr }
    if ($hostedProcess.ExitCode -ne 0) {
        throw ('Bundled hosted backend check failed with exit ' + $hostedProcess.ExitCode)
    }
} finally {
    if ($process) {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
    if ($hostedProcess) {
        if (-not $hostedProcess.HasExited) { $hostedProcess.Kill(); $hostedProcess.WaitForExit() }
        $hostedProcess.Dispose()
    }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
