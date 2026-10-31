# Auto-Mate

Security-first browser automation development project for Windows and Android.

**Development software. Do not put real credentials in it yet.** This repository does not claim zero-risk security, production readiness, or a complete autonomous agent. It deliberately does not expose native vault operations as model tools.

## What is implemented

- A TypeScript broker with exact HTTPS-origin authorization, task-bound credential handles, explicit credential-category scopes, actively expiring grants, grant-bound cancellation signals, submission budgets, destination blocking, revocation, and explicit protected task state.
- A trusted Windows Playwright registration executor. It uses a fresh browser context, disables service workers and downloads, blocks off-origin requests, rejects unexpected forms, and returns bounded results rather than raw page data.
- A native Windows vault with mandatory Windows Hello application gating, a DPAPI v2 envelope encrypting secrets and metadata, validated atomic v1 migration, and a trusted executor adapter.
- A native Android vault with authenticated v2 metadata envelopes, locked account listings, and an explicit two-prompt legacy upgrade flow. Device verification is still required.
- A controlled browser scenario that persists a generated password through Windows DPAPI before filling and submitting a synthetic registration form in real Chromium.
- An owner-only Windows live preview with explicit task/category/duration approval or denial, deterministically verified request/field associations, paired numbered highlights, trusted category colors, opaque input masks, execution activity, and an execution-stop control.
- Persistent metadata-minimal broker audit files with synchronous write/flush before authorization; an unavailable audit sink permanently stops the broker instead of allowing unlogged credential use.
- A read-only historical audit viewer in the owner window, with session/event pagination, explicit refresh for active journals, strict file validation, and bounded corruption/incomplete-tail diagnostics.

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
- The observer refreshes at execution transitions and approximately every 300 ms plus capture time while active. Periodic capture pauses across intentional submission navigation, then the completed page is captured once. Stop and grant expiry revoke authority and promptly request protected-context closure without waiting for pending navigation or native persistence. Closing the owner window also stops an active task. None can undo data already disclosed, a dispatched submission, or an already-started native write.
- Expand **Audit history** to inspect persisted sessions without approving the task. History actions cannot issue grants, access the vault, or change the current task's authorization.

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

Registration snapshots its reviewed field descriptors and rejects category labels that disagree with the broker. It rechecks categories and authorization after asynchronous native persistence, before each fill, and before submission. Reclassification stops all affected tasks before dispatching abort callbacks, requests closure of their protected browser contexts, and prevents subsequent fills/submission. A native operation already in progress can still persist a generated credential.

This is an in-process trusted-owner API, not a persistent credential-management dashboard or a biometric-free auto-approval window. Catalog assignments are currently supplied in trusted application code and are not persisted into Windows or Android vault records. It does not implement custom category names, Android category authorization, or a native-authentication bypass. The synthetic preview requires the owner's explicit Yellow and Red choices for its isolated task.

### Grant lifetime and browser cancellation

Trusted executors obtain `policy.executionSignal(grant, task)` before creating the browser context. This validates the live handle/task binding and deadline; it does not authorize a fill or submission. Each grant has a stable `AbortSignal`. Revocation, Stop All, matching destination blocks, category changes, audit faults, and expiry abort affected active executions. Unrelated grants remain usable.

The broker schedules an unreferenced monotonic-clock-aware deadline timer for each grant, as well as checking deadlines at execution. Expiry revokes authority before abort callbacks and records `grant_expired` with reason `GRANT_EXPIRED`; history displays **Permission expired**. Timers are cleared when authority ends. Successful completion clears its timer without cancelling the final owner capture or later turning a completed task into an expiry event.

The executor attaches cancellation before asynchronous context creation. An abort starts context closure and stopped-state publication independently of awaited browser, observer, or native-store work. A context returned after cancellation is closed before navigation or credential access. Closure is observed in cleanup, listeners are detached, and Playwright teardown errors cannot escape as raw browser diagnostics; a teardown failure cannot produce a successful workflow result.

Native persistence is deliberately **not** abandoned, cancelled, or rolled back. If an already-started store operation confirms success after browser cancellation, the bounded result is `takeover` with `credentialSaved: true`, and nothing is filled/submitted afterward. `credentialSaved` reports acknowledged persistence, not a transactional guarantee that no write occurred when acknowledgement fails. Workflow completion still waits for that operation to settle even though the protected context closes earlier.

This is cooperative application/runtime cancellation, not OS session-lock enforcement or a hard real-time deadline. A blocked event loop, suspended host, or unresponsive browser can delay teardown. Already dispatched page operations/network requests and completed native writes cannot be undone. Native Windows Hello prompts/processes are not cancelled by this mechanism, and independent native/Android operations are unchanged.

## Durable local audit

