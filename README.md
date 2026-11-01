# Auto-Mate

Security-first browser automation development project for Windows and Android.

**Development software. Do not put real credentials in it yet.** This repository does not claim zero-risk security, production readiness, or a complete autonomous agent. It deliberately does not expose native vault operations as model tools.

**Start here:** [use.md](use.md) contains portable-app installation, the complete owner workflow, fictitious-data tests, source development, and supplied-API instructions. [CONTEXT.MD](CONTEXT.MD) records the project conversations, decisions, evidence, and remaining gates for maintainers; it is excluded from application bundles and the public homepage.

**Release boundary:** `v0.1.0-preview.1` is an unsigned **private Windows application preview**, not a public production release. `bun run build:app` creates its portable application ZIP/checksum under `dist/app`; bundled runtime components remove the end-user Bun/Node setup requirement. The separate public [Auto-Mate-homepage](https://github.com/anujparwal/Auto-Mate-homepage) repository contains the homepage and clearly labeled non-interactive simulated film. Neither is included in the application release. Vaults, Windows Hello, approvals, and protected browsers remain on each user's PC.

## What is implemented

- A TypeScript broker with exact HTTPS-origin authorization, task-bound credential handles, explicit credential-category scopes, actively expiring grants, grant-bound cancellation signals, submission budgets, destination blocking, revocation, and explicit protected task state.
- A trusted Windows Playwright registration executor. It uses a fresh browser context, disables service workers and downloads, blocks off-origin requests, rejects unexpected forms, and returns bounded results rather than raw page data.
- A native Windows vault with mandatory Windows Hello application gating, a DPAPI v2 envelope encrypting secrets and metadata, validated atomic v1 migration, and a trusted executor adapter.
- A native Android vault with authenticated v2 metadata envelopes, locked account listings, and an explicit two-prompt legacy upgrade flow. Device verification is still required.
- A controlled browser scenario that persists a generated password through Windows DPAPI before filling and submitting a synthetic registration form in real Chromium.
- An owner-only Windows live preview with explicit task/category/duration approval or denial, deterministically verified request/field associations, paired numbered highlights, trusted category colors, opaque input masks, execution activity, and an execution-stop control.
- Persistent metadata-minimal broker audit files with synchronous write/flush before authorization; an unavailable audit sink permanently stops the broker instead of allowing unlogged credential use.
- A read-only historical audit viewer in the owner window, with session/event pagination, explicit refresh for active journals, strict file validation, and bounded corruption/incomplete-tail diagnostics.
- A Windows prototype task-entry loop with offline reviewed-command mode or optional local/cloud OpenAI-compatible planning. Models can select only the reviewed synthetic registration; owner approval remains separate.
- A real HTTPS-site fill-only workflow with deterministic field discovery, exact-origin typed login/card records, unchecked individual disclosure approvals, native Windows Hello access, and an owner-only masked live preview. Filled pages remain open under active expiry/revocation.
- An independent owner-only Vault column for adding exact-origin login/card records before opening a website, authenticated identity listing, and locking the UI while stopping execution. No model vault API or ciphertext export exists.
- A Windows session monitor for the real-site launcher: session transitions, unavailable/locked desktops, disconnects, channel failure, and stale heartbeats remove authority and request protected-browser closure.
- Reproducible Windows x64 development setup, hosted Windows verification, and application-only portable packaging with a native launcher, bundled Bun/Chromium/runtime dependencies, required license notices, and SHA-256 checksums. The old in-app marketing/source-site deployment is superseded by the separate homepage repository.
- Instructions for connecting a [user-supplied OpenAI-compatible API](docs/model-api.md) to the existing bounded synthetic planner, without model installation/hosting setup or expanded authority. Live-provider inference remains unverified until connection details are supplied.

The Android vault does **not** execute the TypeScript policy broker. Shared security intent is not the same thing as shared executable code. Android browser automation is not implemented or represented as working.

## Run on Windows 11

From this directory, run the reviewed setup script (Windows 11 x64; installs missing Bun from a pinned, digest-verified official release, locked dependencies, and Chromium):

```powershell
powershell.exe -NoProfile -File .\tools\setup-windows.ps1
bun test
bun run typecheck
bun run smoke
```

`smoke` launches headless Chromium against an intercepted HTTPS test origin. It generates a synthetic password, persists it using an explicitly isolated synthetic DPAPI namespace, fills and submits a form, checks a bounded completion result and a durable metadata-minimal audit file, then removes its temporary vault and journal. It does not contact a signup service, print the password, authenticate the user, or exercise a production vault.

Native vault usage is documented in `platforms/windows/README.md`. Android build and device instructions are in `platforms/android/README.md`.

## Website autofill on Windows

```powershell
bun start
```

1. In the separate **Vault** column, enter an **Allowed HTTPS origin**, such as `https://example.com` (no path/query), choose **Login** or **Payment card**, and enter a **Record ID** and its values. No website needs to be open.
2. Click **Authenticate & save encrypted record** and complete Windows Hello. Values clear from the form when sent; storage is acknowledged only after native success. Reusing an ID replaces the record only for that exact origin.
3. To choose an existing identity, enter its origin and click **Authenticate & list IDs**. Listing displays owner-only metadata, not secret values, and does not approve website disclosure.
4. In the website column, enter an **HTTPS page URL**, choose the record type, and click **Inspect website**. Inspection opens an isolated browser and detects labelled fields without accessing the vault. Verify the exact destination and quoted requesting text.
5. Enter a known **Record ID** in the website approval section, or choose an ID in the Vault and click **Use this ID for website approval**. That button requires matching origin and record type; it does not select fields or grant authority.
6. Explicitly check each field you allow. Nothing is preselected. Choose a **1, 5, or 15 minute** protected-page lifetime, then click **Approve selected fields & authenticate**. After successful Windows Hello, the trusted executor retrieves the record, rechecks authority/evidence, and fills only those fields.
7. **Lock vault & stop** clears the owner draft and identity list, revokes website authority, and closes the protected page; it does not delete records. Stop, deny, owner-window closure, or inspecting another destination also end the current flow. Filled pages remain subject to expiry and workstation monitoring; changed evidence ends autofill.

**The app never clicks Login, Pay, or Submit in this flow.** Filling itself discloses data to the receiving website and its scripts; those scripts may react or transmit information without a submit click. Stop cannot undo that disclosure. The executor does not claim account login, order completion, or payment success.

### Records and supported forms

- Login records contain a username/email and password. Card records contain cardholder name, a Luhn-valid 12–19 digit card number, expiry month, and four-digit expiry year. The checksum is a format check, not proof that a card exists or can be charged.
- CVV/CVC, bank PINs, OTPs, bank-account numbers, billing addresses, and unrelated controls are not stored or autofilled. Card type/brand controls are left unchanged.
- Records are encrypted inside the existing native DPAPI v2 envelope and bound to an exact HTTPS origin. Cards are not silently reused across merchants; create a record for each approved destination. Scheme, host, subdomain, and port matter.
- Existing raw password records can be used as Login records with **record ID as username**. No read silently rewrites data. JSON-looking legacy secrets that are malformed or conflict with the typed schema fail closed; explicitly re-save them as a typed login after authentication.
- Supported controls are unique visible main-document inputs, plus numeric month/year selects, with explicit `label[for]`, enclosing-label, or single-source `aria-labelledby` evidence. Rendered requesting text must fit wholly within the viewport and rectangular overflow clips. Partially clipped text, nonrectangular clipping, masking, transformed text ancestry, and paint containment remain unsupported.
- Nearby text is not evidence. Duplicate/ambiguous semantic fields are omitted or refused. Existing node handles and source text are revalidated before disclosure; replaced or changed elements cannot inherit approval.
- Cross-origin redirects/resources and WebSockets are blocked; service workers, downloads, and popups are disabled/closed. Some sites will not function under this isolation. Embedded/cross-origin payment widgets, SSO, CAPTCHA, MFA, unlabeled/custom controls, and arbitrary multi-step navigation are not bypassed or represented as supported.

The owner page has application-owned assets, a restrictive CSP, and no preview HTTP listener. Save/list/fill commands are bound to the current inspection revision; Stop and Lock remove authority even with an older revision. Renderer commands cannot choose native authentication mode, issue arbitrary grants, export ciphertext, retrieve decrypted records, provide selectors, or expand the field set. There is no model vault API: approval authorizes trusted field insertion, not delivery of plaintext or encrypted vault bytes to a model. No model is involved in real-site field discovery, record retrieval, or filling.

### Authentication and workstation lifecycle

Normal list/save/read operations each require actual Windows Hello verification. There is no master-password fallback, cached unlock lease, synthetic flag, or plaintext-data mode in the real-site launcher. Typing a known record ID avoids a separate listing operation, not authentication for retrieval.

`src/windows-session.ts` runs `platforms/windows/session-monitor.ps1`, an independent hidden native message-loop helper using WTS session notifications and active/input-desktop checks. Heartbeats arrive approximately every 500 ms; missing freshness beyond 2 seconds, an invalid/exited channel, or an inactive session blocks vault operations and removes existing authority. Unlock/reconnect never revives old grants. Browser teardown is cooperative, not a hard real-time or network-isolation guarantee. Already-started native operations may complete after Stop; writes are not rolled back.

**Current hardware blocker:** Windows Hello previously reported `DeviceNotPresent`; the actual real-site owner UI displayed a bounded authentication refusal and left fields untouched when normal vault listing was attempted. Successful normal-vault-to-website filling therefore remains hardware-unverified. Configure and verify Hello, positive authentication, cancellation, and real lock/disconnect behavior before using private credentials. No successful authentication result was simulated.

### Public targets exercised

| Public HTTPS page | Observed verification |
| --- | --- |
| [The Internet login](https://the-internet.herokuapp.com/login) | Explicit username/password approval filled the site's published test credentials; no application POST |
| [Autofill.me card form](https://autofill.me/form/credit-card-simple) | Explicit cardholder/number/month/year approval filled fictitious data; numeric selects matched; CVV untouched; no application POST |

These live-page checks used an explicitly isolated **in-memory public/fictitious-data fixture**, not the normal vault and not a synthetic adapter mapped onto real origins. Native typed-record encryption/read/list and Unicode preservation were separately exercised with actual DPAPI in isolated `.test` vaults. Those two proofs do **not** replace positive Windows Hello hardware verification. No customer account, real card, or payment was used. Desktop and 390 px owner layouts were inspected without horizontal overflow.

### Website acceptance checklist

Run these checks with **new test record IDs and fictitious values only**. Saving an existing ID for the same origin replaces that record. Do not click a target site's Login, Pay, or Submit button during autofill checks.

Start from PowerShell:

```powershell
Set-Location "$HOME\Auto-Mate"
bun start
```

Windows Hello must be configured in **Settings → Accounts → Sign-in options**. An unavailable or cancelled prompt must refuse access; it is not a reason to disable authentication. Until successful Hello is verified, positive normal-vault save/list/fill checks below remain blocked.

| Check | Steps | Expected result |
| --- | --- | --- |
| Inspect without disclosure | Click **Public login test**, then **Inspect website**. | Exact destination is `https://the-internet.herokuapp.com`; supported Username and Password requests appear with matching preview marks. Both boxes are unchecked and approval is disabled. Inspection does not prompt for Hello. |
| Cancel authentication | Enter the inspected origin in the Vault and click **Authenticate & list IDs**; cancel Hello, or observe its unavailability. | A bounded authentication error; metadata remains locked. No identity/value appears and no field is filled. |
| Save before browsing | Stop the website. Save a new Login ID such as `qa-login-20261031` for `https://the-internet.herokuapp.com`, username `qa-user`, password `Fictitious-only-123!`; complete Hello. | Save succeeds without opening a website. Draft values clear when sent. No success message is shown for failed authentication. |
| List and select | List IDs for that origin after successful Hello, then inspect the public login again. Use the matching Vault ID for website approval. | Only identities, not passwords, appear in the list. Selecting an ID checks no disclosure boxes and does not fill the page. A new inspection requires fresh field approval. |
| Partial login disclosure | Enter the saved ID, check **Username / email only**, and approve/authenticate. Inspect the separate protected browser. | Username is `qa-user`; Password stays empty. The app does not submit or claim successful login. The owner preview masks input values. |
| Full login disclosure | Stop, inspect afresh, choose the same ID, check both fields, and approve/authenticate. | Only the two selected inputs fill. Login is not clicked; the protected page remains open for review. |
| Payment-card exclusions | Save a new Payment card ID for `https://autofill.me`: name `QA User`, number `4111111111111111`, month `12`, year `2030`. Click **Public card test**, inspect as Payment card, select that ID, and explicitly approve supported fields. | Name, number, month, and year fill after Hello. CVV stays empty; no CVV approval exists. No payment or submission is made. Use this published test number only on test forms. |
| Deny | Inspect afresh and click **Deny & close website** before approval. | The protected website closes, the preview clears, and no retrieval/fill occurs. |
| Stop and Lock | With a filled test page open, click **Stop & close website**; repeat with **Lock vault & stop**. Also try Stop while an inspection or authentication is pending. | Authority ends, the protected page closes, the draft/list/preview clear, and late results do not revive the task. Stored records are not deleted; already-started saves can still complete. |
| Stop during replacement | Inspect a page, begin inspecting another URL, and immediately press Stop. | The app stays stopped after the old browser finishes closing; no replacement website opens afterward. A deterministic regression covers delayed teardown. |
| Expiry | Fill with the **1 minute** lifetime, then leave the owner window open without interacting. | After grant expiry, the protected page closes and cannot resume with the old approval. The lifetime begins at approval, including time spent authenticating. |
| Workstation lifecycle | With fictitious data only, lock Windows using **Win+L**, unlock, and inspect again. If relevant, separately test disconnect/reconnect. | Old website authority is removed and the old protected page closes; unlock/reconnect does not revive it. Secure-desktop Hello interaction and real lock/disconnect still require hardware verification. |
| Rejection and recovery | Try an `http://` page, an origin containing a path in the Vault, an unknown ID, or a mismatched record type. Then inspect a valid page again. | Unsupported requests do not disclose values. Errors remain bounded, and a fresh valid inspection is possible. |
| Preview and layout | Inspect, scroll, type an unsent Vault draft, and resize the owner window to about 390 px. | Preview refreshes do not steal focus, clear the draft, flicker between scenes, or create horizontal page overflow. Stopped/new inspections cannot display stale frames. |

For the existing offline demonstration, run `bun start --synthetic`: review **Run synthetic registration**, select Yellow and Red, then approve. Expect one intercepted synthetic registration and a completed state. Open **Audit history** and refresh to inspect the session; browsing history must not authorize execution. Close and restart the demonstration to test Deny or Stop independently. This fixture intentionally submits; normal website autofill does not. Optional real-model inference is a separate, still-unverified integration.

Repeatable automated checks:

```powershell
bun test
bun run typecheck
bun run smoke
bun test tests/autofill-owner.test.ts -t "Stop during replacement"
```

When reporting a failure, include the exact button sequence, target URL and selected record type, visible phase/error, whether the protected browser closed, and whether any unapproved field changed. Do not include record values, private IDs, passwords, card details, or unredacted screenshots.


## Synthetic task-entry and model-planning demonstration

```powershell
bun start --synthetic
```

This retains the isolated task-entry demonstration: **Run synthetic registration** → **Review task** → explicit Yellow/Red approval → one synthetic registration submission. Default reviewed-command mode is offline, not AI inference. Closing its window deletes its temporary synthetic vault. Unlike real-site autofill, this fixture intentionally submits its intercepted form.

Planning alone grants no execution authority. Stop, denial, and window closure abort pending planning; late responses cannot restore authority.

### Optional local or cloud model planning

These provider settings apply only to `bun start --synthetic`, not to real-site autofill. Configure the launching process, then restart that demonstration. No provider is selected or contacted by default. This is a bounded workflow router, not a general-purpose browser-agent tool interface.

| Environment variable | Meaning |
| --- | --- |
| `AUTOMATE_PLANNER` | `reviewed` (offline default), `local`, or `cloud` |
| `AUTOMATE_MODEL_ENDPOINT` | Full OpenAI-compatible chat-completions endpoint; no URL credentials, query, fragment, or redirects |
| `AUTOMATE_MODEL` | Model identifier served by the configured provider |
| `AUTOMATE_MODEL_API_KEY` | Bearer credential; required for cloud, optional for local; never displayed in the owner page |

For an already installed local model server with an OpenAI-compatible API:

```powershell
$env:AUTOMATE_PLANNER = 'local'
$env:AUTOMATE_MODEL_ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions'
$env:AUTOMATE_MODEL = 'your-installed-model'
bun start --synthetic
```

Replace `your-installed-model` with a model actually served by your installation. Local mode accepts only HTTP(S) endpoints on `localhost`, `127.0.0.1`, or `[::1]`. It does not install or start a model server. HTTPS certificate validation remains enabled.

Cloud mode requires `AUTOMATE_PLANNER=cloud`, an HTTPS chat-completions endpoint, a provider-supported model, and `AUTOMATE_MODEL_API_KEY`. Provision the key through your process environment; do not commit it, paste it into the task box, or include it in the endpoint URL. The UI additionally requires explicit consent before sending the instruction to the cloud. Cloud requests can incur provider charges.

Clicking **Ask model to plan** sends only the typed instruction and a fixed workflow-selection system prompt to the configured provider. Never enter secrets or private account data in the task instruction. The app does not send website content, preview frames, vault contents, credential catalogs, approval scopes, or browser handles. Provider retention and processing are outside this application's control. The application does not persist task instructions in its audit journal.

The only accepted model outputs are `{"workflow":"synthetic-registration"}` and `{"workflow":"unsupported"}`. Extra authority fields, arbitrary workflows, malformed responses, and oversized responses fail closed. Provider responses are limited to 32 KiB, completion content to 4,096 characters, and requests to 30 seconds; instructions are limited to 2,000 characters. Failure is shown without raw provider diagnostics. There are no automatic retries or fallback to another provider.

Actual model inference remains unverified on this machine: local servers at ports 11434 and 1234 were unavailable, and no cloud provider was used. Isolated protocol fixtures verified valid/invalid responses, transport restrictions, disclosure consent, cancellation, and the actual planning UI. Set `AUTOMATE_PLANNER=reviewed` to use the working offline path.


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
- Requesting quotes use rendered non-control text, not hidden descendants or control values. Whole text fragments must fit within the viewport and all rectangular overflow clips; partially clipped text, masks, transforms, nonrectangular clipping, and paint-containing ancestry fail closed.
- The `Registration` contract now requires `email` and `password` field-request descriptors containing the credential reference, trusted name/category, `fieldSelector`, and `requestSelector`. The old selector-only fields were removed.
- The observer refreshes at execution transitions and approximately every 300 ms plus capture time while active. Periodic capture pauses across intentional submission navigation, then the completed page is captured once. Stop and grant expiry revoke authority and promptly request protected-context closure without waiting for pending navigation or native persistence. Closing the owner window also stops an active task. None can undo data already disclosed, a dispatched submission, or an already-started native write.
- Expand **Audit history** to inspect persisted sessions without approving the task. History actions cannot issue grants, access the vault, or change the current task's authorization.

### Preview privacy boundary

The owner page runs in a separate browser context with application-owned assets, a restrictive CSP, and no preview HTTP server or listening endpoint. The website is displayed as an image, not as an embedded executable page. The model must never receive the owner browser handle, frames, quotes, or internal observer callbacks.

Ordinary inputs, textareas, selects, and contenteditable controls, including those in open shadow roots, are opaquely masked; visible iframe rectangles are masked in full. Redaction uses Sharp off-page: the raw screenshot exists only transiently in trusted host memory, and only the masked result reaches the owner renderer. Capture does not inject DOM masks/styles, disable website animations, or change its caret. This is **not universal page redaction**: closed shadow roots and secrets echoed into ordinary text, canvas, or images are not comprehensively covered. These pixels remain owner-only, never an alternative AI screenshot tool. No preview recording is persisted by the application.

The real-site renderer retains the last decoded frame, skips identical image/annotation replacements, reserves preview geometry, and binds frames and pending decodes to the current inspection. Late callbacks cannot restore an old scene after Stop or a new inspection.

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

Registration obtains `policy.executionSignal(grant, task)` before creating its browser context. Real-site autofill creates a secret-free inspection context on explicit owner request, then obtains the signal before native record retrieval or filling. This validates the live handle/task binding and deadline; it does not alone authorize disclosure. Revocation, Stop All, matching destination blocks, category changes, audit faults, and expiry abort affected active executions. Unrelated grants remain usable.

The broker schedules an unreferenced monotonic-clock-aware deadline timer for each grant, as well as checking deadlines at execution. Expiry revokes authority before abort callbacks and records `grant_expired` with reason `GRANT_EXPIRED`; history displays **Permission expired**. Timers are cleared when authority ends. Successful completion clears its timer without cancelling the final owner capture or later turning a completed task into an expiry event.

The executor attaches cancellation before asynchronous context creation. An abort starts context closure and stopped-state publication independently of awaited browser, observer, or native-store work. A context returned after cancellation is closed before navigation or credential access. Closure is observed in cleanup, listeners are detached, and Playwright teardown errors cannot escape as raw browser diagnostics; a teardown failure cannot produce a successful workflow result.

Native persistence is deliberately **not** abandoned, cancelled, or rolled back. If an already-started store operation confirms success after browser cancellation, the bounded result is `takeover` with `credentialSaved: true`, and nothing is filled/submitted afterward. `credentialSaved` reports acknowledged persistence, not a transactional guarantee that no write occurred when acknowledgement fails. Workflow completion still waits for that operation to settle even though the protected context closes earlier.

The broker alone provides cooperative application/runtime cancellation, not OS lock enforcement or a hard real-time deadline. The real-site launcher additionally uses the native workstation monitor described above; the synthetic demo does not. A blocked event loop, suspended host, or unresponsive browser can delay teardown. Already dispatched operations/network requests and completed native writes cannot be undone. Native Windows Hello prompts/processes are not cancelled by browser teardown, and independent native/Android operations are unchanged.

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

Local/cloud provider adapters remain limited to the synthetic workflow. Real-site autofill uses deterministic discovery plus explicit field approval, not model-authored actions. General autonomous browsing, cross-origin embedded payment flows, production authentication/lifecycle verification, OS notifications, and a security-reviewed production approval/process boundary remain outstanding. Models cannot supply selectors, destinations, credential references, or approval authority.

## Important limits

- Normal Windows vault operations use the desktop Windows Hello verification API and fail closed unless the OS returns `Verified`. This is an application gate, **not** a cryptographic user-presence requirement imposed on DPAPI itself. Windows 11 build 22000+ and configured Hello are required; positive authentication remains hardware-unverified here.
- A process running as the same Windows user can potentially use that user's DPAPI facilities. Malware and a compromised OS are outside the protection offered here.
- Android metadata protection is complete only for v2 records. Unmigrated v1 records retain plaintext metadata, and real-device authentication/migration behavior remains unverified.
- Passwords and payment-card values exist transiently as strings inside the trusted executor, native process, owner entry form, and receiving browser. JavaScript and PowerShell cannot guarantee memory zeroization.
- The receiving website can read credentials entered into its page. Same-origin scripts can transmit them to that site's server. Destination authorization is disclosure authorization.
- Protected tasks never resume arbitrary model observations. Registration closes on unexpected pages; fill-only sessions retain the protected page for owner review but close when original evidence changes or authority ends. This is not unrestricted takeover or a reusable signed-in browser profile.
- A workflow success selector is integration-specific evidence, not proof of remote account creation. Real sites require reviewed success/failure handling.
- Revocation and active expiry abort the executor's signal and request immediate context closure, rather than only waiting for another authorization check. They cannot undo prior disclosure/submission, guarantee atomic interruption of an in-flight browser operation, or impose a hard deadline on an unresponsive runtime/browser. Already-started native persistence can finish after cancellation.
- Broker-managed Windows workflows persist metadata-minimal authorization events, not a tamper-evident audit trail or live OS notification system. Independent native CLI and Android operations do not use that journal.
- The broker blocks exact origins. It does not automatically classify websites or credentials, enforce DNS/network isolation, or implement all-subdomain rules.
- Yellow/Orange/Red membership is enforced by the TypeScript broker, but a persistent category editor, custom category names, Android category policy, timed biometric-free approval windows, cross-device synchronization, and recovery/export are not implemented. A device-bound vault without a recovery design can lose access after key or device loss.

## Before using real credentials

Verify successful Windows Hello, positive-authentication interactions with the native session monitor, cancellation, and actual lock/disconnect behavior on configured hardware; finish authenticated production approval/process boundaries; verify Android legacy upgrades on a device; review native persistence and recovery; extend audit coverage to native owner/Android operations and add OS notifications; validate each intended site's workflow; perform independent security review before production use. Public test-form success is not production security evidence.

Android requires its own supported browser execution strategy. Do not substitute broad AccessibilityService permissions or unrestricted WebView JavaScript bridges for the desktop executor without a separate threat model.

## Verification performed

- Latest plain `bun test`: 171 tests passed across policy, audit/history, preview, cancellation, planning, typed vault schemas/native DPAPI, and real-site discovery/owner approval. Coverage includes independent pre-inspection Vault save/list, strict origin/revision checks, metadata projection, Lock/Stop interruption, selected-only disclosure, divergent Windows temporary-root interoperability, OTP/bank-field refusal, replaced/clipped evidence, numeric expiry selects, active expiry, bounded teardown, shadow-root/iframe/control mask invariance, moving-mask refusal, and capture without DOM/animation mutations.
- `bun run typecheck`: passed.
- `bun run smoke`: isolated synthetic Windows DPAPI persistence, headless Chromium form submission, durable audit privacy, and strict history-reader roundtrip passed against the intercepted synthetic HTTPS origin. This does not prove production authentication.
- The following distribution record is historical: the in-app static site and source-ZIP builder were superseded by the application-only private release and separate public homepage. Do not use the old site build/deployment commands as current instructions.
- Distribution verification: the real setup script and check-only mode passed; actionlint 1.7.12 validated the Windows verification/manual deployment workflows. `bun run build:site` produced an allowlisted 52-entry Windows source ZIP and SHA-256 checksum; extraction into a fresh temporary folder, frozen dependency installation, typecheck, and actual DPAPI/browser smoke all passed. The public static page was exercised at 1440/390 px in dark/light modes, with all public links returning 200, matching downloaded-ZIP checksum, no horizontal overflow, and no console errors. The ZIP excluded `.git`, `.local`, `node_modules`, maintainer context, and superseded model-setup artifacts. This is not a signed binary, a live deployment, or a cold-machine test of missing-Bun installation.
- Website stabilization run: Stop during delayed replacement teardown failed before the revision guard (`review` instead of `stopped`), then passed both its regression and a separate Chromium scenario with one website opened, only the owner context remaining, and zero vault calls. Pending setup cancellation closed its context before setup release; unsupported card-name/number/combined-expiry selects were refused before review. Controlled in-memory fictitious-data browser checks filled Username only with Password empty, filled card fields with CVV empty, recorded zero submissions, and verified Lock teardown and input masking. These data-source fixtures do not establish native authentication or encrypted storage.
- Current native owner-surface check: unavailable Hello kept metadata locked with a bounded refusal. The public login inspected with both disclosures unchecked; Deny cleared the preview and stopped execution. The 390 px layout had no horizontal page overflow. A separate offline synthetic UI run rejected an unsupported instruction, then completed the explicitly Yellow/Red-approved workflow with actual isolated DPAPI persistence.
- Test-run reliability caveat: the new unsupported-select regression initially exceeded Bun's 5-second default; API tracing showed successful rejection with slow Chromium setup/teardown, so it now uses the existing unsupported-form tests' 20-second budget. A subsequent plain full run produced nine cascading `SETUP_FAILED` errors in the shared core browser; its termination cause was not captured. Both the isolated core suite with API/browser tracing (15 tests) and the final full suite with browser tracing (170 tests) passed. The earlier cascade is not claimed resolved or evidence of production readiness.
- Actual public HTTPS autofill UI: explicitly approved login fields on The Internet and card fields on Autofill.me were filled using only published/fictitious verification data; no application POST occurred; CVV remained empty; inspection did not read the data source; audit bytes omitted URLs, record IDs, and values. Desktop and 390 px surfaces were inspected.
- Actual normal-vault UI: the real Windows adapter's unavailable-Hello refusal was shown without granting execution or changing website fields. Native session-monitor startup reported an active desktop, and a closed monitor refused authority. Positive Hello, actual lock/disconnect transitions, and secure-desktop authentication interactions remain unverified.
- Native typed-record tests: real isolated DPAPI save/read/list preserved Unicode usernames/passwords and cardholder text, hid identity/card/secret data at rest, refused cross-origin and kind mismatches, retained raw-password read compatibility, and refused synthetic access to real domains.
- Actual independent Vault column: saved two fictitious typed records before any website browser opened, using real native DPAPI in an isolated `.test` namespace; file bytes contained neither values nor identities. Authenticated-fixture listing exposed IDs only. Explicit username-only approval retrieved the encrypted login and filled just that field, with password untouched and no application POST. A delayed native list acknowledgement could not restore metadata after Lock. This intentionally synthetic proof does not verify Windows Hello.
- Actual preview stability: four unchanged native captures caused no image-source writes or annotation rebuilds and preserved Vault draft, focus, selection, scroll, and preview dimensions. A held old image decode and stale packet could not replace the next inspection. The Internet's public login rendered with zero capture-induced DOM mask/style mutations across four further frames. Desktop columns and the 390 px stacked layout had no horizontal overflow.
- Actual prototype UI: rejected an unsupported instruction without a grant, displayed the trusted reviewed plan, completed explicitly Yellow/Red-approved synthetic registration with real Windows DPAPI persistence and one Chromium submission, and kept protected model observations disabled. Audit content omitted task instructions and account identifiers. Desktop and 390 px surfaces were inspected; the narrow page had no horizontal overflow.
- Actual local-planning UI against an isolated protocol fixture: refused model-added destination authority, allowed a corrected retry to produce the reviewed plan, transmitted only the typed instruction plus fixed system prompt, and denied execution when the owner chose Deny. This proves the protocol/UI path, not real-model inference.
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

These results cover the stated isolated fixtures and two public test forms, not all attacks, real accounts/cards, hardware authentication, or arbitrary websites.
