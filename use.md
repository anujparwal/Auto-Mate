# How to use Auto-Mate

## 1. What this tool does

Auto-Mate is a security-first browser automation agent workspace for Windows. It provides two operational modes:

1. **Local Desktop Mode**: Opens an owner-supervised Agent Workspace in Chromium on **your Windows PC**. It uses native Windows Hello and DPAPI v2 for encrypted vault credentials, and DPAPI `CurrentUser` encryption for workspace settings, permanent memory, groups, and research notes (`src/workspace-store.ts`). Permitted model endpoints include local loopback (`localhost`, `127.0.0.1`, `::1`) or cloud HTTPS.
2. **Hosted Mode**: Runs the automation engine on an operator's Windows host machine (or container) while remote users interact over HTTPS from any desktop or mobile browser. Users register with a lowercase username and strong passphrase (≥12 characters); registration is **open by default** with no operator invite code required unless the operator explicitly configures `AUTOMATE_HOSTED_REGISTRATION_KEY`. Accounts, vaults, and workspaces are protected by memory-hard scrypt ($N=32768, r=8, p=1$) and AES-256-GCM. Remote users observe masked live preview frames, chat with the agent, manage variables, approve website button clicks, and grant task-scoped permissions. Model endpoints in hosted mode are strictly restricted to cloud HTTPS; local loopback models are forbidden.

**Development preview: use fictitious data and public test forms only.** This software is not a production password manager, general autonomous agent, or guarantee of perfect security. Disclosing data to a website allows that site's scripts to receive it; Stop cannot recall data already transmitted across the network.

