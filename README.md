# Auto-Mate

Security-first browser automation development project for Windows and Android.

**Development software. Do not put real credentials in it yet.** This repository does not claim zero-risk security, production readiness, or a complete autonomous agent. It deliberately does not expose native vault operations as model tools.

## What is implemented

- A TypeScript broker with exact HTTPS-origin authorization, task-bound credential handles, explicit credential-category scopes, expiring grants, submission budgets, destination blocking, revocation, and explicit protected task state.
- A trusted Windows Playwright registration executor. It uses a fresh browser context, disables service workers and downloads, blocks off-origin requests, rejects unexpected forms, and returns bounded results rather than raw page data.
- A native Windows vault with mandatory Windows Hello application gating, a DPAPI v2 envelope encrypting secrets and metadata, validated atomic v1 migration, and a trusted executor adapter.
- A native Android vault with authenticated v2 metadata envelopes, locked account listings, and an explicit two-prompt legacy upgrade flow. Device verification is still required.
- A controlled browser scenario that persists a generated password through Windows DPAPI before filling and submitting a synthetic registration form in real Chromium.
- An owner-only Windows live preview with explicit task/category/duration approval or denial, deterministically verified request/field associations, paired numbered highlights, trusted category colors, opaque input masks, execution activity, and an execution-stop control.
- Persistent metadata-minimal broker audit files with synchronous write/flush before authorization; an unavailable audit sink permanently stops the broker instead of allowing unlogged credential use.

The Android vault does **not** execute the TypeScript policy broker. Shared security intent is not the same thing as shared executable code. Android browser automation is not implemented or represented as working.

## Run on Windows 11

Install Bun, then from this directory:

```powershell
bun install --frozen-lockfile
bunx playwright install chromium
bun test
bun run typecheck
bun run smoke
```

`smoke` launches headless Chromium against an intercepted HTTPS test origin. It generates a synthetic password, persists it using an explicitly isolated synthetic DPAPI namespace, fills and submits a form, checks a bounded completion result and a durable metadata-minimal audit file, then removes its temporary vault and journal. It does not contact a signup service, print the password, authenticate the user, or exercise a production vault.

Native vault usage is documented in `platforms/windows/README.md`. Android build and device instructions are in `platforms/android/README.md`.

## Live Windows preview

```powershell
bun run preview
```

A local owner window opens with the exact destination, requested credential names/categories, and permission to fill and submit this registration once. Categories start unchecked; choose **Yellow** and **Red**, select **1, 5, or 15 minutes** (default: 1), then click **Approve & run synthetic task**, or choose **Deny task**. Insufficient category scope is rejected before worker navigation and may be corrected. Close the window to exit.

The controlled registration uses synthetic data and a temporary vault below `%TEMP%\AutoMate-Synthetic\`, deleted when the demo closes. Its DPAPI entropy differs from normal vaults, so copying a normal vault there cannot bypass its authentication gate. No AI model is connected. Approval applies only to this task, not other tasks during the selected duration; it is not a native-authentication bypass or a production biometric approval screen. Metadata-minimal audit files persist under `%LOCALAPPDATA%\AutoMate\audit\`; the launcher prints the session file path.

- The left pane shows live, read-only worker-browser frames. Matching numbers connect dashed requesting-text boxes to solid target-field boxes.
- The right pane quotes the requesting text, shows the verified DOM relationship and credential category, and distinguishes pending approval, denied, waiting, preparing, filled, submitting, completed, stopped, and paused states. Selecting a request emphasizes both marks.
- Yellow/Orange/Red colors come from reviewed workflow configuration, never model-authored colors. Registration checks these labels against the trusted broker catalog before publishing requests and before credential use; grants must explicitly permit each credential's category.
- The executor accepts only unique, visible main-document inputs with an explicit `label[for]`, enclosing label, or `aria-labelledby` relationship. Nearby text, unrelated paragraphs, ambiguous selectors, changed source text, and replaced elements are not accepted as verified evidence.
- Requesting quotes use rendered non-control text, not hidden descendants or control values. Text under clipping, masking, or paint-containing ancestors is currently unsupported and fails closed, even when some of that text would be visible. All verified sources and targets must fit within the worker viewport.
- The `Registration` contract now requires `email` and `password` field-request descriptors containing the credential reference, trusted name/category, `fieldSelector`, and `requestSelector`. The old selector-only fields were removed.
- The observer refreshes at execution transitions and approximately every 300 ms plus capture time while active. Periodic capture pauses across intentional submission navigation, then the completed page is captured once. Stop revokes further execution; closing the window also stops an active task. Neither can undo data already disclosed or a submitted request.

### Preview privacy boundary

The owner page runs in a separate browser context with application-owned assets, a restrictive CSP, and no preview HTTP server or listening endpoint. The website is displayed as an image, not as an embedded executable page. The model must never receive the owner browser handle, frames, quotes, or internal observer callbacks.

Ordinary inputs, textareas, selects, and contenteditable controls are opaquely masked, including controls in frames. This is **not universal page redaction**: a website can echo private information into ordinary text, canvas, or images. Consequently these pixels are owner-only, not an alternative AI screenshot tool. No preview recording is persisted by the application.

Geometry and associations are rechecked around captures and before filling. Changed or unsupported evidence halts execution and hides stale marks. This is a conservative check, not a transactional snapshot guarantee against all adversarial rendering. A structural label relationship does not establish the website's trustworthiness, semantic correctness, or the user's consent to disclosure. Pages can imitate decorations inside their own pixels; the application-owned request list and interactive pair selection are the trusted annotation controls.

Android preview remains deferred by the user's Windows-first decision. This is not remote streaming or an Android companion.

Build the Android APK with the installed local SDK and JDK:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build-android.ps1
```

