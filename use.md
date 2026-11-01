# How to use Auto-Mate

## 1. What this tool does

Auto-Mate is a security-first browser automation project for Windows. It provides two operational modes:

1. **Local Desktop Mode**: Opens an owner-only interface in Chromium on **your Windows PC**. It uses native Windows Hello and DPAPI v2 to store encrypted Login or Payment card records, inspects supported HTTPS websites without reading vault secrets, and requires explicit owner approval for individual field disclosures. The local autofill flow is strictly fill-only; it never clicks Login, Pay, or Submit.
2. **Hosted Mode**: Runs the automation engine on an operator's Windows host laptop while remote users access the application over an invite-only HTTPS Internet connection (via Cloudflare QuickTunnel or an existing TLS reverse proxy). Users register with a lowercase username and strong passphrase (≥12 characters) and operator invite key (≥16 characters), protecting an isolated, server-side encrypted vault (AES-256-GCM + memory-hard scrypt). The remote user observes execution in a live, masked right-hand preview pane on desktop (stacked layout on mobile), approves field disclosures via confirmation popups, and explicitly approves individual website button clicks (Login, Submit, Next, Pay, or destructive actions) through a dedicated modal. The host operator can access active plaintext in host process memory (not zero-knowledge). The AI model never clicks buttons or submits forms autonomously.

**Development preview: use fictitious data and public test forms only.** This software is not a production password manager, general autonomous agent, or guarantee of perfect security. Filling itself discloses data to the receiving website and its scripts; Stop cannot recall data already sent across the network.

