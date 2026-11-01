# Hosted Mode Architecture and Operator Guide

Auto-Mate supports a dedicated **Hosted Mode** alongside its local desktop workflow. In hosted mode, the browser automation engine and encrypted user vaults run on an operator's Windows host machine, while remote users interact securely through an invite-only HTTPS web interface from any desktop or mobile browser.

This document describes the hosted architecture, operator workflow, cryptographic storage model, session management, network security controls, and trust boundaries.

---

## 1. Architecture Overview

```
+-------------------------------------------------------------+
| Remote User Browser (Desktop / Mobile)                      |
| - Live masked observation (right-side desktop, stacked mobile)|
| - Interactive missing-information dialogs                   |
| - Explicit disclosure checkboxes (start unchecked)          |
| - Dedicated confirmation modal for website button clicks    |
+------------------------------+------------------------------+
                               |
                   HTTPS (Port 443) / Polling
                               |
+------------------------------v------------------------------+
| Cloudflare QuickTunnel / Custom TLS Reverse Proxy           |
| (Pinned cloudflared helper or AUTOMATE_HOSTED_PUBLIC_ORIGIN)|
+------------------------------+------------------------------+
                               |
                      127.0.0.1 (Local Port)
                               |
+------------------------------v------------------------------+
| Host Windows 11 PC (Auto-Mate Server & Executor)             |
| - Host laptop browser (target website sees host IP)         |
| - Isolated per-account encrypted vaults (AES-256-GCM+scrypt) |
| - Strict DNS-pinned egress proxy (public HTTPS 443 only)     |
| - AI planner integration (metadata only; no secrets)        |
+-------------------------------------------------------------+
```

### Key Distinctions: Local Mode vs. Hosted Mode

| Dimension | Local Desktop Mode (`bun start` / `Auto-Mate.exe`) | Hosted Mode (`bun run host` / `Auto-Mate.exe --hosted`) |
| :--- | :--- | :--- |
| **User Interface** | Local Chromium window launched on the desktop | HTTPS web interface accessed remotely via browser (right-side preview on desktop, stacked on mobile) |
| **Authentication** | Native Windows Hello (biometrics / PIN) via DPAPI | Username (lowercase) + passphrase (≥12 chars) via scrypt / AES-GCM (invite key ≥16 chars) |
| **Browser Execution** | Local desktop Chromium | Headless/managed Chromium on the host laptop |
| **Network Presence** | Local machine IP | Host machine IP (target websites see host IP) |
| **Trust Model** | Local DPAPI v2 protected by Windows Hello | Hosted scrypt + AES-GCM; host operator can access active process memory (not zero-knowledge) |
| **Button Clicks** | Real-site autofill is fill-only (never clicks submit) | Fill + separate explicit modal approval for button clicks |
| **Registration** | Single local Windows user profile | Invite-only multi-account registration with invite key (≥16 chars) |

---

## 2. Operator Guide

### Running Hosted Mode

From the extracted portable package:
```powershell
.\Auto-Mate.exe --hosted
```

Or from repository source (requires Bun 1.4.4+):
```powershell
bun run host
```

> **Important Operator Rules:**
> 1. **Keep the host laptop and terminal awake.** Sleep, suspension, or closing the laptop lid interrupts network tunnels and user sessions, pausing execution (suspension interrupts the server rather than necessarily terminating it immediately, but active tunnel connections and client heartbeats will drop).
> 2. **Share credentials privately.** The console displays a public HTTPS URL and a registration invite code (minimum 16 characters). Share these over an authenticated, private channel only with authorized users.
> 3. **No Windows Firewall modifications needed.** Cloudflare QuickTunnel establishes an outbound tunnel to Cloudflare edge nodes; no inbound port forwarding or firewall rule widening is required.
> 4. **No local GPU or model setup needed.** The host runs the automation engine and communicates with the configured external OpenAI-compatible API.

### Configuration Environment Variables

Hosted mode accepts no command-line arguments beyond `--hosted`. Configuration is handled entirely via environment variables:

| Environment Variable | Default | Purpose |
| :--- | :--- | :--- |
| `AUTOMATE_HOSTED_PUBLIC_ORIGIN` | *(unset)* | When set (e.g. `https://automate.example.com`), uses this HTTPS reverse-proxy origin and disables QuickTunnel. When unset, starts an ephemeral Cloudflare QuickTunnel. |
| `AUTOMATE_HOSTED_PORT` | `0` (ephemeral) | Local HTTP listening port on `127.0.0.1`. When using an existing reverse proxy, set this to your proxy's target backend port. |
| `AUTOMATE_HOSTED_DATA_DIR` | `%LOCALAPPDATA%\AutoMate\hosted` | Directory for account metadata, encrypted user vaults, and audit journals. |
| `AUTOMATE_HOSTED_REGISTRATION_KEY` | *(generated)* | Operator registration invite code (minimum 16 characters). If unset, a cryptographically strong 32-character base64url key is generated and printed once to the console. |

### Pinned Cloudflare Tunnel Helper