The launcher uses process-local environment settings; it does not change machine-wide Java or Android configuration.

## Vault metadata encryption and upgrades

Windows v2 files expose only `version` and `cipherText`. Origins, record IDs, passwords, and creation/update timestamps are inside one DPAPI-authenticated encrypted payload. Normal broker and owner operations, including listing and legacy migration, require actual successful Windows Hello verification before vault access. Opening a supported v1 vault validates and decrypts every record before atomically replacing it with v2. A corrupt record, duplicate identity, unsupported schema, or invalid collection prevents the write rather than silently dropping data. Record IDs are case-sensitive.

Android v2 records expose only a canonical opaque UUID, version, IV, and ciphertext. The authenticated payload contains the origin, username, password, timestamps, and matching inner identity. The locked list does not reveal account identities. New records use v2; existing v1 records remain explicitly legacy with plaintext metadata **until the owner upgrades each record**. Upgrade requires one authenticated decryption and a separate authenticated encryption; cancellation must leave the original record intact. These native prompt flows are implemented but device-unverified.

This protects managed vault-file contents, not file existence/length, filesystem timestamps, Android record counts/opaque IDs, old backups, shell history, process auditing, clipboard history, or immutable strings in memory. Migration cannot retroactively erase earlier plaintext copies or authenticate historical v1 metadata that was not previously covered by an authentication tag. Windows operations decrypt the complete vault inside the trusted native process; its API and listing results must never become model tools.

## Credential-category authorization

The trusted owner constructs `PolicyBroker` with an explicit credential-reference-to-layer catalog, for example `{ 'registration-email': 'yellow', 'registration-password': 'red' }`, and a mandatory synchronous `AuditSink`: `new PolicyBroker(catalog, journal.append)`. An optional monotonic clock is the third argument. Every `approve` request must supply both `credentials` and `layers`. Unknown credentials are denied; a Red credential cannot be approved with only Yellow permission. Layers are exact memberships, not a hierarchy: approving Red does not also approve Yellow or Orange. Existing task, origin, duration, operation, and submission restrictions still apply.

Only trusted owner code may call `setCredentialLayer(reference, layer)`. Changing an existing credential's category revokes every grant referencing it, even if that grant allowed both categories; unrelated grants remain valid. A fresh approval must use a new task identifier. Setting the same category does not revoke authority. The broker copies the catalog and approval arrays rather than trusting later caller mutations.

Registration snapshots its reviewed field descriptors and rejects category labels that disagree with the broker. It rechecks categories and authorization after asynchronous native persistence, before each fill, and before submission. Reclassification during persistence can leave a generated credential saved, but prevents subsequent fills and submission. Revocation cannot roll back already disclosed data or atomically interrupt an in-flight browser operation.