`LocalAuditJournal(directory)` in `src/audit.ts` creates a fresh exclusive UUID-named JSONL file for each session. Its `append` callback projects an allowlisted schema: version, opaque session/task UUIDs, session-local sequence, timestamp, event, and optional bounded policy-denial reason. It never persists raw task names, origins, credential references, categories, passwords, requesting text, arbitrary extra properties, or exception messages. Task tokens correlate events only within a session. The trusted broker's in-memory `audit()` still contains task/origin metadata and must never be exposed to models.

Each row is fully written and flushed with `fsyncSync` before authorization returns. Approval is logged before issuing a grant, and fill/submit authorization is logged before execution; these are authorization records, not proof that a browser action succeeded. `denyApproval` records an owner denial without issuing a grant. Any sink failure or asynchronous/non-void sink return permanently faults the broker, revokes existing grants, disables model observation, and prevents fresh approvals. Stop/revoke still remove authority if their audit write fails. Restarting requires a new trusted broker and healthy journal; no silent in-process recovery is provided.

The normal Windows preview retains these files after its temporary vault is removed. The automated smoke uses an isolated temporary journal and validates it before cleanup. Existing unit tests explicitly use an in-memory sink where persistence is not under test. The owner UI shows current execution activity and read-only historical audit records. OS notifications, Android auditing, and independent native-CLI audit coverage remain unimplemented.

These logs omit account identities but still reveal event timing, counts, and within-session correlation. They are not encrypted, cryptographically tamper-evident, or protected from same-user malware/deletion. File flushes do not guarantee survival of every hardware/power failure. A crash can leave a partial final row; sessions are never resumed into that file. Retention/rotation and crash-recovery tooling are not implemented.

### Browsing audit history

Run `bun run preview` and expand **Audit history**, which starts collapsed. Sessions are ordered by file modification time, newest first, with 20 per page. Select an opaque session-file token to see 50 events per page in sequence order: timestamp, authorization/result event, opaque task token, and optional bounded denial reason. File tokens and the inner session token may differ in existing journals; no migration is required. No raw account identities are shown.

**Refresh sessions** reloads the directory listing; **Refresh events** rereads the selected journal, including new events appended by the current task. Refresh is explicit, not a background disk poll. An empty active journal can be viewed before approval and refreshed after execution. History remains available after the task terminates. Read failures clear stale rows; a failed directory listing also clears selection and invalidates pending event responses. Refreshing sessions after a failure restarts at the first page.

`LocalAuditHistory` in `src/audit-history.ts` accepts only canonical lowercase UUID file tokens within the trusted configured audit directory, never renderer-supplied paths. It validates every complete row before returning any page: exact fields, version, canonical UUIDs/timestamps, consecutive sequence numbers, one consistent inner session, and shared writer/reader event/reason allowlists. Unknown/private fields or malformed complete rows refuse the entire session rather than displaying an earlier valid prefix. Symbolic links and directories are ignored in listings and refused as session files.

Reads are bounded to a file-handle snapshot of at most **1 MiB** and **4,096 complete rows** per session. A directory scan permits at most **4,096 entries**, including unsupported entries; an over-limit scan returns no partial listing. Oversized sessions are refused explicitly, not silently truncated. Only a final non-newline-terminated fragment may be ignored, with an incomplete-tail warning; it is not decoded, displayed, repaired, or removed. History reads never modify journal bytes.

These are read snapshots, not tamper verification or transactional filesystem snapshots. Concurrent appends appear on a later refresh; directory ordering can shift between requests. Concurrent replacement/rewrites by another same-user process are not prevented. The existing timing/correlation and local-file-tampering limits still apply.

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
- Revocation and active expiry abort the executor's signal and request immediate context closure, rather than only waiting for another authorization check. They cannot undo prior disclosure/submission, guarantee atomic interruption of an in-flight browser operation, or impose a hard deadline on an unresponsive runtime/browser. Already-started native persistence can finish after cancellation.
- Broker-managed Windows workflows persist metadata-minimal authorization events, not a tamper-evident audit trail or live OS notification system. Independent native CLI and Android operations do not use that journal.
- The broker blocks exact origins. It does not automatically classify websites or credentials, enforce DNS/network isolation, or implement all-subdomain rules.
- Yellow/Orange/Red membership is enforced by the TypeScript broker, but a persistent category editor, custom category names, Android category policy, timed biometric-free approval windows, cross-device synchronization, and recovery/export are not implemented. A device-bound vault without a recovery design can lose access after key or device loss.

## Before using real credentials

Implement authenticated production platform approval and lifecycle locking; verify successful Windows Hello, cancellation, and lock/lifecycle behavior on configured hardware; verify and finish Android legacy upgrades on a device; review native persistence and recovery; implement authenticated process boundaries; extend audit coverage to native owner/Android operations and add OS notifications; validate supported real-site workflows; perform independent security review before production use.

