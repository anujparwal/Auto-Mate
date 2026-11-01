# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

This record scopes the owner-only Windows browser-preview surface. Auto-Mate as a product targets Windows and Android; the user explicitly selected Windows preview first. Android preview is deferred, not represented as implemented.

## Users

The local machine owner supervising credential-bearing browser tasks (Local Desktop Mode), or authorized remote users accessing an operator-hosted instance via an HTTPS connection (Hosted Mode).

## Product Purpose

Provide a safe, transparent browser agent workspace: show live masked execution progress, allow users to chat with the agent, inspect and manage vault variables, approve website disclosures and actions, and keep secrets and owner preview pixels strictly isolated from AI models.

## Operating Context

Existing Bun/TypeScript broker and Playwright executor on Windows 11 x64.

Auto-Mate operates in two distinct modes:
1. **Local Desktop Mode** (`bun start` / `Auto-Mate.exe`): Runs the Agent Workspace locally in Chromium on Windows 11. Uses native Windows Hello and DPAPI v2 for vault variable reads, and DPAPI `CurrentUser` encryption for user workspace settings, permanent memory, groups, and research notes (`src/workspace-store.ts`). Permitted model endpoints include local loopback (`localhost`, `127.0.0.1`, `::1`) or cloud HTTPS.
2. **Hosted Mode** (`bun run host` / `Auto-Mate.exe --hosted`): Runs on an operator's Windows host machine and exposes an HTTPS web interface via Cloudflare QuickTunnel or a custom reverse proxy (`AUTOMATE_HOSTED_PUBLIC_ORIGIN`). Supports multi-account user registration (lowercase username `^[a-z0-9][a-z0-9._-]{2,63}$`, passphrase ≥12 chars; open registration by default, optional invite key ≥16 chars if configured) protected by memory-hard scrypt ($N=32768, r=8, p=1$) and AES-256-GCM encrypted vaults, up to 4 concurrent active sessions (1 per account), fixed 1-hour auth expiry from sign-in (not inactivity), 5-second disconnect/background protection (closes protected website and clears approvals/one-offs; account key stays until logout/expiry; resuming gets fresh state), and 500 ms JSON polling synchronization (`GET /api/updates?after=sequence`; no SSE). Permitted model endpoints are restricted strictly to cloud HTTPS; local loopback is forbidden.

The application target is `v0.2.0-preview.1`, an unsigned private Windows preview with native launcher and bundled runtime/browser. The immutable `v0.1.0-preview.3` release is retained. Homepage/demo assets remain outside the application release and outside this increment's development.

`AgentEngine` uses a user-configured OpenAI-compatible API via Settings. The obsolete `model-config.json` and application-planner adapter have been removed; historical records describe the prior flow. Hosted models use public HTTPS; desktop also permits loopback. The selected model receives goals, chat context, enabled memory, source notes, variable metadata and redacted page text. Host vault reads, cookies, internal handles and preview images are not model tools. A hostile page may transform private values to evade redaction; this is not a universal confidentiality guarantee. Model errors remain visible without fake fallback.

## Capabilities and Constraints

- **Agent Workspace Layout**: Two-column layout matching the application interface:
  - **Left column**: "Chats between the user and the agent" (`chat-column`) with prompt input, Send, and Stop controls.
  - **Right column (top)**: Live Masked Preview of the browser with active origin badge, live status, and off-page Sharp redaction compositing black opaque masks over all controls, iframes, and reflected secrets. Screenshots are strictly host-rendered owner previews and are **never sent to the AI model**.
  - **Right column (bottom)**: "Vault and permissions" with three tabs:
    - **Variables**: vault variable catalog (id, name, description, kind, scope, origin) and "+ Add Variable" modal.
    - **Ongoing Permissions**: quick grant to active site, task-scoped direct-fill grants, and revocation controls.
    - **Notes Space**: live research notes recorded by orchestrator and evaluator subagents with verbatim source quotes.