This is an in-process trusted-owner API, not a persistent credential-management dashboard or a biometric-free auto-approval window. Catalog assignments are currently supplied in trusted application code and are not persisted into Windows or Android vault records. It does not implement custom category names, Android category authorization, or a native-authentication bypass. The synthetic preview requires the owner's explicit Yellow and Red choices for its isolated task.

## Durable local audit

`LocalAuditJournal(directory)` in `src/audit.ts` creates a fresh exclusive UUID-named JSONL file for each session. Its `append` callback projects an allowlisted schema: version, opaque session/task UUIDs, session-local sequence, timestamp, event, and optional bounded policy-denial reason. It never persists raw task names, origins, credential references, categories, passwords, requesting text, arbitrary extra properties, or exception messages. Task tokens correlate events only within a session. The trusted broker's in-memory `audit()` still contains task/origin metadata and must never be exposed to models.

Each row is fully written and flushed with `fsyncSync` before authorization returns. Approval is logged before issuing a grant, and fill/submit authorization is logged before execution; these are authorization records, not proof that a browser action succeeded. `denyApproval` records an owner denial without issuing a grant. Any sink failure or asynchronous/non-void sink return permanently faults the broker, revokes existing grants, disables model observation, and prevents fresh approvals. Stop/revoke still remove authority if their audit write fails. Restarting requires a new trusted broker and healthy journal; no silent in-process recovery is provided.

The normal Windows preview retains these files after its temporary vault is removed. The automated smoke uses an isolated temporary journal and validates it before cleanup. Existing unit tests explicitly use an in-memory sink where persistence is not under test. The owner UI shows current execution activity; a historical audit viewer, OS notifications, Android auditing, and independent native-CLI audit coverage are not implemented.

These logs omit account identities but still reveal event timing, counts, and within-session correlation. They are not encrypted, cryptographically tamper-evident, or protected from same-user malware/deletion. File flushes do not guarantee survival of every hardware/power failure. A crash can leave a partial final row; sessions are never resumed into that file. Retention/rotation and crash-recovery tooling are not implemented.

## Trust boundaries

`src/policy.ts` is a **trusted-owner library**, not a remotely callable authorization server. Catalog construction, audit-sink selection, `approve`, `denyApproval`, `setCredentialLayer`, `block`, `stopAll`, and native vault APIs must never be offered as model tools. The caller is responsible for a trusted, authenticated approval surface. A generated grant identifier alone does not make in-process JavaScript a sandbox. Owner approval callbacks are synchronous trusted code, not a pluggable model/tool channel.

`src/workflow.ts` is trusted code. Workflow selectors, success conditions, and optional browser preparation hooks must come from reviewed application code, never from a model or webpage. The browser object and vault adapter remain private to that executor.

No AI provider is connected yet. This is intentional: there is no unrestricted model browser access to accidentally ship. Local/cloud model routing, an authenticated production approval dashboard, live OS notifications, and supported real-site workflows remain unimplemented. The implemented owner approval screen is for the isolated synthetic registration.

## Important limits

- Normal Windows vault operations use the desktop Windows Hello verification API and fail closed unless the OS returns `Verified`. This is an application gate, **not** a cryptographic user-presence requirement imposed on DPAPI itself. Windows 11 build 22000+ and configured Hello are required; positive authentication remains hardware-unverified here.
- A process running as the same Windows user can potentially use that user's DPAPI facilities. Malware and a compromised OS are outside the protection offered here.
- Android metadata protection is complete only for v2 records. Unmigrated v1 records retain plaintext metadata, and real-device authentication/migration behavior remains unverified.
- Passwords exist transiently as strings inside the trusted executor and browser. JavaScript and PowerShell cannot guarantee memory zeroization.
- The receiving website can read credentials entered into its page. Same-origin scripts can transmit them to that site's server. Destination authorization is disclosure authorization.
- Protected tasks never resume arbitrary observations. Unexpected pages produce a bounded takeover result; the current executor closes its context rather than offering an interactive takeover window.
- A workflow success selector is integration-specific evidence, not proof of remote account creation. Real sites require reviewed success/failure handling.
- Revocation prevents subsequent checks from authorizing work. It cannot undo a fill or an already dispatched submission, nor guarantee interruption during a single running browser operation.
- Broker-managed Windows workflows persist metadata-minimal authorization events, not a tamper-evident audit trail or live OS notification system. Independent native CLI and Android operations do not use that journal.
- The broker blocks exact origins. It does not automatically classify websites or credentials, enforce DNS/network isolation, or implement all-subdomain rules.
- Yellow/Orange/Red membership is enforced by the TypeScript broker, but a persistent category editor, custom category names, Android category policy, timed biometric-free approval windows, cross-device synchronization, and recovery/export are not implemented. A device-bound vault without a recovery design can lose access after key or device loss.