Android requires its own supported browser execution strategy. Do not substitute broad AccessibilityService permissions or unrestricted WebView JavaScript bridges for the desktop executor without a separate threat model.

## Verification performed

- `bun test`: sixty-five tests passed across policy, durable audit, history, preview, and executor cancellation. Added coverage includes selective/global cancellation, reentrant invalidation, real scheduled expiry, overdue clock checks, audit-fault expiry, successful-finish timer cleanup, context-creation races, held navigation, pending store acknowledgement, unaffected-task success, and bounded teardown failure. Existing history privacy/bounds, categories, masking, and DOM-evidence regressions also passed.
- `bun run typecheck`: passed.
- `bun run smoke`: isolated synthetic Windows DPAPI persistence, headless Chromium form submission, durable audit privacy, and strict history-reader roundtrip passed against the intercepted synthetic HTTPS origin. This does not prove production authentication.
- Category runtime probe: Yellow-only approval of a Red password was denied; changing its category after approved use revoked the grant and prevented submission. Actual owner UI: explicitly Yellow/Red-scoped registration completed, both categories were visible in the request list, and protected model observations remained disabled.
- Actual owner approval UI: unchecked categories and disabled approval initially; Yellow-only approval denied with corrected retry; explicit Yellow/Red approval completed exactly once; owner denial and Stop before filling caused no credential use/submission; a closed journal blocked approval with a bounded error and permanent broker lockout. Session files were parsed after close and checked for absent raw identifiers/values.
- Actual history UI: browsed 27 synthetic sessions and both pages of a 62-event journal before approval; incomplete-tail warnings and real corrupt/oversized-file refusals displayed; invalid native history commands returned bounded errors. A delayed older selection could not replace a newer error. A simulated directory-list failure cleared stale rows/selection, and its delayed event response could not repopulate them. Manual recovery and empty-to-eight-event live refresh worked. Native smoke assertions confirmed browsing issued no grant/submission and changed no fixture bytes.
- Cancellation runtime smoke: reproduced the old pending-navigation context remaining open after Stop, then confirmed Stop and active expiry close it before releasing navigation. A real synthetic Windows DPAPI write with delayed acknowledgement confirmed browser closure before acknowledgement, no submission, preserved encrypted persistence, and `takeover`/`credentialSaved: true` after release.
- Actual owner cancellation UI: Stop and automatic expiry showed stopped state and removed annotations while a deferred store fixture remained unresolved; native assertions confirmed context closure before releasing that fixture and no submission. The expiry fixture used a trusted 1-second cap below the selected maximum; shipped owner choices remain 1/5/15 minutes. History displayed **Permission expired** with `GRANT_EXPIRED`.
- Windows native smoke: v2 at-rest privacy, broker metadata listing and secret retrieval, exact-origin rejection, concurrent updates, lossless migration/corruption refusal, case-sensitive identities, strict schemas, synthetic/normal namespace isolation, and unauthenticated normal-operation refusal passed. Fixed mutex callback result propagation and strict-mode Hello script-path resolution exposed by this run.
- Windows Hello OS availability reports `DeviceNotPresent` on this machine. Successful biometric/PIN verification cannot be exercised here; no fake successful authentication path is provided.
- Android `assembleDebug`: passed with Gradle 8.9, JDK 21, and API 35 SDK. APK: `platforms/android/app/build/outputs/apk/debug/app-debug.apk`.
- Android `testDebugUnitTest`: eleven host JVM tests passed. Production envelope encryption/decryption was exercised with real JCE AES-GCM ciphers, including metadata recovery, identity/ciphertext tampering, strict schema/type rejection, legacy decoding, and diagnostic privacy. This does not simulate or prove Android Keystore authentication.
- Built Android APK: v2 signature verified; packaged permissions inspected and contain no `INTERNET` permission.
- `adb devices -l`: no attached device. Android UI, biometric prompts, authenticated key operations, and lifecycle behavior have not been exercised on a device or emulator.
- Actual owner UI exercised in Chromium: registration completed with protected model observations disabled; selecting a request emphasized both marks; owner Stop before filling prevented password generation and submission; changed evidence hid stale marks and produced an automatic pause.
- Halt interleavings exercised in the actual owner UI: Stop during pending navigation and verification stayed stopped after late callbacks; delayed frame decodes and late frames could not restore marks after stopped/takeover states.
- Desktop (1440 px) and narrow (390 px) owner/history layouts inspected using synthetic pages; the 390 px page had no horizontal overflow, with event-table scrolling contained inside its panel. Older preview verification captures are local-only under `.impeccable/review/`.

These results cover the stated synthetic scenarios, not all attacks or real websites.
