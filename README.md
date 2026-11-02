# Auto-Mate

Security-first browser automation agent workspace for Windows and Android.

**Development software. Do not put real credentials in it yet.** This repository does not claim zero-risk security, production readiness, or a complete autonomous agent. It deliberately does not expose native vault operations as model tools.

**Start here:** [use.md](use.md) contains portable-app installation, the complete agent workspace workflow, fictitious-data tests, source development, hosted mode instructions, and supplied-API configuration. [docs/hosting.md](docs/hosting.md) details hosted mode architecture, cryptography, and network isolation. [docs/model-api.md](docs/model-api.md) documents the OpenAI-compatible model contract. [CONTEXT.MD](CONTEXT.MD) records project decisions, evidence, and remaining gates for maintainers; it is excluded from application bundles and the public homepage.

**Release boundary:** `v0.2.0-preview.1` is an unsigned **private Windows application preview**, not a public production release. The prior `v0.1.0-preview.3` remains immutable. `bun run build:app` creates the application-only ZIP/checksum under `dist/app`, including the required runtime and browser. The separate [homepage repository](https://github.com/anujparwal/Auto-Mate-homepage) and demo film are excluded; this increment develops the actual application only.

---

## What is implemented

- **Agent Workspace Interface**: A clean two-column workspace layout matching the application interface:
  - **Left column**: "Chats between the user and the agent" (`chat-column`) with prompt input, Send, and Stop controls.
  - **Right column (top)**: Live Masked Preview with active origin badge, live status, and off-page Sharp redaction compositing black opaque masks over all controls, iframes, and reflected secrets. Screenshots are strictly host-rendered owner previews and are **never sent to the AI model**.
  - **Right column (bottom)**: "Vault and permissions" with three tabs:
    - **Variables**: vault variable catalog (id, name, description, kind, scope, origin) and "+ Add Variable" modal.
    - **Ongoing Permissions**: quick grant to active site, task-scoped direct-fill grants, and revocation controls.
    - **Notes Space**: live research notes recorded by orchestrator and evaluator subagents with verbatim source quotes.
- **Autonomous ReAct Agent Loop (`AgentEngine`)**: Replaces legacy form-planner scripts with an autonomous ReAct loop returning strict JSON tool calls: `{"tool":"tool_name","args":{...},"status":"..."}`.
  - Tools include `navigate`, `observe`, `scroll`, `click`, `type` (for public search only), `request_information` (for private information filling through host only, never in chat/type), `take_note` (source-linked note with verbatim evidence quote), `spawn_subagents` (cookie-less parallel evaluator workers), and `finish_task`.
  - The old `model-config.json`/`application-planner.ts` form flow and synthetic reviewed-command mode are **historical** and no longer used by the actual app.
- **Encrypted Per-User Workspace Store**: Added `src/workspace-store.ts` and `platforms/windows/workspace.ps1` providing per-user DPAPI-encrypted storage (`CurrentUser`) in desktop mode and AES-256-GCM encrypted workspace storage in hosted mode. Safely persists user model settings, navigation policies, permanent memory, variable groups, and research notes without writing secrets to plaintext.
- **Settings and Model Presets (⚙️ Settings)**:
  - Built-in presets for **OpenAI**, **Groq**, **OpenRouter**, **Ollama**, **LM Studio**, and **Custom** OpenAI-compatible endpoints.
  - Hosted mode strictly enforces cloud HTTPS endpoints (`https://`); local loopback models are forbidden (`LOCAL_MODEL_FORBIDDEN_IN_HOSTED`).
  - Local Desktop mode permits genuine loopback (`localhost`, `127.0.0.1`, `::1`) or cloud HTTPS.
  - When a model endpoint is unreachable or returns invalid responses, errors are visibly displayed to the user (e.g. `PLANNER_UNAVAILABLE`). **No fake fallback or synthetic reviewed-command mode exists in the new app.**
- **Domain Navigation Policies**: Configurable `whitelist` or `blacklist` navigation mode in Settings. Subdomains are covered automatically (e.g. `example.com` covers `*.example.com`). Off-policy navigations fail closed with `NAVIGATION_DENIED`.
- **Opt-in Permanent Memory vs. Evidence Notes**:
  - Permanent memory is opt-in (toggle + editable textarea up to 32 KiB) and persists across tasks.
  - Research notes (up to 100 notes) are captured dynamically during tasks and require verbatim quotes from observed public pages.
- **Data Privacy and Vault Variable Protection**:
  - The model receives only variable metadata (`id`, `name`, `description`, `kind`, `scope`, `available`) with known private values redacted (`[private]`).
  - Secret values and ciphertexts **never reach the model**. The host controller injects approved values directly into browser fields via Playwright.
- **Site-Bound Credentials and Shared Profiles**:
  - Credential variables (`username`, `password`) are strictly site-bound to an exact HTTPS origin.
  - Non-credential variables (`text`, `email`, `tel`, etc.) can be saved as shared profiles reusable across authorized origins.
- **Interactive Missing-Information Dialog**:
  - When an unknown field needs data, a local modal dialog allows the user to enter the value privately, optionally save it as a site-bound or shared variable with name and description, or skip it. Values never pass through chat or model prompts.
- **Task-Scoped Grants & One-Off Permissions**:
  - Sensitive website actions (button clicks, form submissions) and ungranted variable disclosures prompt the user for explicit modal confirmation.
  - Users can pre-grant single variables or entire variable groups (up to 32 variables) to an active origin for the current task (`workspace-grant`), and revoke them at any time (`workspace-revoke` or Stop).
- **Windows Hello Native Reads**:
  - In Local Desktop mode, reading vault secrets for field filling enforces native Windows Hello verification.
- **Safe Stop and Cancellation**:
  - The Stop button or follow-up instructions safely abort the active task controller, close the active browser context, cancel pending dialogs, clear task grants, and reset the live preview.
- **Cookie-less Parallel Evaluator Subagents**:
  - `spawn_subagents` runs parallel, signed-out browser contexts (`research` worker contexts) that evaluate independent candidate URLs without user cookies, credentials, or interaction handles, extracting source-quoted findings.
- **Approval and evidence limits**:
  - Buttons require approval; after a private fill, main-browser navigation and link clicks require approval too. An approved click can complete a real purchase. Model text is not a receipt or proof of success—verify the website confirmation yourself.
- **Dual Operation Modes**:
  - **Local Desktop Mode** (`bun start` / `Auto-Mate.exe`): Uses native Windows Hello and DPAPI v2 for exact-origin credentials, and DPAPI `CurrentUser` encryption for workspace settings and notes.
  - **Hosted Mode** (`bun run host` / `Auto-Mate.exe --hosted`): Operates on the host machine and exposes an HTTPS web interface via Cloudflare QuickTunnel or a custom reverse proxy (`AUTOMATE_HOSTED_PUBLIC_ORIGIN`). Supports multi-account user registration (lowercase username `^[a-z0-9][a-z0-9._-]{2,63}$`, passphrase ≥12 chars; open registration by default, no operator invite code required unless `AUTOMATE_HOSTED_REGISTRATION_KEY` is configured). Encrypted with memory-hard scrypt ($N=32768, r=8, p=1$) and AES-256-GCM. 5-second disconnect/background protection closes protected websites and revokes authority. 500 ms JSON polling synchronization (`GET /api/updates?after=sequence`; no SSE).
- **Public-Only DNS-Pinned Egress Forward Proxy**: Restricts host browser traffic to port 443 HTTPS and rejects loopback, private networks (RFC 1918), Carrier-Grade NAT (RFC 6598), IPv6 ULA/link-local, and cloud metadata endpoints (`169.254.169.254`).

---

## Known Privacy and Operational Limits

1. **Host Operator Trust:** The host machine executes the browser and holds active decryption keys in process memory during an authenticated session. The host operator and any process with administrative access to the host machine can access active plaintext values in memory. Hosted mode is **not zero-knowledge**. Local desktop Windows Hello/DPAPI mode remains separate with its own local device-bound trust model.
2. **Best-Effort Redaction Against Malicious Sites:** Known vault values are redacted host-side in signed-in DOM observations and URLs (`[private]`). However, privacy is best effort against adversarial websites that transform, split, or encode disclosed values (e.g., across separate DOM nodes, Base64, rot13) to evade substring matching.
3. **No Screenshots Sent to AI Models:** Live preview frames use Sharp off-page redaction and black masking for owner viewing only. Screenshots are **never** provided as model inputs.
4. **Manual Chat and Permanent Memory Disclosure:** Any text typed directly into the chat prompt or saved in enabled permanent memory is sent to the configured AI model provider. Users must keep secrets out of chat and memory.
5. **Persistent Storage and Backup Requirements:** Hosted mode stores accounts and workspaces on disk (`%LOCALAPPDATA%\AutoMate\hosted\` or `/data`). Operators must ensure persistent disk mounts and regular backups; recreating a container without persistent volumes causes total data loss.
6. **Cloud / HTTPS Security Review:** Production hosting requires an owned domain and reviewed TLS reverse proxy (`AUTOMATE_HOSTED_PUBLIC_ORIGIN` and `AUTOMATE_HOSTED_PORT`). Cloudflare QuickTunnel is for temporary testing only (no SLA, URLs change on restart, rate limits).

---

## Run on Windows 11

From this directory, run the reviewed setup script (Windows 11 x64; installs missing Bun from a pinned, digest-verified official release, locked dependencies, and Chromium):

```powershell
powershell.exe -NoProfile -File .\tools\setup-windows.ps1
bun test
bun run typecheck
bun run smoke
```

`smoke` launches headless Chromium against an intercepted HTTPS test origin. It persists test records using an isolated synthetic DPAPI namespace, exercises form actions, checks bounded completion results and durable audit files, then cleans up temporary fixtures.

Native vault usage is documented in `platforms/windows/README.md`. Android build and device instructions are in `platforms/android/README.md`.

---

## Using the Agent Workspace

```powershell
bun start
```

### 1. Workspace Layout
- **Left Column**: Type instructions for the agent (e.g., *"Go to wikipedia.org and research renewable energy"* or *"Log in to the test portal"*). Click **Send** to start execution, or **Stop** to safely cancel at any time.
- **Right Column (Top)**: Observe real-time masked browser actions in the **Live Preview** pane. All form controls and iframes are masked with opaque black rectangles.
- **Right Column (Bottom)**: Manage the workspace across three tabs:
  - **Variables**: Inspect saved variables, their metadata (names, descriptions, scopes, origins), and add new variables via **+ Add Variable**.
  - **Ongoing Permissions**: Review active task-scoped grants, quick-grant variables or variable groups to the active website origin, and revoke grants.
  - **Notes Space**: Read research notes captured during tasks, complete with source URLs and verbatim evidence quotes.

### 2. Configure Settings (⚙️ Settings)
Click the **⚙️ Settings** button in the header:
1. **Model Settings**:
   - Choose a preset: **OpenAI**, **Groq**, **OpenRouter**, **Ollama**, **LM Studio**, or **Custom**.
   - Review or edit the chat completions endpoint and exact model ID.
   - Enter your API key if required by your provider.
   - In Hosted Mode, endpoints must be cloud HTTPS (`https://`). In Local Desktop Mode, local loopback endpoints (`http://127.0.0.1:11434`, etc.) are permitted.
2. **Navigation Policy**:
   - Select **Whitelist** (only allowed domains can be visited) or **Blacklist** (blocked domains cannot be visited).
   - Enter domain names (e.g., `example.com`). Subdomains are covered automatically (`*.example.com`).
3. **Permanent Memory**:
   - Toggle **Enable permanent memory** on or off.
   - Enter persistent memory notes (up to 32 KiB) that the agent should keep in mind across tasks.
4. **Variable Groups**:
   - Create named groups (e.g., *"Work Credentials"*, *"Shopping Profile"*) containing up to 32 variable names each.
   - Use these groups for rapid task-scoped grants in the **Ongoing Permissions** tab.

---

## Concrete Manual Testing Checklist

Run these manual checks using **fictitious data and public test forms only**. Do not use real credentials or financial data.

| Check | Steps | Expected Result |
| :--- | :--- | :--- |
| **1. UI Layout & Initial State** | Run `bun start`. Inspect the opened Chromium window. | Clean two-column workspace. Left column displays chat with intro greeting; right column displays empty preview shell and Vault & Permissions tabs. No errors in banner. |
| **2. Model Error Visibility** | Open **⚙️ Settings**, select **Custom**, enter an offline endpoint `http://127.0.0.1:9999/v1/chat/completions`, model `test-model`, and save. Type `"Hello"` in chat and click Send. | The agent attempts the connection and displays a visible error banner: *"The selected model could not be reached. Check its endpoint, model name and API key. No provider fallback was used."* No fake fallback or command mode is triggered. |
| **3. Navigation Policy (Whitelist / Blacklist)** | In **⚙️ Settings**, set navigation to **Whitelist**, add `wikipedia.org`, and save. In chat, prompt `"Go to google.com"`. | The agent attempts navigation, but the forward proxy and navigation policy block the request. The UI reports navigation blocked by policy (`NAVIGATION_DENIED`). |
| **4. Public Research & Notes Space** | Configure a valid model in Settings. In chat, type `"Research Python programming language on wikipedia.org and take notes on its release year and creator."` | The agent navigates to Wikipedia, streams masked preview frames, extracts findings with verbatim evidence quotes, and records them in the **Notes Space** tab. Evaluator subagents verify facts independently. |
| **5. Missing-Information Dialog** | Navigate to a public test login form (e.g., `https://the-internet.herokuapp.com/login`). Instruct the agent to log in. | The agent inspects the form and invokes `request_information` for the unvaulted fields. A modal dialog opens sequentially prompting for the missing value. The user enters a fictitious value, optionally saves it as site-bound with a description, or skips it. Values are filled directly by the host into the form and **never appear in the chat stream or model prompts**. |
| **6. Variable Pre-Grants & Revocation** | Add a variable in the **Variables** tab for `https://the-internet.herokuapp.com`. In **Ongoing Permissions**, grant the variable to the active site. Re-run the login task. | The agent fills the pre-granted variable directly without interrupting for a one-off confirmation modal. Click **Revoke** next to the grant; subsequent attempts prompt for modal approval. |
| **7. Safe Stop & Cancellation** | Start a multi-step research prompt. While the agent status badge is `Running` and the browser is active, click the red **Stop** button. | The active task aborts immediately (`TASK_STOPPED`). The active Playwright browser closes, pending dialogs cancel, task-scoped grants clear, the status returns to `Stopped`, and the live preview resets to idle. |
| **8. Button Click Modal Confirmation** | Instruct the agent to click a website button (e.g. Login or Submit). | A dedicated confirmation modal appears with the button label and origin warning: *"This click can submit, purchase, delete, or disclose data."* Clicking Deny stops the click; clicking Approve allows the host to click the button. The agent never clicks buttons autonomously. |
| **9. Windows Hello Native Verification (Desktop Mode)** | In desktop mode, save an encrypted credential in the vault. Instruct the agent to fill that credential. | Windows Hello triggers OS verification. Completing Hello allows the host to read and fill the field; cancelling Hello aborts the operation without disclosing data. |

---

## Verification Status and Gates

Current verification: **0.2.0-preview.1 preview scope; not production certification**.

- Typecheck and the complete 300-test suite passed; the subsequently added encoded-value cutoff regression was reproduced failing, fixed, and passed separately.
- Actual desktop UI exercised with a labelled OpenAI-compatible protocol fixture: private missing-field input, preserved drafts, group grant, separate Login approval, two parallel evaluators, source notes, and masked preview. Eight HTTP model-protocol requests contained neither supplied credential value. This is not live LLM inference.
- Desktop chat remained inside the 1000px viewport after streaming; mobile layout fit 390px without horizontal overflow. Stop closed the completed task's real browser and cleared the preview.
- Synthetic Windows DPAPI/browser execution and encrypted native/hosted workspace-store tests passed. Extracted-package smoke exercises bundled runtime without global Bun/Node.
- Linux container execution is unverified here; see [container prerequisites](docs/hosting.md#container-deployment-boundary).
- Windows Hello OS availability previously reported `DeviceNotPresent` on development hardware; positive biometric/PIN verification remains hardware-unverified.
- End-to-end verification against the user-supplied model API remains pending availability of an active endpoint (legacy ngrok endpoint returned `ERR_NGROK_3200`).
- Android UI, biometric prompts, and browser automation remain deferred by the Windows-first design; host tests exercise cryptographic envelopes only.
- Do not claim production readiness, universal secret redaction, or absolute privacy before independent security review.