- **ReAct Tool Loop**: The agent operates through strict JSON tool calls: `navigate`, `observe`, `scroll`, `click`, `type` (for public search only), `request_information` (for private information filling through the host), `take_note` (source-linked note with verbatim evidence quote), `spawn_subagents` (cookie-less parallel evaluator workers), and `finish_task`.
- **Permissions & Variable Grants**: Sensitive website actions (button clicks, form submissions) and ungranted variable disclosures require explicit modal confirmation. Users can pre-grant single variables or entire variable groups (up to 32 variables) to an active origin for the current task (`workspace-grant`), and revoke them at any time (`workspace-revoke` or Stop).
- **Site-Bound Credentials and Shared Profiles**: Credential variables (`username`, `password`) are strictly site-bound to an exact HTTPS origin. Non-credential variables (`text`, `email`, `tel`, etc.) can be saved as shared profiles reusable across authorized origins.
- **Interactive Missing-Information Dialog**: When an unknown field needs data, a local modal dialog allows the user to enter the value privately, optionally save it as a site-bound or shared variable with name and description, or skip it. Values never pass through chat or model prompts.
- **Windows Hello Native Reads**: In Local Desktop mode, reading vault secrets for field filling enforces native Windows Hello verification.
- **Safe Stop and Cancellation**: The Stop button or follow-up instructions safely abort the active task controller, close the active browser, cancel pending dialogs, clear task grants, and reset preview.
- **Cookie-less Parallel Evaluator Subagents**: `spawn_subagents` runs parallel, signed-out browser contexts (`research` worker contexts) that evaluate independent candidate URLs without user cookies, credentials, or interaction handles, extracting source-quoted findings.
- **Approval and proof limits**: Buttons require confirmation; after a private fill, main-browser navigation and links require it too. Approved actions can complete real purchases. Model statements are not proof of success; users must inspect confirmations and receipts.
- **Public-Only DNS-Pinned Egress Proxy**: Browser network destinations must be public HTTPS on port 443. Main/research navigation obeys website policy, including redirects; third-party public resources may still load. Downloads, popups, WebSockets and service workers are blocked. Website policy is not a full data-loss-prevention boundary.
- **Hosted Mode Trust Boundary**: The host operator and TLS reverse proxy termination point have access to active process memory and plaintext values. Hosted mode is not zero-knowledge. Cloudflare QuickTunnel is temporary testing only (no SLA, URLs change on restart, connection limits, polling not SSE); production requires stable reverse proxy configuration (`AUTOMATE_HOSTED_PUBLIC_ORIGIN`). Local Windows Hello/DPAPI trust remains separate.
- **Best-Effort Redaction**: Known vault values are redacted host-side in signed-in DOM observations and URLs (`[private]`). Privacy is best effort against transformed or encoded malicious-site secrets (e.g. splitting across DOM nodes, base64, rot13).

## Evidence on Hand

The actual owner UI filled The Internet's public HTTPS login using published credentials and Autofill.me's public HTTPS card form using fictitious data, with explicit field approval, no application POST, unchanged CVV, private audit bytes, and no 390 px horizontal overflow. These browser checks used an explicitly isolated in-memory public-data fixture; actual encrypted typed-record/Unicode roundtrips were verified separately in isolated native DPAPI `.test` vaults. The default normal-vault UI showed unavailable-Hello refusal with fields untouched; positive normal-vault-to-site filling remains unverified. The native session monitor started and closed fail-closed; real lock/disconnect and secure-desktop authentication behavior remain unverified. Existing synthetic registration, planning protocol, cancellation, audit/history, and Android host/build evidence remains documented in README.md. No real customer account, card, or payment was used.

The independent Vault UI additionally saved login/card fixtures through actual DPAPI before browser creation, listed identities without values, and retrieved the login only after explicit username approval, leaving the password untouched. Delayed listing could not repopulate a locked Vault. Four unchanged frames preserved image/annotation nodes, draft focus/selection, scroll, and geometry; a late old decode could not replace a newer inspection. Four public-login captures produced no DOM mask/style mutations. Desktop columns and the 390 px stacked layout were inspected. This used isolated fictitious `.test` data, not positive Windows Hello. Current full suite/typecheck completed exit0, pending final verification for `v0.2.0-preview.1`.

## Product Principles

- Authorization stays outside the model.
- Unsupported or changed evidence fails closed before credential use.
- The observer must not create an alternate AI observation path.
- Demonstrations and limitations are labelled honestly.
