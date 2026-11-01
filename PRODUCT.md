# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

This record scopes the owner-only Windows browser-preview surface. Auto-Mate as a product targets Windows and Android; the user explicitly selected Windows preview first. Android preview is deferred, not represented as implemented.

## Users

The local machine owner supervising credential-bearing browser tasks (Local Desktop Mode), or authorized remote users accessing an operator-hosted instance via an invite-only HTTPS connection (Hosted Mode).

## Product Purpose

Show what the executor is doing, which webpage text requests which field, and what configured credential category is involved. The AI must not receive secrets or the owner preview.

## Operating Context

Existing Bun/TypeScript broker and Playwright executor on Windows 11 x64.

Auto-Mate operates in two distinct modes:
1. **Local Desktop Mode** (`bun start` / `Auto-Mate.exe`): Uses native Windows Hello and DPAPI v2 for exact-origin Login and Payment card records in a local Chromium browser. The autofill workflow is strictly fill-only; it never clicks Login, Pay, or Submit.
2. **Hosted Mode** (`bun run host` / `Auto-Mate.exe --hosted`): Runs on an operator's Windows host machine and exposes an invite-only HTTPS web interface via Cloudflare QuickTunnel or a custom reverse proxy (`AUTOMATE_HOSTED_PUBLIC_ORIGIN`). Supports multi-account user registration (invite key ≥16 chars, lowercase username `^[a-z0-9][a-z0-9._-]{2,63}$`, passphrase ≥12 chars) protected by memory-hard scrypt ($N=32768, r=8, p=1$) and AES-256-GCM encrypted vaults, up to 4 concurrent active sessions (1 per account), fixed 1-hour auth expiry from sign-in (not inactivity), 5-second disconnect/background protection (closes protected website and clears approvals/one-offs; account key stays until logout/expiry; resuming gets fresh state), and 500 ms JSON polling synchronization (`GET /api/updates?after=sequence`; no SSE). Remote users observe masked frames in a live right pane on desktop (stacked layout on mobile), approve field disclosures, and explicitly approve website button clicks (Login, Submit, Next, Pay) via a dedicated modal confirmation popup. Host operator can access active plaintext values in process memory (not zero-knowledge).

The application release `v0.1.0-preview.3` is an unsigned **private Windows preview**, with a native launcher, bundled runtime/browser dependencies, and application-only ZIP/checksum. The separate public `Auto-Mate-homepage` repository contains the marketing homepage and non-interactive simulated product film; no homepage or demo film is shipped in the application release.

Model planning uses a user-configured OpenAI-compatible API configured in `model-config.json` (`https://nullify-geometric-decathlon.ngrok-free.dev/v1/chat/completions`, model `qwen3.5-9b`). The server exposes `POST /v1/chat/completions` only and provides no `/models` endpoint; model identity is unverified (do not claim 9B weights verified). Real metadata-only probes previously passed, but the exact provided endpoint currently returns HTTP 404 (`ERR_NGROK_3200`: ngrok tunnel offline / endpoint not found). No Qwen or Colab setup is provided or required. External model planning requires explicit user consent and receives metadata only (public field descriptors and variable catalog, never values or ciphertexts). After a fill or approved website click, external model observation is blocked because the page may echo disclosed values; users can explicitly select "Map locally / ask me · No API", with no automatic fallback. The model returns a strict flat JSON map `{ [fieldId: string]: string | null }`; extra or missing keys fail closed.
## Capabilities and Constraints