When `AUTOMATE_HOSTED_PUBLIC_ORIGIN` is unset, Auto-Mate manages an ephemeral Cloudflare QuickTunnel:
- Official binary: `cloudflared-windows-amd64.exe` (release `2026.10.7`).
- Cryptographic SHA-256 fingerprint: `2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343` (file size: 55,390,512 bytes).
- Download cache: Verified and cached in `%LOCALAPPDATA%\AutoMate\tools\cloudflared-2026.10.7-amd64.exe`.
- Corrupt or mismatched binaries fail closed and are rejected.

---

## 3. Account Security and Cryptography

Hosted mode replaces Windows Hello with strong, multi-tenant per-account cryptographic isolation:

### Registration and Authentication
1. **Invite-Only Registration:** New users must supply the operator's registration invite key (minimum 16 characters). Registration is rejected with HTTP 403 (`INVALID_REGISTRATION_KEY`) if the key is invalid, or HTTP 429 if the server has reached its capacity (maximum 100 registered accounts).
2. **User Identity:** Usernames must be strictly lowercase ASCII, 3–64 characters, starting with a lowercase alphanumeric character and followed by lowercase alphanumeric characters, dots, underscores, or hyphens (`/^[a-z0-9][a-z0-9._-]{2,63}$/`). No case-folding or normalization is performed; lowercase is strictly required.
3. **Passphrase Policy:** Passphrases/keys must be at least 12 characters (up to 1,024 characters). Passphrases are never trimmed or silently modified.
### Key Derivation and Storage
- **Memory-Hard KDF:** Derived using `scrypt` with parameters:
  - $N = 32,768$ (CPU/memory cost)
  - $r = 8$ (block size)
  - $p = 1$ (parallelization)
  - `maxmem` = 64 MiB
- **Domain-Separated Subkeys:** The master scrypt output generates two independent 32-byte subkeys via HMAC-SHA256:
  - `authSubkey`: Computes the constant-time authentication verifier. The plaintext passphrase is never stored.
  - `encSubkey`: Directly encrypts and decrypts the account's vault file using AES-256-GCM.
- **Vault File Encryption:** Each user's vault is stored as an independent file (`<accountId>.vault`) encrypted with AES-256-GCM (12-byte random nonce, 16-byte authentication tag). Vault writes are atomic (`.tmp` write followed by rename).
- **Key Zeroization:** When an account session closes upon explicit logout or fixed 1-hour expiry, the in-memory `encSubkey` buffer is explicitly wiped using `.fill(0)`. On disconnect (>5s), the protected website is closed and authority is revoked, but the account key remains active in memory until logout or expiry.
- **Host Operator Plaintext Access:** The host machine executes the Chromium browser and holds active decryption keys in process memory during an authenticated session. The host operator and any process with administrative access to the host machine can access active plaintext values in memory. Hosted mode is **not zero-knowledge**.
- **No Password Recovery:** Because the host stores no plaintext passwords or master recovery keys, **lost passphrases cannot be recovered**.
---

## 4. Session Lifecycle and Concurrency

- **Active Session Capacity:** Default maximum of **4 concurrent active sessions** across all accounts on the host server.
- **Single Active Session Per Account:** Signing in from a new browser or device immediately revokes and closes any existing active session for that account.
- **Fixed Login Expiry:** Sessions enforce a fixed **1 hour authentication expiry from sign-in** (`sessionTtlMs = 3,600,000`). It is **not** an inactivity timeout; user activity and polling do not extend this fixed deadline.
- **Disconnect Grace Period (>5s):** If the remote client loses connection, closes the tab, or backgrounds the browser for more than **5 seconds** (`disconnectGraceMs = 5000`):
  - Active website browser automation is stopped (`action: 'stop'`).
  - Active website authority is revoked, the protected website closes, and field approvals and one-off entries are cleared.
  - The account key stays in memory until explicit logout or fixed 1-hour expiry.
  - Resuming or reconnecting receives a fresh idle state and never resurrects old authority. Re-inspecting starts a fresh workflow.
- **Polling Synchronization:** State and live preview frames are synchronized using authenticated regular JSON polling (`GET /api/updates?after=sequence` every 500 ms). Server-Sent Events (SSE) were removed because Cloudflare QuickTunnel drops SSE stream bodies; Auto-Mate does not promise or require SSE support.
- **Protected-page model boundary:** The metadata-only model API requires explicit user consent. External model observation is allowed only during a fresh, isolated inspection. After a fill or approved website button click, external/model observation is blocked because the receiving page may echo previously disclosed secrets. Users can explicitly select **Map locally / ask me · No API** for subsequent fields; there is no automatic fallback.
- **Explicit Sign Out:** Sign-out revokes the token immediately, closes the browser and drains already-started operations, then wipes the binary encryption-key buffer (`.fill(0)`). JavaScript strings cannot promise zeroization; already-started writes and disclosures cannot be rolled back.

---

## 5. Remote User Interface and Approval Controls