## Before using real credentials

Implement authenticated production platform approval and lifecycle locking; verify successful Windows Hello, cancellation, and lock/lifecycle behavior on configured hardware; verify and finish Android legacy upgrades on a device; review native persistence and recovery; implement authenticated process boundaries; extend audit coverage to native owner/Android operations and add OS notifications; validate supported real-site workflows; perform independent security review before production use.

Android requires its own supported browser execution strategy. Do not substitute broad AccessibilityService permissions or unrestricted WebView JavaScript bridges for the desktop executor without a separate threat model.

## Verification performed

- `bun test`: forty-one tests passed across policy, durable audit, and preview boundaries. Coverage includes category scopes/reclassification, audit privacy/projection/session separation, closed-journal fail-closed behavior and global broker lockout, asynchronous-sink rejection, denied tasks, no native credential access after audit failure, misleading category labels, masking invariance, label associations, and changed/unrelated/hidden/clipped evidence.
- `bun run typecheck`: passed.
- `bun run smoke`: isolated synthetic Windows DPAPI persistence, headless Chromium form submission, and durable audit privacy passed against the intercepted synthetic HTTPS origin. This does not prove production authentication.
- Category runtime probe: Yellow-only approval of a Red password was denied; changing its category after approved use revoked the grant and prevented submission. Actual owner UI: explicitly Yellow/Red-scoped registration completed, both categories were visible in the request list, and protected model observations remained disabled.
- Actual owner approval UI: unchecked categories and disabled approval initially; invalid category/duration/extra-key commands rejected; Yellow-only approval denied with corrected retry; explicit Yellow/Red approval completed exactly once; duplicate approval rejected; owner denial and Stop before filling caused no credential use/submission; a closed journal blocked approval with a bounded error and permanent broker lockout. Session files were parsed after close and checked for absent raw identifiers/values.
- Windows native smoke: v2 at-rest privacy, broker metadata listing and secret retrieval, exact-origin rejection, concurrent updates, lossless migration/corruption refusal, case-sensitive identities, strict schemas, synthetic/normal namespace isolation, and unauthenticated normal-operation refusal passed. Fixed mutex callback result propagation and strict-mode Hello script-path resolution exposed by this run.
- Windows Hello OS availability reports `DeviceNotPresent` on this machine. Successful biometric/PIN verification cannot be exercised here; no fake successful authentication path is provided.
- Android `assembleDebug`: passed with Gradle 8.9, JDK 21, and API 35 SDK. APK: `platforms/android/app/build/outputs/apk/debug/app-debug.apk`.
- Android `testDebugUnitTest`: eleven host JVM tests passed. Production envelope encryption/decryption was exercised with real JCE AES-GCM ciphers, including metadata recovery, identity/ciphertext tampering, strict schema/type rejection, legacy decoding, and diagnostic privacy. This does not simulate or prove Android Keystore authentication.
- Built Android APK: v2 signature verified; packaged permissions inspected and contain no `INTERNET` permission.
- `adb devices -l`: no attached device. Android UI, biometric prompts, authenticated key operations, and lifecycle behavior have not been exercised on a device or emulator.
- Actual owner UI exercised in Chromium: registration completed with protected model observations disabled; selecting a request emphasized both marks; owner Stop before filling prevented password generation and submission; changed evidence hid stale marks and produced an automatic pause.
- Halt interleavings exercised in the actual owner UI: Stop during pending navigation and verification stayed stopped after late callbacks; delayed frame decodes and late frames could not restore marks after stopped/takeover states.
- Desktop (1440 px) and narrow (390 px) owner approval layouts inspected using synthetic pages; the 390 px layout had no horizontal overflow. Older preview verification captures are local-only under `.impeccable/review/`.

These results cover the stated synthetic scenarios, not all attacks or real websites.
