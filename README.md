# Auto-Mate

Security-first browser automation development project for Windows and Android.

**Development software. Do not put real credentials in it yet.** This repository does not claim zero-risk security, production readiness, or a complete autonomous agent. It deliberately does not expose native vault operations as model tools.

## What is implemented

- A TypeScript broker with exact HTTPS-origin authorization, task-bound credential handles, expiring grants, submission budgets, destination blocking, revocation, and explicit protected task state.
- A trusted Windows Playwright registration executor. It uses a fresh browser context, disables service workers and downloads, blocks off-origin requests, rejects unexpected forms, and returns bounded results rather than raw page data.
- A Windows native DPAPI vault and trusted executor adapter.
- A separate native Android vault application. See its platform README for build and authentication requirements.
- A controlled browser scenario that persists a generated password through Windows DPAPI before filling and submitting a synthetic registration form in real Chromium.

The Android vault does **not** execute the TypeScript policy broker. Shared security intent is not the same thing as shared executable code. Android browser automation is not implemented or represented as working.

## Run on Windows

Install Bun, then from this directory:

```powershell
bun install --frozen-lockfile
bunx playwright install chromium
bun test
bun run typecheck
bun run smoke
```

`smoke` launches headless Chromium against an intercepted HTTPS test origin. It generates a synthetic password, persists it using the actual Windows vault, fills and submits a form, checks a bounded completion result, and removes its temporary vault. It does not contact a signup service or print the password.

Native vault usage is documented in `platforms/windows/README.md`. Android build and device instructions are in `platforms/android/README.md`.

Build the Android APK with the installed local SDK and JDK:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build-android.ps1
```

The launcher uses process-local environment settings; it does not change machine-wide Java or Android configuration.

## Trust boundaries

`src/policy.ts` is a **trusted-owner library**, not a remotely callable authorization server. `approve`, `block`, `stopAll`, and native vault APIs must never be offered as model tools. The caller is responsible for a trusted, authenticated approval surface. A generated grant identifier alone does not make in-process JavaScript a sandbox.

`src/workflow.ts` is trusted code. Workflow selectors, success conditions, and optional browser preparation hooks must come from reviewed application code, never from a model or webpage. The browser object and vault adapter remain private to that executor.

No AI provider is connected yet. This is intentional: there is no unrestricted model browser access to accidentally ship. Local/cloud model routing, a desktop approval dashboard, live OS notifications, and supported real-site workflows remain unimplemented.

## Important limits

- Windows DPAPI protects data for the Windows user. It does **not** require fresh Windows Hello authentication for each operation. This implementation must not be advertised as biometric-gated Windows credential use.
- A process running as the same Windows user can potentially use that user's DPAPI facilities. Malware and a compromised OS are outside the protection offered here.
- Windows origin, record ID, and timestamps are currently plaintext metadata protected by file permissions, not encrypted metadata. Avoid using private identifiers as record IDs.
- Android currently leaves record labels/usernames, origins, and timestamps in app-private plaintext metadata. Only passwords are protected by the authenticated vault key. Full metadata encryption is required before handling real identities.
- Passwords exist transiently as strings inside the trusted executor and browser. JavaScript and PowerShell cannot guarantee memory zeroization.
- The receiving website can read credentials entered into its page. Same-origin scripts can transmit them to that site's server. Destination authorization is disclosure authorization.
- Protected tasks never resume arbitrary observations. Unexpected pages produce a bounded takeover result; the current executor closes its context rather than offering an interactive takeover window.
- A workflow success selector is integration-specific evidence, not proof of remote account creation. Real sites require reviewed success/failure handling.
- Revocation prevents subsequent checks from authorizing work. It cannot undo a fill or an already dispatched submission, nor guarantee interruption during a single running browser operation.
- Audit events currently remain in process memory. They are not a persistent, tamper-evident audit trail or live notification system.
- The broker blocks exact origins. It does not currently implement category classification, DNS/network isolation, or all-subdomain rules.
- Yellow/Orange/Red classification, custom categories, cross-device synchronization, and recovery/export are not implemented in the broker. A device-bound vault without a recovery design can lose access after key or device loss.

## Before using real credentials

Implement trusted platform approval and lifecycle locking; complete Windows Hello gating; encrypt sensitive metadata; review native persistence and recovery; implement authenticated process boundaries; add persistent metadata-safe audit and notifications; validate supported real-site workflows; exercise Android on a secure-lock-screen device; perform independent security review.

Android requires its own supported browser execution strategy. Do not substitute broad AccessibilityService permissions or unrestricted WebView JavaScript bridges for the desktop executor without a separate threat model.

## Verification performed

- `bun test`: five policy tests passed, including exact-origin and credential restrictions, expiry, revocation, and input-mutation resistance.
- `bun run typecheck`: passed.
- `bun run smoke`: actual Windows DPAPI persistence and headless Chromium form submission passed against the intercepted synthetic HTTPS origin.
- Windows native smoke: encryption/decryption, origin mismatch rejection, encrypted-at-rest synthetic secret, restricted file inheritance, metadata listing, and concurrent updates preserving all five identities passed.
- Separate native scenarios: HTTP/userinfo/path/query origin requests were denied; a Hello-required broker request failed closed.
- Android `assembleDebug`: passed with Gradle 8.9, JDK 21, and API 35 SDK. APK: `platforms/android/app/build/outputs/apk/debug/app-debug.apk`.
- Built Android APK: v2 signature verified; packaged permissions inspected and contain no `INTERNET` permission.
- `adb devices -l`: no attached device. Android UI, biometric prompts, authenticated key operations, and lifecycle behavior have not been exercised on a device or emulator.

These results cover the stated synthetic scenarios, not all attacks or real websites.