### Live Observation (Desktop Right-Side / Mobile Stacked)
Remote users observe the automation session through the preview pane (positioned on the right side on desktop and stacked vertically on mobile screens). The preview displays masked images of the website rendered on the host laptop. Users cannot click or type directly inside the preview image; all interactions occur through application-controlled UI components.
### Form Field Disclosure
- All detected form field checkboxes start **unchecked**.
- The remote user explicitly checks each field they permit Auto-Mate to fill.
- Clicking **Approve selected fields & fill** displays a final confirmation modal detailing the exact origin and field names before filling begins.

### Interactive Missing-Information Dialog
When the AI planner or form inspector detects fields that have no matching information in the vault:
1. A sequential modal dialog box appears asking for the missing field value.
2. The user enters the value in their remote browser. The value is sent over HTTPS directly to the host's encrypted memory.
3. The user can optionally check **Save this to vault for future use**:
   - **Shared profile:** For non-credential variables (such as full name, phone number, address) that may be reused across websites.
   - **Site-bound:** Mandatory for credentials (usernames and passwords) and origin-specific variables. Credentials can never be saved as shared profiles.
4. The user may click **Skip this field** (leaving it unfilled) or press **Escape / Cancel** (which revokes authority and stops the workflow).
5. **Secret values and ciphertexts are never sent to the AI model.**

### Explicit Modal Approval for Website Button Clicks
Unlike local autofill (which is strictly fill-only), hosted mode allows users to trigger website actions such as Login, Next, Pay, or Submit buttons:
1. Supported, uniquely labelled buttons are discovered and listed in the **Website actions** card.
2. The user clicks **Request click: [Button Name]**.
3. A modal confirmation dialog opens with an explicit warning:
   > *"Allow this website button click? Website: [Origin] Button: “[Label]” This may submit data, navigate, purchase, or delete. Unfilled entries and previous field approvals will be cleared. No replacement button will be clicked."*
4. The user must click **Approve** or **Deny**.
5. **No website buttons are ever clicked autonomously by the AI model.**

---

## 6. Network Isolation and Egress Filtering

The host browser operates behind a strict, DNS-pinned forward proxy (`src/hosted-egress.ts`):

- **Public HTTPS Only:** Only outbound connections to port 443 over TLS are permitted.
- **Forbidden IP Ranges:** The proxy resolves destination hostnames and rejects:
  - Loopback (`127.0.0.0/8`, `::1`)
  - Private networks (RFC 1918: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
  - Carrier-Grade NAT (RFC 6598: `100.64.0.0/10`)
  - Link-local and cloud metadata endpoints (`169.254.0.0/16`, including AWS/GCP/Azure metadata `169.254.169.254`)
  - IPv6 Unique Local (`fc00::/7`) and Link-Local (`fe80::/10`) addresses
  - Special and reserved TLDs (`.local`, `.localhost`, `.internal`, `.lan`, `.corp`, etc.)
- **Isolation Boundaries:**
  - Off-origin resources and third-party trackers are blocked.
  - Embedded iframes, popups, downloads, and service workers are disabled or closed.
  - Multi-step SSO redirections, CAPTCHAs, and multi-factor authentication (MFA) prompts are not supported.

---

## 7. Threat Model and Trust Boundaries

1. **Host Operator Trust:**
   - The host machine executes the Chromium browser and stores active decryption keys in process memory during an authenticated session.
   - The host operator and anyone with administrative access to the host machine can access active plaintext values in memory.
   - Hosted mode is **not zero-knowledge**. While scrypt and AES-256-GCM protect vault data at rest against cold disk theft, they do not protect against an adversarial or compromised host operator.
   - Local desktop Windows Hello/DPAPI mode remains separate with its own device-bound trust model.
2. **Supplied Model API Limitations:**
   - The external model API receives metadata only (field descriptors and variable catalogs, never secrets or values) and requires explicit user consent.
   - After a fill or approved website button click, external model observation is blocked because the receiving page may echo disclosed values into labels/DOM; the user can explicitly select "Map locally / ask me · No API", with no automatic fallback.
   - The preconfigured endpoint in `model-config.json` previously passed real metadata-only probes, but currently returns 404 ERR_NGROK_3200 (tunnel offline / not found). Model weights identity is unverified (POST `/v1/chat/completions` only; no `/models` endpoint). No Qwen or Colab setup is provided or required.
3. **Reverse Proxy Trust:**
   - In QuickTunnel mode, Cloudflare terminates TLS at its edge before forwarding traffic to the local host tunnel. In custom reverse proxy mode, your TLS termination point handles decryption.
   - Do not use untrusted proxy infrastructure for sensitive credentials.
3. **Target Website Visibility:**
   - The target website observes traffic originating from the **host laptop's IP address**, not the remote user's device IP.
   - Disclosing credentials to a website allows that website's scripts to receive them; Stop cannot recall data already sent across the network.
4. **Temporary Nature of QuickTunnel:**
   - Cloudflare QuickTunnel (`*.trycloudflare.com`) is intended for development and evaluation only. It provides no uptime SLA, assigns a new random URL on every launch, enforces connection rate limits, and does not support HTTP SSE.
   - Production deployments must configure `AUTOMATE_HOSTED_PUBLIC_ORIGIN` and `AUTOMATE_HOSTED_PORT` with a stable, owned domain and production reverse proxy.