The public [homepage and simulated product film](https://github.com/anujparwal/Auto-Mate-homepage) are maintained in a separate repository. The application releases remain **private**. The portable application package contains no marketing homepage, demo film, or maintainer conversation memory.

---

## 2. Install the Windows application

Supported platform: **Windows 11 x64, build 22000+**, with the included Windows PowerShell 5.1 and .NET/DPAPI components. The portable application bundles Bun, its runtime dependencies, and Playwright Chromium; an application user does **not** need to install Bun, Node, npm packages, Docker, GPU software, or a local model.

### From the private preview release

1. Sign in with repository access and open prerelease `v0.2.0-preview.1`.
2. Download `Auto-Mate-0.2.0-preview.1-windows-x64.zip` and `SHA256SUMS.txt`.
3. Run `Get-FileHash .\Auto-Mate-0.2.0-preview.1-windows-x64.zip -Algorithm SHA256` and compare the hash with the matching checksum entry.
4. Extract the complete ZIP into a **short path** in a folder you control, for example `%LOCALAPPDATA%\AM-preview`. Keep `Auto-Mate.exe` and its bundled files together.
5. In the extracted folder, run the bundled check:
   ```powershell
   $check = Start-Process -FilePath .\Auto-Mate.exe -ArgumentList '--check' -Wait -PassThru
   $check.ExitCode
   ```
   It must exit `0`.
6. Double-click `Auto-Mate.exe` to open the application workspace.

### For contributors using a repository checkout

Source development requires **Bun 1.4.4+**. From the repository root:

```powershell
powershell.exe -NoProfile -File .\tools\setup-windows.ps1
powershell.exe -NoProfile -File .\tools\setup-windows.ps1 -CheckOnly
```

Setup verifies dependencies, installs Chromium, and configures the environment. No local model setup or GPU software is installed.

---

## 3. Open the application: Local Desktop Mode vs. Hosted Mode

### Mode A: Local Desktop Mode (Windows Hello + DPAPI)

Portable release: double-click `Auto-Mate.exe`. Keep the console window open.

Repository checkout:
```powershell
bun start
```

Auto-Mate launches its own Chromium window automatically on your Windows desktop. Assets and commands are bound to that specific launched browser process.

### Mode B: Hosted Mode (Remote HTTPS Access)

Portable release:
```powershell
.\Auto-Mate.exe --hosted
```

Repository source checkout (requires Bun 1.4.4+):
```powershell
bun run host
```

Hosted mode starts a local server on `127.0.0.1`, establishes an outbound HTTPS connection (via Cloudflare QuickTunnel or a custom reverse proxy configured via `AUTOMATE_HOSTED_PUBLIC_ORIGIN`), and prints the public invite URL. See [Section 12](#12-hosted-mode-operator-and-remote-user-guide) for the complete hosted guide.

---

## 4. Two-Column Agent Workspace Layout

The application presents a clean two-column workspace matching the application layout:

```
+------------------------------------+-------------------------------------+
| Left Column: Agent Chat            | Right Column (Top): Live Preview    |
| - Chat stream (user, agent, tools) | - Masked browser stream (Sharp)     |
| - Instruction prompt input         | - Origin badge & live status badge  |
| - Send and Stop controls           | - Pure observation (owner only)     |
|                                    +-------------------------------------+
|                                    | Right Column (Bottom): Vault & Tabs |
|                                    | - [Variables] [Permissions] [Notes] |
|                                    | - "+ Add Variable" button           |
|                                    | - Task-scoped grants & revocation   |
+------------------------------------+-------------------------------------+
```

1. **Left Column — Chats between the user and the agent**:
   - Displays dialogue bubbles for user prompts, assistant action summaries, tool invocations, subagent findings, and status badges.
   - Enter your prompt into the text field (e.g. *"Go to wikipedia.org and research renewable energy"* or *"Log in to the test portal"*).
   - Click **Send** to start the task.
   - Click **Stop** at any time to safely abort execution, close the active browser context, cancel pending dialogs, clear task grants, and reset the preview.
2. **Right Column (Top) — Live Preview**:
   - Streams live, masked browser frames from the Playwright browser.
   - Redaction uses Sharp off-page: all form controls, iframes, and reflected secrets are masked with opaque black rectangles.
   - The live preview is strictly for the human owner to observe execution. **Screenshots are NEVER sent to the AI model.**
3. **Right Column (Bottom) — Vault and Permissions**:
   - **Variables Tab**: Displays all saved vault variables with their names, descriptions, data kinds, scopes, and allowed origins. Includes a **+ Add Variable** button to save new encrypted records.
   - **Ongoing Permissions Tab**: Shows active task-scoped grants. Provides a quick-grant control for the currently active origin, allowing you to grant single variables or named variable groups directly for the active task, as well as revoke existing grants.
   - **Notes Space Tab**: Displays live research notes collected by the orchestrator and parallel evaluator subagents, each with a source URL and a verified verbatim evidence quote.

---

## 5. Configure Settings (⚙️ Settings)

Click the **⚙️ Settings** button in the header:

### Model Configuration
1. **Preset Selection**:
   - Choose from built-in presets: **OpenAI**, **Groq**, **OpenRouter**, **Ollama**, **LM Studio**, or **Custom**.
   - Preset defaults automatically populate standard endpoints and recommended models.
2. **Endpoint and Exact Model ID**:
   - In **Hosted Mode**, endpoints must be cloud HTTPS (`https://`). Local loopback endpoints are forbidden (`LOCAL_MODEL_FORBIDDEN_IN_HOSTED`).
   - In **Local Desktop Mode**, genuine loopback addresses (`http://127.0.0.1:11434`, `http://localhost:1234`, etc.) are permitted alongside cloud HTTPS endpoints.
   - Endpoints are automatically normalized to append `/v1/chat/completions` if omitted.
3. **API Key**:
   - Enter your provider API key. Keys are stored in the encrypted workspace store and are never displayed in the UI or written to plaintext files.
4. **Visible Model Errors**:
   - If your endpoint is offline, invalid, or returns an error, the UI displays a clear banner (e.g., *"The selected model could not be reached. Check its endpoint, model name and API key. No provider fallback was used."*). **There is no fake fallback or command mode in the new app.**

### Navigation Policy (Whitelist / Blacklist)
- **Whitelist Mode**: The agent is restricted strictly to domains listed in your policy. Any navigation to unlisted domains fails closed (`NAVIGATION_DENIED`).
- **Blacklist Mode**: The agent can navigate public HTTPS sites except those listed in the blacklist.
- **Subdomain Rules**: Specifying a domain automatically covers all its subdomains (e.g., `example.com` covers `api.example.com` and `login.example.com`).

### Permanent Memory (Opt-in)
- Toggle **Enable permanent memory** on or off.
- Edit persistent memory notes (up to 32 KiB) that provide ongoing context to the agent across tasks.
- Keep credentials and sensitive secrets out of permanent memory; enabled memory is included in model prompt contexts.

### Variable Groups
- Define up to 32 named groups (e.g., *"Work Profile"*, *"Shipping Details"*) containing up to 32 variable names each.
- In the **Ongoing Permissions** tab, you can grant an entire group to an active website origin in one click for the current task.

---

## 6. Vault Variables and Privacy Boundary

### Variable Metadata vs. Secret Values
- The AI model receives **only** sanitized variable metadata:
  - `id`, `name` (redacted), `description` (redacted), `kind`, `scope`, and `available`.
- Secret values, passwords, card numbers, and ciphertexts are **NEVER sent to the model**.
- When a variable fill is approved, the host controller reads the secret from the vault and injects it directly into the browser field via Playwright.

### Site-Bound Credentials vs. Shared Profiles
- **Site-Bound (Mandatory for credentials)**: Variables with kind `username` or `password` must be site-bound to an exact HTTPS origin (e.g., `https://the-internet.herokuapp.com`). They can never be used on a different origin.
- **Shared Profile (Non-credentials only)**: General profile variables (e.g., full name, phone number, address) can be scoped as `profile`, permitting them to be reused across authorized websites with user approval.

### Adding Variables
Click **+ Add Variable** in the Variables tab:
- Enter variable Name and Description.
- Enter the Secret Value.
- Choose Data Kind (`text`, `email`, `tel`, `url`, `username`, `password`, `date`, `number`).
- Choose Scope (`site` or `profile`). Credentials strictly require `site`.
- Specify Allowed Origin (e.g., `https://example.com`).

---

## 7. Interactive Missing-Information Dialog

When the agent navigates to a form requiring information not available in the vault (such as a registration form asking for a name or phone number):

1. The agent invokes `request_information` for the unvaulted field.
2. A modal dialog opens sequentially for each missing field:
   - Displays the field label, data kind, and target origin.
   - Enter the requested value locally.
   - Optionally check **Save this to vault for future use**: choose scope (`site` or `profile`) and enter a name and description.
   - Click **Provide to Agent** to fill the field, or click **Skip this field** to leave it unfilled.
3. The value is sent directly to host memory and injected into the field. **It never appears in the chat stream or model prompts.**

---

## 8. Ongoing Permissions, Task-Scoped Grants, and Revocation

### One-Off Confirmations
- **Ungranted Variable Fill**: When the agent requests to fill a variable that has not been pre-granted, a modal dialog appears asking: *"Fill this exact field with [Variable Name]? Website scripts receive the value; the model does not."*
- **Website Actions & Buttons**: When the agent attempts to click a website button (Login, Submit, Next, Pay, or destructive action), a dedicated confirmation modal opens: *"This click can submit, purchase, delete, or disclose data. Review the actual live browser before approving. Stop cannot undo a submitted action."*

### Task-Scoped Pre-Grants
- In the **Ongoing Permissions** tab, you can pre-grant single variables or entire variable groups to the active origin.
- Pre-granted variables are filled directly by the host during that task without interrupting with confirmation modals.
- Grants are strictly scoped to the active task and origin.

### Immediate Revocation
- Click **Revoke** next to any active grant in the Ongoing Permissions tab to revoke authority immediately. If that grant was actively being filled, execution stops.
- Clicking **Stop** or issuing a follow-up prompt revokes all task-scoped grants immediately.

---

## 9. Windows Hello Native Reads (Desktop Mode)

In Local Desktop Mode, every vault read for field filling enforces native Windows Hello verification:

- Open **Windows Settings → Accounts → Sign-in options** and ensure Windows Hello (PIN, facial recognition, or fingerprint) is configured.
- When the host retrieves an encrypted credential for filling, the native Windows Hello dialog appears.
- Completing Hello authorizes retrieval for that specific operation.
- Cancelling or failing Hello blocks retrieval; no field is filled.
- There is no master password fallback, cached unlock lease, or synthetic authentication bypass on real origins.

---

## 10. Safe Stop and Cancellation

- Click the red **Stop** button in the chat column at any time.
- Stop immediately aborts the active task controller (`AbortSignal`).
- The active Playwright browser context is closed immediately.
- Pending missing-information dialogs and permission modals are cancelled.
- Active task-scoped grants are wiped.
- The live preview resets to the idle shell.
- Sending a follow-up prompt while a task is running automatically and safely stops the running task before beginning the new task.

---

## 11. Parallel Cookie-less Evaluators & Purchase Protection

### Parallel Evaluator Subagents (`spawn_subagents`)
- When researching topics, comparing products, or synthesizing multi-source findings, the orchestrator spawns 2–6 parallel subagents.
- Up to 3 parallel worker contexts evaluate independent candidate URLs.
- **Signed-out and cookie-less**: Evaluator contexts have no cookies, sessions, or credentials from the main browser.
- **Verbatim quotes required**: Every finding must quote verbatim text from the observed public page. Unsupported claims fail closed (`NOTE_EVIDENCE_MISSING`).
- Findings appear in the **Notes Space** tab.

### Purchase approvals are not purchase proof
- Buttons require explicit confirmation. After a private fill, main-browser navigation and link clicks also require confirmation; a variable/group grant does not approve them.
- The model is instructed not to invent successful actions, but instructions are not a guarantee of accuracy. Exact source quotes and signed-out evaluators reduce unsupported findings.
- An approved action may place a real order. Review the site and verify its order confirmation or receipt yourself; Stop cannot undo an already submitted purchase.
- Known-value redaction is best effort. Do not paste secrets in chat, memory, variable names, or descriptions. Site scripts receive data you authorize for filling.

---

## 12. Hosted Mode: Operator and Remote User Guide

### Operator Startup
1. Launch hosted mode:
   ```powershell
   .\Auto-Mate.exe --hosted
   ```
   Or from repository source:
   ```powershell
   bun run host
   ```
2. Auto-Mate verifies the pinned Cloudflare tunnel helper binary (`cloudflared-windows-amd64.exe` v2026.10.7, SHA-256 `2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343`).
3. The console displays the public HTTPS URL (e.g. `https://random-words.trycloudflare.com`).
4. **Registration Mode**:
   - Registration is **open by default** (no operator code needed).
   - If `AUTOMATE_HOSTED_REGISTRATION_KEY` is set in the environment, users must provide that key (≥16 chars) upon registration.

### Remote User Registration & Sign-in
1. Navigate to the public HTTPS URL.
2. Register with:
   - **Username**: Strictly lowercase ASCII, 3–64 characters (`^[a-z0-9][a-z0-9._-]{2,63}$`).
   - **Passphrase / Key**: At least 12 characters (up to 1,024 characters).
3. Click **Create encrypted account**.

### Hosted Cryptography & Trust Boundary
- Each account receives an isolated vault (`<accountId>.vault`) and workspace (`<accountId>.workspace`) in `%LOCALAPPDATA%\AutoMate\hosted` (or `/data` in Docker).
- Memory-hard `scrypt` ($N=32768, r=8, p=1$, maxmem 64 MiB) derives domain-separated HMAC-SHA256 subkeys (`authSubkey`, `encSubkey`).
- Vaults and workspaces are encrypted with AES-256-GCM.
- When an account session closes, key buffers are zeroed (`.fill(0)`).
- **Host operator trust**: The host operator has access to active process memory and plaintext values. Hosted mode is **not zero-knowledge**.

### Session Lifecycle
- Up to 4 concurrent active sessions across all accounts.
- Single session per account (signing in from a new device immediately replaces the previous device).
- Fixed 1-hour authentication expiry from sign-in (not inactivity).
- 5-second disconnect/background grace period: if connection is lost for >5 seconds, the active website closes and authority is revoked; reconnecting receives fresh state.
- Polling synchronization: state and preview frames synchronize via 500 ms authenticated JSON polling (`GET /api/updates?after=sequence`; no SSE).

---

## 13. Concrete Manual Testing Checklist

Run these manual checks using **fictitious test data only**:

| Check | Steps | Expected Result |
| :--- | :--- | :--- |
| **1. Initial Workspace State** | Run `bun start`. | Two-column layout opens. Left column displays chat with greeting; right column displays preview shell and Vault & Permissions tabs. |
| **2. Model Error Visibility** | In **⚙️ Settings**, select **Custom**, set endpoint to `http://127.0.0.1:9999/v1/chat/completions`, model `test`. Send prompt `"Hello"`. | UI displays visible error banner: *"The selected model could not be reached. Check its endpoint, model name and API key. No provider fallback was used."* No fake fallback or command mode occurs. |
| **3. Navigation Policy Filtering** | In **⚙️ Settings**, set navigation to **Whitelist**, add `wikipedia.org`. In chat, prompt `"Go to duckduckgo.com"`. | The request is blocked cleanly by policy (`NAVIGATION_DENIED`). |
| **4. Public Research & Notes Space** | Configure a valid model. In chat, type `"Research the Python programming language on wikipedia.org and take notes on its creator."` | The agent navigates to Wikipedia, streams masked frames, extracts findings with verbatim evidence quotes, and records them in the **Notes Space** tab. Evaluator subagents verify findings. |
| **5. Missing-Information Dialog** | Prompt agent to navigate to `https://the-internet.herokuapp.com/login` and log in. | The agent discovers fields and calls `request_information`. A private modal dialog opens for username/password. Enter test values and save as site-bound. Values fill directly into the page without appearing in chat. |
| **6. Variable Pre-Grants & Revocation** | In **Variables** tab, add a variable for `https://the-internet.herokuapp.com`. In **Ongoing Permissions**, grant it to the active site. Re-run login. | The agent fills the field without prompting for one-off modal confirmation. Click **Revoke**; subsequent fills prompt for confirmation. |
| **7. Safe Stop & Cancellation** | Start a multi-step research prompt. Click the red **Stop** button while the agent is running. | The task aborts immediately (`TASK_STOPPED`). The browser closes, pending dialogs cancel, grants clear, status returns to `Stopped`, and preview resets. |
| **8. Button Click Confirmation** | Instruct the agent to click a website button (e.g. Login). | Confirmation modal opens detailing origin and button label. Denying prevents the click; approving allows the host to click. Agent never clicks buttons autonomously. |
| **9. Windows Hello Native Reads** | In desktop mode, save a credential in the vault and instruct the agent to fill it. | Windows Hello prompts for OS authentication. Completing Hello authorizes retrieval; cancelling aborts the fill. |

---

## 14. Run the Automated Checks

From the project root:

```powershell
bun run typecheck
bun test
bun run smoke
powershell.exe -NoProfile -File .\platforms\windows\smoke-test.ps1
```

Tests and smoke use isolated synthetic vault namespaces and test origins. They do not bypass normal-vault authentication or prove real hardware verification.

---

## 15. Troubleshooting and Data Handling

- **Model failure:** Check endpoint URL, model name, and API key. In hosted mode, verify endpoint is HTTPS. Auto-Mate displays model errors visibly; no automatic fallback exists.
- **Authentication refusal:** Ensure Windows Hello is configured in Windows Settings → Accounts → Sign-in options.
- **Navigation blocked:** Check the navigation policy in Settings (Whitelist vs. Blacklist) and ensure the target domain and subdomains are permitted.
- **Data locations:**
  - Local desktop vault: `%LOCALAPPDATA%\Auto-Mate\vault.json`
  - Local desktop workspace store: `%LOCALAPPDATA%\Auto-Mate\workspace.json` (DPAPI CurrentUser encrypted)
  - Hosted mode data directory: `%LOCALAPPDATA%\AutoMate\hosted` (or `/data` in Docker)
  - Audit journals: `%LOCALAPPDATA%\AutoMate\audit\`
- **Backups:** For hosted mode, regularly back up the data directory. Deleting or recreating containers without persistent volumes results in permanent loss of user accounts and vaults.