The public [homepage and simulated product film](https://github.com/anujparwal/Auto-Mate-homepage) are maintained in a separate repository. The application releases remain **private**. The portable application package contains no marketing homepage, demo film, or maintainer conversation memory.
## 2. Install the Windows application

Supported platform: **Windows 11 x64, build 22000+**, with the included Windows PowerShell 5.1 and .NET/DPAPI components. The portable application bundles Bun, its runtime dependencies, and Playwright Chromium; an application user does **not** need to install Bun, Node, npm packages, Docker, GPU software, or a local model.

### From the private preview release

1. Sign in with repository access and open [v0.1.0-preview.3](https://github.com/anujparwal/Auto-Mate/releases/tag/v0.1.0-preview.3). The public homepage does not offer a public app download.
2. Download `Auto-Mate-0.1.0-preview.3-windows-x64.zip` and `SHA256SUMS.txt` from that release.
3. Run `Get-FileHash .\Auto-Mate-0.1.0-preview.3-windows-x64.zip -Algorithm SHA256` and compare the complete hash with the matching checksum entry. Integrity is not publisher identity: this is an **unsigned private preview**, not a signed production installer.
4. Extract the complete ZIP into a **short path** in a folder you control, for example `%LOCALAPPDATA%\AM-preview`. Windows PowerShell's ZIP extraction can fail when a resulting path exceeds its legacy path limit. Keep `Auto-Mate.exe` and its bundled files together; do not run it from inside the archive.
5. In the extracted `Auto-Mate-0.1.0-preview.3-windows-x64` folder, run the bundled check:

   ```powershell
   $check = Start-Process -FilePath .\Auto-Mate.exe -ArgumentList '--check' -Wait -PassThru
   $check.ExitCode
   ```

   It must exit `0`; a synthetic runtime check is not proof of successful Windows Hello. No normal vault authentication is bypassed.
6. Double-click `Auto-Mate.exe` to open the actual owner application. Windows may warn about an unsigned download. Establish the trusted source and checksum; do not disable SmartScreen, antivirus, or an organization's policy.

This is a portable application, not a machine-wide installer. The homepage, film, developer conversation memory, and source-site deployment tooling are not part of its release archive. A clean Windows machine and downloaded-file security behavior still require separate acceptance checks.

### For contributors using a repository checkout

Source development additionally requires **Bun 1.4.4+**. From the repository root:

```powershell
powershell.exe -NoProfile -File .\tools\setup-windows.ps1
powershell.exe -NoProfile -File .\tools\setup-windows.ps1 -CheckOnly
```

Setup preserves existing installations, digest-verifies the pinned official Bun download when missing, installs locked dependencies and Chromium, and supports `-DeveloperTools` for missing Git/GitHub CLI. Those setup tools are not prerequisites for the bundled end-user application. No model hosting is installed.

## 3. Open the application: Local Mode vs. Hosted Mode

### Mode A: Local Desktop Mode (Windows Hello + DPAPI)

Portable release: double-click `Auto-Mate.exe`. Keep the console window open.

Repository checkout:
```powershell
bun start
```

Auto-Mate launches its own Chromium window automatically on your Windows desktop. Do not enter the internal `*.auto-mate.invalid` URL into an external browser: application assets and commands are bound to that specific launched browser process.

The **Vault** column manages encrypted records. The website column handles inspection and field disclosure. The live preview is an image for observation; enter data into the owner controls, not the preview image. A separate protected Chromium window displays the actual target website.

### Mode B: Hosted Mode (Remote HTTPS Access)

Portable release:
```powershell
.\Auto-Mate.exe --hosted
```

Repository source checkout (requires Bun 1.4.4+):
```powershell
bun run host
```

Hosted mode starts a local server on `127.0.0.1`, establishes an outbound HTTPS connection (via Cloudflare QuickTunnel or an existing reverse proxy configured via `AUTOMATE_HOSTED_PUBLIC_ORIGIN`), and prints the public invite URL and registration invite code (minimum 16 characters) to the operator console. See [Section 10](#10-hosted-mode-operator-and-remote-user-guide) for the complete step-by-step hosted guide and testing checklist.
## 4. Configure and verify Windows Hello

Open **Windows Settings → Accounts → Sign-in options** and configure an available Windows Hello method. Normal record save, identity list, and retrieval each require successful OS verification. Selecting fields is separate from authenticating.

If Hello is unavailable, cancelled, times out, or fails, the operation must be refused. There is no fallback password mode or authentication bypass. Successful Hello remains unverified on the development machine; a displayed refusal is not a successful vault test. Workstation/secure-desktop monitoring must also be checked on your hardware before private data is used.

## 5. Save a test record independently of any website

For a safe first Login test:

| Vault input | Fictitious example |
| --- | --- |
| Allowed HTTPS origin | `https://the-internet.herokuapp.com` |
| Record type | Login |
| Record ID | A new ID, e.g. `qa-login-20261031` |
| Username / email | `qa-user` |
| Password | `Fictitious-only-123!` |

The allowed origin has **no path, query, fragment, or embedded username/password**. Scheme, host, subdomain, and port are significant. A record for one origin is not reusable on a different origin.

Click **Authenticate & save encrypted record** and complete Hello. Draft values clear when sent, including when authentication fails; only a native success acknowledgement means storage succeeded. Saving does not open a website, select disclosures, or grant authority. **Reusing an ID for the same origin replaces that record**; use new IDs for testing.

Click **Authenticate & list IDs** for that origin to view owner-only record identities. Listing reveals no stored secret values and does not approve filling. The list is not a record-type catalog; select the correct Login/Payment card type yourself.

## 6. Inspect and approve a Login disclosure

1. Click **Public login test**, then **Inspect website**. Alternatively enter the full page URL `https://the-internet.herokuapp.com/login` with record type Login.
2. Verify the exact destination, quoted requesting text, and paired field marks. Inspection must not prompt for vault authentication or fill anything. All disclosure checkboxes start unchecked.
3. Enter the saved Record ID in the website approval section. Or choose it in the matching Vault origin/type and click **Use this ID for website approval**. ID selection alone approves nothing.
4. First check **Username / email only**. Choose a **1 minute** protected-page lifetime, then click **Approve selected fields & authenticate**.
5. Complete Hello. In the protected browser, Username should become `qa-user`; Password must remain empty. The app must not click Login or claim login success. The owner preview masks input values.
6. Click Stop, inspect afresh, and repeat with both fields checked to test full Login disclosure. These fictitious values are for filling tests, not successful authentication to the target service.

Supported controls require deterministic, visible label evidence. Ambiguous, replaced, clipped, embedded, or unsupported fields are omitted or refused. SSO, CAPTCHA, MFA, cross-origin payment frames, and arbitrary multi-step navigation are not bypassed. Some sites cannot function under exact-origin resource isolation.

## 7. Test a Payment card without making a payment

Save a new Payment card record for `https://autofill.me`, with name `QA User`, number `4111111111111111`, expiry month `12`, and year `2030`. This is a published test number, not a real account. Never use a real card in these development checks.

Click **Public card test** to select `https://autofill.me/form/credit-card-simple`, inspect as Payment card, select your new ID, and check the fields you approve. After Hello, only those supported fields should fill. Numeric month/year dropdowns are supported; card-name/number/combined-expiry dropdowns are not. **CVV/CVC must stay empty**; no CVV approval exists. PINs, OTPs, bank account numbers, and billing addresses are not stored or filled. Do not click a payment or submit button.

## 8. Deny, stop, lock, and expire

| Action | Expected behavior |
| --- | --- |
| Deny & close website before approval | Ends that inspection without retrieving/filling a record. |
| Stop & close website | Revokes authority, clears the owner draft/list/preview, and closes the protected page. |
| Lock vault & stop | Clears draft/visible metadata and stops the website; does not delete stored records. |
| Stop during inspection, authentication, or replacement teardown | Late work cannot revive authority or open a replacement page after cancellation. An already-started native save can still finish; writes are not rolled back. |
| Selected 1/5/15-minute lifetime expires | Protected page closes; old authority cannot be reused. Time starts at approval, including authentication time. |
| Close owner window, lock Windows, or disconnect | Requests protected-page closure and removes authority. Unlock/reconnect must not revive the old task. Actual lock/disconnect behavior still requires hardware testing. |

Inspect afresh for a new disclosure. Revocation cannot erase data already sent to website scripts or undo an already-started operation. Browser closure is cooperative, not a hard real-time guarantee.
## 9. Agent-assisted form inspection and missing-information dialogs

Auto-Mate supports general form inspection where the agent assists in mapping vault variables to form fields:

1. In the **Inspect a website** card, select record type **All form fields (Agent assisted)**.
2. Enter an HTTPS URL (e.g. a signup or profile form) and click **Inspect website**. Supported visible inputs (text, email, tel, url, username, password, select, textarea, date, number) are discovered with strict label evidence.
3. Click **1. Authenticate & list vault variables**. After native OS verification, the agent receives an allowlisted catalog containing all variable **names and descriptions** across your vault. **Secret values and ciphertexts are NEVER exposed to the agent.**
4. Click **2. Ask Agent to map fields**. The agent matches compatible variables to discovered fields.
5. **Missing Information Dialog**: Whenever the agent needs information that is not available in the vault (such as your Name on the first run, or a new username created for a specific website), a modal dialog box automatically appears:
   - Enter the requested value.
   - Optionally check **Save this to vault for future use**, specifying whether it should be saved as a **Shared profile** variable (reusable across websites for general profile data like your name) or a **Site-bound** variable (restricted to the current origin).
   - Click **Provide to Agent**, or click **Skip this field** if you do not wish to provide it.
6. Review the mapping badges on each field. Check only the fields you explicitly approve, choose a lifetime (1, 5, or 15 minutes), and click **Approve selected fields & fill**.
7. The app enters the values into the receiving fields. **It never clicks submit or creates an account autonomously.** Review the protected browser window yourself.
8. **Model output contract**: The AI planner receives only public field descriptors (id, label, kind, options) and the vault variable catalog (id, name, description, kind, scope, available). Secret values, ciphertexts, full DOM, browser handles, and page URLs are **never sent to the model**. The model must return a strict flat JSON map `{ [fieldId: string]: string | null }` matching all field IDs to compatible available variable IDs or null. Any extra keys, missing keys, markdown fences, or malformed JSON fail closed.

## 10. Hosted mode: operator and remote user guide

Auto-Mate Hosted Mode enables an operator on Windows to host the automation runtime and encrypted multi-user vaults, while remote users interact through any modern web browser over HTTPS.

### Step 1: Operator launches hosted mode

On the host Windows 11 PC, run:
```powershell
.\Auto-Mate.exe --hosted
```
or for source development:
```powershell
bun run host
```

### Step 2: Automated helper download and verification

When running with default Cloudflare QuickTunnel (`AUTOMATE_HOSTED_PUBLIC_ORIGIN` unset), Auto-Mate automatically checks for the official Cloudflare tunnel binary in `%LOCALAPPDATA%\AutoMate\tools\cloudflared-2026.10.7-amd64.exe`.

- If missing, Auto-Mate downloads official release `2026.10.7` for Windows x64.
- Verifies the binary against the official pinned SHA-256 digest: `2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343` (file size: 55,390,512 bytes).
- Corrupted or mismatched binaries fail closed and will not execute.

### Step 3: Operator runtime responsibilities

- **Keep laptop and terminal awake**: The operator's laptop executes the browser and maintains the network tunnel. Sleep, screen lock power-saving suspension, or closing the lid interrupts the server, network tunnels, and active user sessions (suspension interrupts the server rather than necessarily terminating it immediately, but active tunnel connections and client heartbeats will drop).
- **No firewall modifications**: QuickTunnel makes an outbound TLS connection to Cloudflare edge nodes; no inbound Windows firewall rules or port-forwarding changes are needed.
- **No local GPU or model setup**: The host machine does not need GPU hardware or local model weights; model planning uses the configured external OpenAI-compatible API.

### Step 4: Share connection details privately

Upon startup, the console displays:
1. The public HTTPS URL (e.g. `https://random-words.trycloudflare.com`).
2. The **registration invite key** (minimum 16 characters; randomly generated 32-character base64url code printed once if not set via `AUTOMATE_HOSTED_REGISTRATION_KEY`).

Share this URL and invite key **privately** with authorized users. There is **no open registration**; registration is strictly invite-only.

### Step 5: Remote user registration and authentication

1. The user navigates to the public HTTPS URL in their desktop or mobile browser.
2. On the **Register** tab:
   - Enter the operator's **Registration invite key** (minimum 16 characters). If invalid, the server rejects registration with HTTP 403 (`INVALID_REGISTRATION_KEY`).
   - Choose an **Auto-Mate Username**: Must be **strictly lowercase ASCII**, 3–64 characters, starting with a lowercase alphanumeric character and followed by lowercase alphanumeric characters, dots, underscores, or hyphens (`/^[a-z0-9][a-z0-9._-]{2,63}$/`). No case-folding or normalization is performed; lowercase is strictly required.
   - Choose a **Passphrase / Key**: Must be at least 12 characters (up to 1,024 characters). Passphrases are never trimmed or silently modified.
3. Click **Create encrypted account**.

### Step 6: Server-side vault encryption and security model

- **Independent user vaults**: Each account is assigned an isolated vault file (`<accountId>.vault`) stored in `%LOCALAPPDATA%\AutoMate\hosted\`.
- **Memory-hard KDF**: Passphrases derive keys using `scrypt` ($N=32768, r=8, p=1$, maxmem 64 MiB) with an independent cryptographically random 32-byte salt per user.
- **Domain-separated HMAC subkeys**: The derived master key produces two 32-byte subkeys:
  - `authSubkey`: Computes a constant-time login verifier (plaintext passphrases are never stored).
  - `encSubkey`: Directly encrypts the vault payload using AES-256-GCM (12-byte random nonce, 16-byte auth tag).
- **Key zeroization**: When an account session closes upon explicit logout or fixed 1-hour expiry, in-memory decryption subkeys are immediately wiped using `.fill(0)`.
- **Host operator plaintext access**: The host machine executes the Chromium browser and holds active decryption keys in process memory during an authenticated session. The host operator and any process with administrative access to the host machine can access active plaintext values in memory. Hosted mode is **not zero-knowledge**.
- **No recovery**: Because the host never stores plaintext passphrases or recovery keys, **a lost passphrase cannot be recovered**.

### Step 7: Session management, limits, and polling synchronization

- **Concurrency limit**: Default maximum of **4 concurrent active sessions** across all accounts on the host server.
- **Single session per account**: Signing in from a new browser or device immediately revokes and terminates the previous device session.
- **Session lifetime**: Sessions enforce a fixed **1 hour authentication expiry from sign-in** (`sessionTtlMs = 3,600,000`). It is **not** an inactivity timeout; user activity and polling do not extend this fixed deadline.
- **Disconnect grace period**: If the remote client loses connection, closes the tab, or backgrounds the browser for more than **5 seconds** (`disconnectGraceMs = 5000`):
  - Active website browser automation is stopped (`action: 'stop'`).
  - Active website authority is revoked, the protected website closes, and field approvals and one-off entries are cleared.
  - The account key stays in memory until explicit logout or fixed 1-hour expiry.
  - Resuming or reconnecting receives a fresh idle state and never resurrects old authority. Re-inspecting starts a fresh workflow.
- **Polling synchronization**: State and preview frames are synchronized via authenticated JSON polling (`GET /api/updates?after=sequence` every 500 ms). Server-Sent Events (SSE) were removed because Cloudflare QuickTunnel drops SSE stream bodies; Auto-Mate does not promise or require SSE support.

### Step 8: Remote observation and execution on host

- **Host laptop execution**: The Chromium browser runs on the **host laptop**. Target websites observe traffic originating from the **host laptop's IP address**, not the remote user's device IP.
- **Observation-only preview**: The remote user sees masked preview frames in the preview pane (positioned on the right side on desktop, collapsing to a stacked layout on mobile). Remote users cannot click or type directly in preview pixels.

### Step 9: Form field approvals and missing information

- **Unchecked disclosures**: All discovered form fields start unchecked. The user explicitly selects which fields to disclose.
- **Confirmation popup**: Clicking **Approve selected fields & fill** displays a modal popup confirming the target origin and specific fields before filling.
- **Sequential missing-info dialog**: If fields are missing from the vault:
  - A modal dialog opens for each missing field in sequence.
  - The user enters the value in their remote browser; the value stays on the trusted host.
  - The user may optionally check **Save this to vault for future use** as a **Shared profile** (for general non-credential variables like name or phone) or **Site-bound** (mandatory for credentials: usernames and passwords can never be saved as shared profiles).
  - The user can click **Skip this field** (leaves it unfilled) or press **Escape / Cancel** (aborts the workflow and stops execution).
  - **Secret values and ciphertexts are never sent to the AI model.**
- **Protected-page model boundary**: The metadata-only model API requires explicit user consent. External model observation is allowed only during a fresh, initial inspection. Once a fill or approved website button click occurs, external model observation is blocked because the destination page may echo previously disclosed secret values into labels or DOM. For subsequent field mappings, the user must explicitly choose **Map locally / ask me · No API**. There is **no automatic fallback** to external models.
### Step 10: Explicit modal approval for website button clicks

Unlike local autofill (which is strictly fill-only), hosted mode allows remote users to trigger website button clicks (e.g. Login, Submit, Next, Pay):

1. The page is inspected, and uniquely labelled, supported buttons appear under the **Website actions** card.
2. The user clicks **Request click: [Button Name]**.
3. A modal confirmation dialog opens with an explicit warning:
   > *"Allow this website button click? Website: [Origin] Button: “[Label]” This may submit data, navigate, purchase, or delete. Unfilled entries and previous field approvals will be cleared. No replacement button will be clicked."*
4. The user explicitly clicks **Approve** or **Deny**.
5. **No website buttons are ever clicked autonomously by the AI model.**

### Step 11: Network isolation and egress filtering

The host browser runs behind a strict DNS-pinned forward proxy:
- **Public HTTPS only**: Outbound traffic is restricted to port 443 over TLS.
- **Intranet & metadata blocking**: Destination IP addresses are verified before connection. The proxy rejects loopback (`127.0.0.0/8`, `::1`), private networks (RFC 1918 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), Carrier-Grade NAT (RFC 6598 `100.64.0.0/10`), link-local and cloud metadata (`169.254.0.0/16`, including AWS/GCP/Azure metadata `169.254.169.254`), and IPv6 ULA/link-local addresses (`fc00::/7`, `fe80::/10`).
- **Isolation boundaries**: Third-party off-origin requests, popups, downloads, WebSockets, and service workers are disabled or blocked. Embedded frames, CAPTCHAs, and MFA are not supported.

### Step 12: Trust boundaries and production configuration

- **Host operator trust**: The host operator and any process with administrative access to the host machine can access active plaintext in host memory. Hosted mode is **not zero-knowledge**; encryption at rest protects against cold disk theft, not an adversarial host. Local Windows Hello/DPAPI mode remains separate with its own device-bound trust model.
- **TLS reverse proxy trust**: The TLS termination endpoint (Cloudflare edge in QuickTunnel mode, or your custom reverse proxy) handles transport encryption.
- **QuickTunnel limits**: Cloudflare QuickTunnel (`*.trycloudflare.com`) is for temporary testing only. It offers no uptime SLA, changes URLs on every launch, enforces connection rate limits, and does not support SSE.
- **Production configuration**: For stable production hosting, configure an owned domain and TLS reverse proxy using:
  - `AUTOMATE_HOSTED_PUBLIC_ORIGIN`: Your public HTTPS domain (e.g. `https://automate.example.com`).
  - `AUTOMATE_HOSTED_PORT`: Your reverse proxy backend port (e.g. `3000`).

### Step 13: Operator and remote user hosted test checklist

Use this structured checklist to verify hosted mode operations thoroughly:

#### Operator Startup Checklist
1. **Release startup**: Run `.\Auto-Mate.exe --hosted` from an extracted portable package on Windows 11 x64.
2. **Source startup**: Alternatively, run `bun run host` from the repository source.
3. **Console verification**:
   - Verify local HTTP server binds to `127.0.0.1`.
   - Verify QuickTunnel starts and prints a valid `https://*.trycloudflare.com` URL (or custom origin when configured).
   - Verify registration invite key prints to console (minimum 16 characters).
4. **Host sleep management**: Ensure host machine sleep and screen-suspension power saving are disabled so network tunnels remain uninterrupted.

#### Remote User Registration & Sign-in Checklist
1. **Bad invite key**: Attempt registration with an incorrect invite key. Confirm rejection with HTTP 403 Forbidden (`INVALID_REGISTRATION_KEY`).
2. **Username policy**: Attempt registration with uppercase characters (e.g. `User1`). Confirm rejection (usernames must be strictly lowercase ASCII `/^[a-z0-9][a-z0-9._-]{2,63}$/`).
3. **Passphrase policy**: Attempt registration with a passphrase shorter than 12 characters. Confirm rejection.
4. **Successful registration**: Register with the operator invite key (≥16 chars), valid lowercase username, and passphrase (≥12 chars). Confirm account creation.
5. **Single session enforcement**: Sign in on Browser A. Then sign in with the same account on Browser B. Confirm that Browser A is immediately revoked and closed.
6. **Fixed 1-hour expiry**: Verify the session expires exactly 1 hour from sign-in (`sessionTtlMs = 3,600,000`). Polling and user actions do not extend this deadline.

#### Observation & Layout Checklist
1. **Desktop view**: On a screen >1000px wide, verify a two-column layout with controls on the left and live website preview on the right.
2. **Mobile view**: Resize browser width to <768px (or mobile device). Verify controls and preview collapse into a vertical stacked layout.
3. **Observation-only**: Confirm that clicking or typing inside the preview image does not interact with the target page; all actions occur via application buttons.

#### Field Approval & Missing Information Checklist
1. **Unchecked start**: Inspect an HTTPS test form (e.g. `https://the-internet.herokuapp.com`). Confirm all field checkboxes start unchecked.
2. **Approval modal**: Select fields and click **Approve selected fields & fill**. Confirm confirmation modal displays target origin and field names before filling.
3. **Missing info dialog**: For fields missing from the vault, confirm modal prompts sequentially. Verify credential values (username/password) enforce site-bound storage; non-credentials allow shared profile.
4. **Protected-page model boundary**: After filling fields, verify external model observation is blocked. Confirm subsequent mappings offer **Map locally / ask me · No API**, with no auto fallback.

#### Website Button Click Approval Checklist
1. **Discovered actions**: Inspect a supported page with buttons. Confirm discovered buttons appear under **Website actions**.
2. **Click request**: Click **Request click: [Button Name]**. Confirm dedicated confirmation modal appears with explicit warning and button label.
3. **State reset**: Confirm that approving a button click clears previous field approvals and unfilled entries before clicking.

#### Disconnect & Resumption Checklist
1. **Disconnect / Backgrounding (>5s)**: Background the mobile browser or disconnect network for >5 seconds.
2. **Protected website closure**: Verify active website browser closes on the host and approvals/one-offs are cleared.
3. **Account key retention**: Verify account login / encryption key stays active in server memory until logout or fixed 1-hour expiry.
4. **Fresh state on resume**: Reconnect or foreground browser. Verify the client receives a fresh idle state and never resurrects old website authority.

#### Explicit Sign-Out Checklist
1. **Sign out**: Click **Sign Out**. Confirm immediate token revocation, browser context closure, and in-memory key buffer zeroization (`.fill(0)`).

---

## 11. Connect supplied OpenAI-compatible API

Auto-Mate supports connecting a user-supplied OpenAI-compatible API for bounded workflow selection and agent-assisted form mapping. See [docs/model-api.md](docs/model-api.md) for full configuration details.

### Configuration

The API configuration is loaded from `model-config.json` in the application directory or process environment variables:
- **Endpoint**: Full HTTPS chat-completions URL (e.g. `https://nullify-geometric-decathlon.ngrok-free.dev/v1/chat/completions`).
- **Model**: Exact model identifier (e.g. `qwen3.5-9b`). The configured server exposes `POST /v1/chat/completions` only and does not advertise a `/models` endpoint; model weights identity is unverified (do not claim 9B weights verified).
- **Current Availability**: Real metadata-only probes previously passed against this endpoint, but the exact provided endpoint currently returns HTTP 404 (`ERR_NGROK_3200`: ngrok tunnel offline / endpoint not found). No Qwen or Colab setup is provided, hosted, or required.
- **API Key**: Optional `AUTOMATE_MODEL_API_KEY` environment variable. Never supply a dummy key.
- **Validation Rules**: Cloud endpoints strictly require HTTPS (`https://`). Genuine loopback (`127.0.0.1`, `localhost`, `[::1]`) permits `http://`. Embedded credentials (`UserInfo`), query parameters (`?query`), and URL fragments (`#fragment`) fail validation.

### Model Contract and Privacy

- **Explicit User Consent**: External model planning requires explicit user consent (selecting "All form fields (Agent assisted)" or cloud mode).
- **Form Mapping (`InformationPlanner`)**: The model receives only public field descriptors (id, label, kind, options) and the vault variable catalog (id, name, description, kind, scope, available). Secrets, ciphertexts, full DOM, browser handles, and page URLs are **never sent**. The model must return a strict flat JSON map `{ [fieldId: string]: string | null }` matching all field IDs to compatible available variable IDs or null. Malformed, missing, or extra keys fail closed.
- **Protected-page model boundary**: Once a fill or approved website button click occurs, external model observation is blocked because the receiving page may echo disclosed secret values into labels or DOM. For subsequent field mappings, the user must explicitly choose **Map locally / ask me · No API**. There is **no automatic fallback** to external models.
- **Synthetic Workflow Selection**: Used in `bun start --synthetic` to select `{"workflow":"synthetic-registration"}` or `{"workflow":"unsupported"}`.
- **No Autonomous Authority**: Models cannot operate browser tools, execute clicks, or access the vault directly.

## 12. Run the automated checks


From the project root:

```powershell
bun run typecheck
bun test
bun run smoke
powershell.exe -NoProfile -File .\platforms\windows\smoke-test.ps1
```

Tests and smoke use isolated synthetic vault namespaces and test origins. They do not bypass normal-vault authentication or prove real hardware verification. See [README.md](README.md#verification-performed) for evidence and limits, including a previously observed intermittent browser-setup cascade that passed diagnostic reruns but is not claimed resolved. For browser diagnostics from PowerShell, set `$env:DEBUG='pw:browser'`, run `bun test`, then `Remove-Item Env:DEBUG`.

The native smoke must report `Unicode secrets survive detached write and UTF-8-console read exactly` as passing, alongside encryption, restrictive ACL, migration, origin-refusal, and authentication-refusal checks. It uses only an isolated fictitious secret and restores its console encodings afterward.

For a manual acceptance matrix, use [README.md](README.md#website-acceptance-checklist). Also check the owner UI at about 390 px width: no horizontal page overflow, no focus/draft loss from preview refresh, and no stale frame after Stop.

## 13. Build and publish the application separately from the homepage

The application repository and its first release remain **private**. Build the application-only portable archive on Windows:

```powershell
bun run build:app
bun run check:app
```

`dist/app/` contains `Auto-Mate-0.1.0-preview.3-windows-x64.zip`, `SHA256SUMS.txt`, and release metadata. Publish the application ZIP and checksum as a **prerelease** of the reviewed, tested source commit. Do not upload the former source-site ZIP, homepage source, demo film, vault data, `.env` files, keys, or maintainer conversation memory. The archive includes required runtime components and third-party license notices.

`check:app` validates the checksum and application-only archive boundary, extracts into a temporary path containing spaces and Unicode, and runs the actual bundled `Auto-Mate.exe --check` with global Bun/Node excluded from `PATH`. It exercises the packaged DPAPI/Chromium path, not just the source checkout. It does not prove successful Hello authentication, signing, or a clean-machine installation.

The public homepage and non-interactive simulated film live only in [Auto-Mate-homepage](https://github.com/anujparwal/Auto-Mate-homepage). Its own build and Pages workflow publish static marketing assets; they never start a native broker or receive a user's vault. The previous app-side static site/source-package deployment has been removed to avoid publishing application source through the wrong path. Follow the homepage repository's instructions to edit, render, or deploy it.

The first release is an unsigned, test-data-only private preview—not production approval. Successful Hello/session tests, clean-machine installation, repeatable browser reliability, independent security review, signing, and a recovery strategy remain gates before recommending private credentials or public application distribution.

## 14. Troubleshooting and data handling

- **Authentication refusal:** configure Windows Hello and verify an interactive signed-in desktop. Stop and inspect again after resolving it. Do not turn on synthetic mode for real domains.
- **No supported fields:** verify record type, full visibility, and explicit labels; an unsupported site is not permission to weaken evidence checks.
- **Record rejected:** check the exact origin/type/ID. A successful list is not approval. Preserve IDs and credential values exactly; do not silently trim passwords or rewrite legacy secrets.
- **Model failure:** check full endpoint path, exact model name, TLS/authentication, non-thinking server configuration, and raw-JSON behavior using synthetic prompts. Auto-Mate rejects malformed/oversized/authority-bearing replies; there is no automatic retry or provider fallback.
- **Script blocked:** review the script and unblock only the reviewed downloaded file if organizational policy permits; do not disable global protections.
- **Report a bug:** include button order, public target URL, record type, visible phase/error, whether the protected page closed, and whether an unapproved field changed. Never send values, private IDs, API keys, vault files, or unredacted screenshots.

Normal encrypted data and audit files are outside the extracted application folder: the default vault is `%LOCALAPPDATA%\Auto-Mate\vault.json`, and broker audit journals are under `%LOCALAPPDATA%\AutoMate\audit\`. Deleting the application folder is not a vault-deletion or recovery procedure. DPAPI is tied to the Windows user/device context; same-user malware and a compromised OS are outside its guarantee. There is no supported cross-device recovery/export design yet. Do not entrust irreplaceable private credentials to this preview.