- Real-site inspection opens a fresh exact-origin HTTPS browser without vault access. Individual field checkboxes start unchecked; only approved fields can read/use the selected origin-bound record. Model planning is used only for synthetic workflow routing and agent-assisted field-to-variable metadata mapping, receiving neither secret values nor direct vault/browser authority.
- Mode-specific button actions: In local desktop autofill, the application **never clicks Login, Pay, or Submit**. In hosted mode, users can request website button clicks (Login, Submit, Next, Pay), but **each click requires explicit manual approval via a dedicated modal confirmation popup**. The AI model never clicks buttons or submits forms autonomously.
- A separate owner-only Vault column adds exact-origin login/card records and lists authenticated record identities before any website inspection. Saving/listing does not approve disclosure; Lock clears owner drafts/metadata and stops execution without deleting records. Neither plaintext nor ciphertext export is exposed to models.
- Deterministic code validates text-to-field relationships and draws paired, numbered highlights.
- Live capture applies opaque masks off-page without injecting screenshot styles or pausing website animations. The real-site renderer preserves unchanged frames, layout, and owner form focus; inspection revisions and decode cancellation prevent stale scenes after Stop or replacement.
- Yellow, Orange, and Red are user-requested credential secrecy categories. Trusted configuration assigns them; registration rejects labels that disagree with the broker catalog, and credential use requires explicit category-scoped authorization. Category editing/persistence UI and Android category policy remain unimplemented.
- Local real-site record list/save/read operations require successful Windows Hello, independently of field approval. The owner selects a 1/5/15-minute lifetime; the filled browser stays protected until stop, expiry, evidence/page change, or closure.
- Hosted mode replaces Windows Hello with username and strong passphrase (≥12 chars) authentication, deriving domain-separated HMAC subkeys via memory-hard scrypt ($N=32768, r=8, p=1$). In-memory decryption keys are zeroed upon explicit logout or fixed 1-hour expiry. Disconnect closes the website and clears approvals/one-offs, but the account key stays until logout/expiry; reconnecting gets fresh state and never resurrects old authority.
- Broker authorization events persist with opaque session/task tokens and no raw account identities; an audit write failure prevents further credential use. The read-only historical viewer supports paginated sessions/events, incomplete-tail warnings, strict corruption refusal, and explicit live refresh without granting execution authority. OS notifications remain unimplemented.
- Active expiry/revocation promptly request browser closure. The real-site window additionally monitors WTS session transitions, active/input desktop availability, and channel freshness. Native operations already started may finish after cancellation. Positive authentication and actual OS lock/disconnect interactions remain hardware-unverified.
- Card storage/filling supports cardholder, number, and expiry only; CVV/CVC, PINs, OTPs, bank-account fields, and unrelated controls are excluded. Embedded/cross-origin payment forms and unsupported/ambiguous fields fail closed, not through an authentication or evidence bypass.
- Association evidence is DOM structure, not proof that a website is trustworthy or its request is legitimate.
- Owner-only frames are not a model-safe redaction channel. Never expose them to AI tools.
- Show explicit execution states and unverified associations; never use color as the only explanation.
- Public-only DNS-pinned egress forward proxy restricts host browser traffic to port 443 HTTPS and rejects loopback, private networks (RFC 1918), Carrier-Grade NAT (RFC 6598), IPv6 ULA/link-local, and cloud metadata endpoints (`169.254.169.254`). Off-origin resources, downloads, popups, WebSockets, and service workers are disabled or blocked.
- Hosted mode trust boundary: The host operator and TLS reverse proxy termination point have access to active process memory and plaintext values. Hosted mode is not zero-knowledge. Cloudflare QuickTunnel is temporary testing only (no SLA, URLs change on restart, connection limits, polling not SSE); production requires stable reverse proxy configuration (`AUTOMATE_HOSTED_PUBLIC_ORIGIN`). Local Windows Hello/DPAPI trust remains separate.
## Evidence on Hand

The actual owner UI filled The Internet's public HTTPS login using published credentials and Autofill.me's public HTTPS card form using fictitious data, with explicit field approval, no application POST, unchanged CVV, private audit bytes, and no 390 px horizontal overflow. These browser checks used an explicitly isolated in-memory public-data fixture; actual encrypted typed-record/Unicode roundtrips were verified separately in isolated native DPAPI `.test` vaults. The default normal-vault UI showed unavailable-Hello refusal with fields untouched; positive normal-vault-to-site filling remains unverified. The native session monitor started and closed fail-closed; real lock/disconnect and secure-desktop authentication behavior remain unverified. Existing synthetic registration, planning protocol, cancellation, audit/history, and Android host/build evidence remains documented in README.md. No real customer account, card, or payment was used.

The independent Vault UI additionally saved login/card fixtures through actual DPAPI before browser creation, listed identities without values, and retrieved the login only after explicit username approval, leaving the password untouched. Delayed listing could not repopulate a locked Vault. Four unchanged frames preserved image/annotation nodes, draft focus/selection, scroll, and geometry; a late old decode could not replace a newer inspection. Four public-login captures produced no DOM mask/style mutations. Desktop columns and the 390 px stacked layout were inspected. This used isolated fictitious `.test` data, not positive Windows Hello.

## Product Principles

- Authorization stays outside the model.
- Unsupported or changed evidence fails closed before credential use.
- The observer must not create an alternate AI observation path.
- Demonstrations and limitations are labelled honestly.
