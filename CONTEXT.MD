# Auto-Mate project context

Consolidated project memory from all available Auto-Mate conversations through the current release-preparation session. This is a maintained context summary, not a verbatim transcript or a claim that every original goal is implemented. It deliberately excludes tokens, private credentials, raw vault data, unrelated command history, and machine-specific session files. It is excluded from the application release and public homepage.

## Current user decisions — read these first

1. **Continue with the application, not a browser extension or demo site**: Extension development remains cancelled. Marketing/demo site work lives exclusively in the separate public repository `anujparwal/Auto-Mate-homepage`. Focus strictly on the actual application workspace and app-only releases.
2. **Simplified Agent Workspace layout**: Redesigned UI matching the application layout:
   - **Left column**: "Chats between the user and the agent" (`chat-column`) with prompt input, Send, and Stop controls.
   - **Right column (top)**: Live Masked Preview of the browser with origin badge, status badge, and off-page Sharp redaction (opaque black masking over all controls and iframes, reflected private values masked). Screenshots are strictly owner-only and **never sent to the AI model**.
   - **Right column (bottom)**: "Vault and permissions" with three tabs:
     - **Variables**: vault variable catalog (id, name, description, kind, scope, origin) and "+ Add Variable" modal.
     - **Ongoing Permissions**: quick grant to active site, task-scoped direct-fill grants, and revocation controls.
     - **Notes Space**: live research notes recorded by orchestrator and evaluator subagents with verbatim source quotes.
3. **AgentEngine ReAct strict JSON tool loop**: The legacy form-planner flow (`model-config.json`, `application-planner.ts`, static form autofill) is **no longer used by the actual app** and is marked explicitly historical. The app operates an autonomous ReAct loop returning strict JSON actions: `{"tool":"tool_name","args":{...},"status":"..."}`. Tools include `navigate`, `observe`, `scroll`, `click`, `type` (for public search only), `request_information` (for private information filling through host only, never in chat/type), `take_note` (source-linked note with verbatim evidence quote), `spawn_subagents` (cookie-less parallel evaluator workers), and `finish_task`.
4. **API only; no model setup or hosting**: The user supplies an OpenAI-compatible API; no local model weights, GPU setup, Colab notebook, or model hosting is provided or required. The previously configured ngrok endpoint (`https://nullify-geometric-decathlon.ngrok-free.dev/v1/chat/completions`, model `qwen3.5-9b`) returned HTTP 404 (`ERR_NGROK_3200`: ngrok tunnel offline), so live model inference is not verified. When a model endpoint fails or is unreachable, the error is displayed visibly to the user (e.g. `PLANNER_UNAVAILABLE`); **no fake fallback or reviewed-command mode exists in the new app**.
5. **Per-user Settings & Encrypted Workspace Store**: Settings are managed in the ⚙️ Settings dialog and persisted encrypted per user via `src/workspace-store.ts` + `platforms/windows/workspace.ps1` (DPAPI `CurrentUser`) on desktop, or AES-256-GCM encrypted workspace files in hosted mode:
   - **Model provider presets**: OpenAI, Groq, OpenRouter, Ollama, LM Studio, and Custom. Hosted mode strictly permits cloud HTTPS endpoints (local loopback forbidden). Local Desktop mode permits genuine loopback (`localhost`, `127.0.0.1`, `::1`) or cloud HTTPS.
   - **Navigation policy**: Configurable `whitelist` or `blacklist` mode with domain rules (automatically covers subdomains, e.g. `example.com` covers `*.example.com`). Off-policy navigations fail closed.
   - **Opt-in permanent memory vs. evidence notes**: Permanent memory is opt-in (toggle + editable up to 32 KiB) and persists across tasks. Research notes (up to 100 notes) are captured dynamically during tasks and require verbatim quotes from observed public pages.
   - **Variable groups**: Users can define up to 32 groups (up to 32 variables each) for bulk task-scoped grants.
6. **Variable metadata vs. private values**: The model receives only variable metadata (`id`, `name`, `description`, `kind`, `scope`, `available`) with known private values redacted (`[private]`). Secret values and ciphertexts **never reach the model**. The host controller retrieves and fills values directly into the browser.
7. **Exact origin / site-bound credentials vs. shared profile**: Credential variables (`username`, `password`) are strictly site-bound to an exact HTTPS origin. Non-credential variables (`text`, `email`, `tel`, etc.) can be saved as shared profiles reusable across authorized origins.
8. **Private unknown-field dialog**: When a website needs data not present in the vault, the agent invokes `request_information`, opening a local modal dialog. The user enters the value privately, can optionally save it as a site-bound or shared profile variable with name and description, or skip it. Secret values never pass through chat or model prompts.
9. **Permissions: one-off vs. task-scoped grants & revocation**: Sensitive website actions (button clicks, submissions) and ungranted variable disclosures require explicit modal confirmation. Users can grant task-scoped permissions for specific variables or variable groups to an active origin (`workspace-grant`), and revoke them at any time (`workspace-revoke` or Stop).
10. **Windows Hello native reads**: In Local Desktop mode, reading vault secrets for field filling enforces native Windows Hello verification.
11. **Safe Stop and Cancellation**: The Stop button or follow-up instructions safely abort the active task controller, close the active browser context, cancel pending dialogs, clear task grants, and reset the live preview.
12. **Cookie-less parallel evaluator subagents**: `spawn_subagents` runs parallel, signed-out browser contexts (`research` worker contexts) that evaluate independent candidate URLs without user cookies, credentials, or interaction handles, extracting source-quoted findings.
13. **Approval is not proof**: Buttons require user approval; after private filling, main-browser navigation and link clicks require approval too. Approved actions may complete real purchases. The model is instructed not to invent success, but users must verify website confirmations/receipts.
14. **Simplified Hosted Registration**: Registration in Hosted Mode operates with lowercase username and strong passphrase (≥12 characters) without requiring an operator invite code by default. Optional operator invite code can be configured via `AUTOMATE_HOSTED_REGISTRATION_KEY`.
15. **Railway trial ended**: The prior deployment trial on Railway has ended; documentation notes this as historical. Local desktop mode and self-hosted mode (QuickTunnel or custom reverse proxy) remain active.
16. **Version target**: `0.2.0-preview.1`, unsigned private application preview. The prior `v0.1.0-preview.3` is immutable. Release packages exclude homepage/demo assets and maintainer conversation context.
## Original product vision (2026-10-30)

The user proposed a secure local/cloud-model browser agent for forms, setup, login, signup, and related tasks, targeting **Windows and Android**. Credentials would remain in an OS-authenticated local vault, never reach the model, and be used only by deterministic trusted code through opaque references.

Requested secrecy layers: Yellow for profile information (names, DOB, usernames, email); Orange for identity documents/government IDs; Red for secrets and financial data. The deterministic broker, not AI, should control field insertion and rendering. Newly generated passwords should be generated/stored outside the model. Protected page observations, including screenshots, must not become an exfiltration route.

The initial wish list also included configurable categories, destination blacklists, notifications/a dashboard, and duration/category-scoped automatic approval without repeated biometrics. **These are goals, not all implemented promises**. The current design uses task-bound explicit approval and mandatory native authentication on normal operations; a duration does not create a blanket biometric-free approval window. A full category editor, OS notifications, general autonomous browsing, cross-device sync/recovery, and Android browser execution remain absent.

## Conversation and implementation chronology

### Security foundation and first publication

- Established the Git repository and pushed to the user's account, `anujparwal/Auto-Mate`.
- Built TypeScript authorization, native Windows DPAPI storage, Android Keystore storage, and an isolated synthetic Windows vault-to-Chromium flow.
- Initial gaps included plaintext sensitive metadata, missing native verification, and no attached Android device. Later work added metadata-protecting v2 envelopes, validated v1 migration, and fail-closed normal Windows Hello gating. Historical gap reports should not be mistaken for the current implementation state.
- Same-user DPAPI is not cryptographic per-use biometric protection. Windows Hello is an application gate; malware with the same user privileges or a compromised OS is outside the guarantee. JavaScript/PowerShell strings cannot promise memory zeroization.

### Owner preview, categories, approval, and audit

- The user asked for a real-time preview with deterministic paired requesting-text/target-field marks and trusted category colors. Implemented an owner-only image preview and trusted request list, not an AI screenshot tool.
- Added exact-origin/task/category authorization, owner approval/denial, synchronous fail-closed audit writes, metadata-minimal persistent journals, and a read-only history viewer.
- Added active expiry/cancellation, pending-operation teardown, late-result isolation, and bounded errors. Read-only history actions cannot authorize execution.
- [PR #1](https://github.com/anujparwal/Auto-Mate/pull/1), secure vault/Hello/owner approval, and [PR #2](https://github.com/anujparwal/Auto-Mate/pull/2), audit history/cancellation, are **merged** (verified against GitHub). New work must not be added by treating those PRs as still open.

### Working prototype and model boundary

- Added task entry, a trusted reviewed plan, and optional OpenAI-compatible local/cloud planning to the synthetic demonstration.
- Offline reviewed mode accepts `Run synthetic registration`. Models can select only `synthetic-registration` or `unsupported`, not selectors, origins, credentials, grants, or arbitrary browser actions.
- Cloud mode requires explicit instruction-disclosure consent, HTTPS, a bearer key, bounded requests/responses, and no redirects or automatic retry/fallback. Local mode is actual loopback only, not a remote Colab machine described as local.
- Provider protocol fixtures have passed; they are not actual Qwen or other model-inference proof.

### Real-site fill-only workflow and independent Vault column

- The user requested real-site login/card filling after explicit approval, then a separate Vault column usable before website inspection.
- `bun start` now opens that independent owner Vault and real-site autofill window. `bun start --synthetic` retains task entry/model planning. `bun run preview` opens the synthetic owner preview/history demonstration.
- Login and typed card records are encrypted for exact HTTPS origins. Normal save/list/read each require Hello. Listing exposes IDs/metadata only to the owner; choosing an ID does not approve disclosure.
- Field checkboxes start unchecked. Deterministic discovery verifies unique visible main-document label associations; evidence and original nodes are rechecked before filling. Unsupported/ambiguous/replaced/clipped fields fail closed.
- Cardholder/number/expiry are supported; CVV/CVC, PINs, OTPs, bank accounts, billing addresses, embedded payment widgets, arbitrary redirects, SSO/CAPTCHA/MFA are not bypassed. The app never clicks Login/Pay/Submit in this real-site path. Filling itself discloses values to receiving scripts.
- Added native WTS/input-desktop session monitoring; Stop, Lock, expiry, owner closure, and unavailable sessions remove authority. Unlock must not revive grants. Already-started writes may finish after Stop and are not rolled back.
- The user reported preview glitches. Replaced DOM screenshot masks with off-page Sharp redaction, retained unchanged decoded frames/annotations, reserved geometry, and added revision/decode guards to prevent stale scenes and draft/focus disruption. Masking covers controls/open shadow roots and whole iframe rectangles, not arbitrary secrets echoed into text/canvas/images/closed shadow roots. Owner pixels are never model-safe observations.
- Briefly considered extension-based automatic filling; the user subsequently explicitly cancelled that direction.

### Website stabilization pass (2026-10-31)

- Baseline: 167 passing tests. Found and reproduced a Stop race while waiting for a previous protected context to close: a replacement inspection could still open and return `review` after Stop. Added a closed/revision guard after teardown, a failing-before/passing-after regression, and a separate Chromium smoke scenario proving one website opened, only the owner context left, and zero Vault calls.
- Made pending inspection setup cancellable and awaited the original abort-triggered context closure before acknowledging cancellation. Separate smoke exposed and verified the concurrent-close completion edge.
- Refused unsupported cardholder/card-number/combined-expiry dropdowns during discovery instead of offering them for approval and later rejecting them during filling. Numeric month/year select support is retained.
- Rejected speculative changes that trimmed usernames/legacy IDs/passwords or expanded number-format acceptance. Stored identities and secrets must not be silently normalized as an invented bug fix.
- Browser checks with **in-memory fictitious data** showed Username-only disclosure leaving Password empty, card fields filling with CVV empty, zero application submissions, Lock teardown, and masked preview. Actual public login inspection and the 390 px owner layout were exercised. Native normal-vault Hello refusal kept metadata locked; no successful authentication was simulated.
- Synthetic UI completed explicitly Yellow/Red-approved intercepted registration with actual isolated Windows DPAPI persistence. Synthetic smoke verified private-at-rest envelope and metadata-minimal durable audit/history behavior.
- Final traced full suite: **170 passed, 0 failed**; typecheck and synthetic native/browser smoke passed. A new browser regression needed the existing unsupported-form tests' 20-second budget rather than Bun's default 5 seconds. A separate plain run produced nine cascading `SETUP_FAILED` errors in the shared browser; isolated/full diagnostic reruns passed, but the cause was not captured. **Do not claim this intermittent reliability issue is fixed.**

### Model, installation, and public-deployment preparation

- Added `tools/setup-windows.ps1`: supported Windows x64 checks, existing-install preservation, SHA-256-verified pinned official Bun install when missing, frozen dependencies/Chromium installation, check-only mode, and optional developer tools. No machine-wide execution-policy change or normal-authentication bypass.
- The first model request mentioned Qwen3.5-9B/Colab, but a later interjection removed all model-hosting setup from scope. Temporary notebook/hosting instructions were removed before publication; no local model weights or serving stack were installed.
- `docs/model-api.md` documents the existing OpenAI-compatible client, required connection information, process-local bearer configuration, cloud consent, strict JSON contract, and testing limits. No model credentials are committed or embedded in the static site.
- Added static `site/`, a Windows source-package/checksum build, Windows verification CI, and a manual-main-only GitHub Pages deployment workflow. These are deployment artifacts, not evidence of a deployed site or public production readiness. The selected architecture does not migrate the vault to a server.
- `use.md` is the end-to-end operator guide and includes testing, supplied-API connection, and future deployment steps.
- Release-preparation verification: prerequisite setup and check-only mode passed with existing Bun/Git/GitHub CLI/Chromium/Sharp; plain `bun test` passed all 170 tests, typecheck and native/browser synthetic smokes passed, and actionlint 1.7.12 validated both workflows. The generated ZIP was extracted outside the checkout, installed frozen dependencies, typechecked, and completed actual DPAPI/Chromium smoke. The static download site was inspected at 1440/390 px in dark/light modes; all public links returned 200, downloaded ZIP bytes matched the published checksum, no page overflow or console errors were observed, and private/generated/model-setup files were absent from the archive. None of this proves successful Hello, actual supplied-API inference, or public deployment.
- Published the completed website/distribution work in [PR #3](https://github.com/anujparwal/Auto-Mate/pull/3), branch `feat/website-release-preparation`, targeting `main`. GitHub reported it **merged while hosted verification was still failing**. A merge is not a passing check, public deployment, or production-release approval; the remaining hosted repair continued on `fix/windows-vault-ci` instead of undoing the user's merge.
- During investigation, independently reproduced `VAULT_REQUEST_DENIED` with a fresh Bun process inheriting different `TEMP` and `TMP`: Node/Bun and native Windows choose different roots. Fixed only the synthetic native child's temporary-base environment, without relaxing normal authentication or namespace/entropy guards. The cross-process DPAPI regression failed before and passed after; actual DPAPI/Chromium smoke also passed with divergent variables, and the local full suite passed **171 tests** plus typecheck. This did not resolve the hosted refusal by itself and is separate from the earlier unexplained shared-browser setup cascade.
- An isolated fixed-synthetic-payload diagnostic then exposed the hosted cause: `Set-Acl` could not load `Microsoft.PowerShell.Security` because cross-runtime `ObjectSecurity` type data was already present. Bound native helper module lookup to its own `$PSHOME\Modules` and ran the standalone native smoke in Windows PowerShell. App tests keep their PowerShell 7 parent so interoperability is exercised. Restrictive ACLs, authentication, entropy separation, and fail-closed public diagnostics were retained; local native/browser smokes passed after the change.
- The repaired hosted probe and native save/read cases succeeded. The next hosted run instead hit the generic five-second test deadline in the seven-process typed-vault roundtrip and the audit-limit fixture that creates/removes 4,097 files. Added explicit 20/30-second budgets only to those real-I/O integration cases, retaining every assertion and all production deadlines. Removed the temporary diagnostic script and workflow step after identifying the cause.
- GitHub subsequently reported [PR #4](https://github.com/anujparwal/Auto-Mate/pull/4) merged at diagnostic commit `0e94a02`, before the actual module-isolation fix. Continued the final repair on `fix/native-host-module-isolation`, preserving both user-owned merges while removing the temporary diagnostics.
- The final extracted-package native smoke exposed another real transport problem: a legacy .NET stdin writer emitted a UTF-8 BOM, while detached PowerShell decoded bytes as OEM code page 437. Corrected the smoke producer/decoders and reproduced cross-console Unicode secret corruption; an ordinary same-encoding roundtrip had hidden it. Native broker IPC now uses explicit process-local BOM-free UTF-8 readers/writers without changing console code pages. The cross-console regression failed before and passed after, along with all native refusal/privacy checks and actual DPAPI/Chromium smoke. These are synthetic-data checks, not proof of successful Windows Hello or actual provider inference.
- Final repair review: [PR #5](https://github.com/anujparwal/Auto-Mate/pull/5). Integrated local verification passed all **171 tests**, typecheck, and both workflow actionlint checks. Rebuilt the ZIP, extracted it outside the checkout, installed frozen dependencies, passed setup/check-only, typecheck, the full native ACL/privacy/refusal/cross-console Unicode smoke, and actual DPAPI/Chromium execution. The ZIP bytes matched the published SHA-256. Hosted results are recorded in that PR's Verify checks; this local evidence does not establish successful Hello, a fresh-machine Bun bootstrap, actual supplied-API inference, or production/public deployment approval.

## Application release and separate homepage

- The next request is to bundle the actual Windows application, make its first release, and create a separate homepage repository with as many suitable 21st.dev components as practical and Framer Motion animation. The product demonstration is a non-interactive **video**, not a simulated form that visitors can operate.
- The user explicitly selected **private preview release**: the app repository and application download remain private. The separate public homepage repository is [Auto-Mate-homepage](https://github.com/anujparwal/Auto-Mate-homepage), created for the marketing site and original simulated film. Its visitors are not promised a public installer.
- Priority clarification: **the release contains the application only, not the demo page**. The portable ZIP excludes the homepage, film, marketing assets, developer prototype page, keys, vaults, and conversation memory. Its native launcher starts the normal owner app with bundled Bun/Chromium/dependencies; source development can retain its separate synthetic prototype.
- Selected first version: `v0.1.0-preview.1`, unsigned Windows 11 x64 private prerelease. The application archive is `Auto-Mate-0.1.0-preview.1-windows-x64.zip`, accompanied by `SHA256SUMS.txt`; it is not a signed installer or production approval. The old in-app static site, source-ZIP builder, and Pages publisher have been removed as obsolete.
- The original 36-second 1440×900 film uses fictitious `.test` destinations and persistent simulated-data labels. Its Windows Hello scene explicitly states that no OS verification is performed; subsequent filling is conditional illustration. It does not prove a live model, account access, biometric/PIN success, or workstation lifecycle behavior.
- Component provenance is recorded in the homepage's `ATTRIBUTIONS.md`, including component-specific 21st catalog licenses, public upstream sources, actual copyright notices, and adaptation details. No 21st key was supplied; authenticated registry endpoints, paid assets, and quotas must not be bypassed. Public build output includes dependency license notices and self-hosted fonts.
- Normal release behavior remains deterministic selected-field filling. Login and payment-card records are supported; CVV/OTP/TOTP challenges are refused. There is no Windows UI Automation executor, HWND-bound credential policy, hardware-backed DPAPI guarantee, hard-real-time teardown claim, or guaranteed JavaScript/website memory zeroization. Lock cannot undo data already disclosed to website scripts.
- Release validation must exercise the extracted bundled runtime with global Bun excluded, the actual owner UI, native/browser smoke, and launcher child-tree shutdown. Homepage validation must exercise actual mobile/desktop rendering, playback/captions, keyboard navigation, motion pause/resume and live OS reduced-motion changes. Exact results belong in the tagged release/CI records; synthetic checks do not discharge the remaining hardware/security gates.
- The packaged-runtime regression is `bun run check:app`, also run by Windows CI after the build. It verifies the archive/checksum boundary and launches bundled `Auto-Mate.exe --check` with only Windows system folders on `PATH`, from a spaced Unicode extraction path. Initial verification exposed Windows PowerShell ZIP extraction's legacy long-path failure; use a short extraction location rather than claiming arbitrary long-path support.
- An actual Chromium video playback test failed on the original VP9 encode with `PIPELINE_ERROR_DECODE`. Re-encoding both video formats as SDR BT.709 limited-range yuv420p, with VP9 profile 0 and no ICC side data, restored observed WebM playback. FFmpeg is an authoring dependency of the separate homepage only, not an application release asset.
- Local release verification observed all 171 existing tests passing, typecheck, native ACL/privacy/refusal/cross-console Unicode smoke, and actual DPAPI/Chromium execution. The extracted application also completed all five real `--check` assertions with global Bun/Node excluded from `PATH`, from a spaced accented-character path. The initial long extraction path failed before any application launch; reducing that path fixed the extraction check without relaxing authentication or runtime assertions.
- GitHub now reports [PR #6](https://github.com/anujparwal/Auto-Mate/pull/6) merged. Preserve the user's previous merges when integrating the release branch; a merged PR alone is not a verification result.
- Actual packaged no-argument launch created the expected Bun, Chromium and native session-monitor tree; terminating only the launcher left zero of its ten observed descendants after two seconds. Using the same packaged owner app/runtime with normal Windows vault/session defaults, real public-login inspection found Username/Password, native Hello refusal kept metadata locked, and Stop/Lock removed authority and cleared the preview. Temporary CDP inspection existed only in the disposable test harness, never in the shipped launcher.
- Hosted release verification captured a specific browser cascade: the two-context duplicate/iframe test hit Bun's five-second budget, Bun killed the shared browser, and later tests returned `SETUP_FAILED`. Its all-URL fixture had returned the iframe-containing HTML to its own child. The fixture now serves a finite child login document, still rejected as an iframe-only form, with the existing 20-second integration-test budget. This evidence does not prove every historical intermittent browser problem has the same cause; production deadlines/retry behavior are unchanged.
- Final homepage interaction checks reproduced a React conditional-hook crash when ambient motion or OS reduced motion changed, and a seven-item navigation overflow at 768 px. The spotlight motion-template hook now runs unconditionally; tablet navigation uses the collapsed layout until the large breakpoint. These are runtime-discovered bug fixes, not additional application features.
- After the homepage rebuild, actual browser checks passed at 1440/768/390/360 px with no horizontal overflow, manual motion pause/resume, live OS reduced-motion changes, native Sources dialog Tab containment/Escape/focus restoration, FAQ and mobile menu controls. WebM decoded, sought to 18/32 seconds, and reached its 36-second end without a media error; all seven caption cues and transcript scenes were present. On the deployed HTTPS project site, MP4 fallback also decoded through 36 seconds and sought to 18/32 seconds without error. Native fullscreen enter/exit buttons worked and the simulation/Hello disclaimer remained visible. Synthetic Escape did not exit browser fullscreen in headless Chromium; do not claim OS-key coverage.
- The public site is [Auto-Mate homepage](https://anujparwal.github.io/Auto-Mate-homepage/), deployed from its own repository with GitHub Pages Actions and enforced HTTPS. The private application repository has no Pages configuration. Public notices returned HTTP 200, the 390 px layout had no overflow, and no interactive product form was present.
- Deployed-surface checks additionally exposed a stale ResizeObserver calling `getTotalLength()` on the moving border's removed SVG after reduced-motion/resize changes. Bound both geometry and visibility observers to the motion/DOM lifecycle, disconnected and invalidated old callbacks, and measured only rendered geometry. Actual local pause → 390/768/1440 px resize → resume and manual pause/resume both restored a moving border with no JavaScript exceptions; no exception was suppressed.
- GitHub reported [PR #7](https://github.com/anujparwal/Auto-Mate/pull/7) merged at `3c8fd41` while its hosted run was failing. The finite-iframe repair and subsequent context updates are follow-up work; preserve the user's merge and include those changes in the final reviewed release source instead of tagging the failed pre-repair tree.
- Published the first private prerelease: [v0.1.0-preview.1](https://github.com/anujparwal/Auto-Mate/releases/tag/v0.1.0-preview.1), targeting `0fbda962b43b78fa12b28ce930a81267bc29251a`. Its only uploaded assets are the Windows application ZIP and `SHA256SUMS.txt`. Downloaded both back from the private release; the ZIP matched the exercised local artifact and published SHA-256 `d6d6b12bd0e74b809935d8cb77e65a632a1e6f19330d6d666f728ce15a5df935`.
- Final release-source [Windows CI](https://github.com/anujparwal/Auto-Mate/actions/runs/41286023698) passed **171 tests, 0 failures**, typecheck, native smoke, application build, and the actual extracted-runtime check. Follow-up review is [PR #8](https://github.com/anujparwal/Auto-Mate/pull/8); the tagged source is the passing repaired tree, not PR #7's failed original head.
- Homepage source `cac95b24784d81aab2d0aa926f6f2290c2947afe` passed its own verification and deployment workflows. Fresh checks of the deployed repaired bundle proved the border moves again after OS reduced-motion/resize and manual pause/resume, with zero captured JavaScript exceptions. Browser tabs, temporary proof files/downloads/extractions, and the local preview server were cleaned up; installed authoring tools remain available.


## Latest homepage playback request

- The user now requests that the product video use the device's width, loop continuously, and have **no media controls**. This supersedes the homepage's original paused/native-player-controls presentation; earlier playback/fullscreen checks above describe that previous design.
- The homepage video is edge-to-edge at viewport content width, preserves the complete 16:10 frame, autoplays muted and inline, and loops. The constrained 3D scroll wrapper and its unused source/attribution entry were removed. The existing site motion preference is labeled **Animations & film** and pauses/resumes both; OS reduced motion prevents automatic playback, including on initial load.
- Local browser checks observed exact edge-to-edge bounds and no horizontal overflow at 360/390/768/1440 px, muted autoplay with controls disabled, time wrapping from approximately 35.5 seconds to the start while still playing, stable time during manual pause, and paused time zero after reloading with reduced motion enabled. Transcript/captions and simulation disclosures remain available.
- Source-failure smoke caught a false unavailable banner during successful MP4 fallback and native `<source>` exhaustion leaving `video.error` null. The final handler distinguishes recoverable source failures from terminal media failure, clears status on actual playback, and handles exhaustion of the last source. After the repair, blocking WebM yielded muted, control-free MP4 autoplay/loop with no false notice; blocking both formats displayed the unavailable notice with a usable transcript and no captured JavaScript exceptions.
- Runtime changes are confined to the separate homepage; the published application-only release is unchanged. Native test-harness timing was repaired separately after the context-update CI failure below. Do not rebuild or alter the application release merely to update the marketing film.
- Public homepage commit `1c5e9448d5e47e5f522f0684de5996e7945757e5` passed verification/deployment. Fresh deployed checks confirmed exact full-width bounds at 360/390/768/1440 px, no controls, muted inline playback, a real loop wrap, all seven caption cues, manual pause and reduced-motion initial pause, with no captured JavaScript exceptions.
- Context-update CI captured native fixture timeouts: the first native save had not finished when its 20-second test budget expired; three other native scenarios hit Bun's five-second default, with killed processes and late protocol errors. Real native integration cases now receive a bounded 60-second fixture budget; production's 90-second IPC deadline and authentication/security assertions are unchanged. This does not establish a native-performance fix or explain the internal latency. Local verification passed all ten native cases, typecheck, and actual DPAPI/Chromium smoke.

## Agent missing-information dialog and vault variable visibility (0.1.0-preview.2)

- **User instruction**: "make sure that whenever the Agent wants some info that is not already available to it, eg. Name on the first run, some username that has to be created on a new website, etc. a dialogue box should appear for the user to enter it. Also the agent should be able to see all the variable names in the vault along with their description, so that it can know which variable goes into what field, if any changes are made, update them on GitHub and also publish a newer build".
- **Variable scope decision**: The user selected **Shared profiles, site-bound credentials**: general profile variables (names, general text) can be reused across websites with explicit approval; credentials (usernames, passwords) remain strictly site-bound.
- **Implementation**:
  - `src/information-contract.ts`: Defines `InformationVariable` projection (`id`, `name`, `description`, `kind`, `scope`, `available`) without values, ciphertexts, or private handles; defines `InformationVault`, `InformationField`, `InformationMapping`, and compatibility validator `informationKindsCompatible`.
  - `src/information-vault.ts` / `platforms/windows/vault.ps1`: Implements `WindowsInformationVault` with native DPAPI v2 storage and Hello gating. Native broker exposes `catalog` (metadata only, no values), `save-variable` (bounds checking, profile namespace routing, non-credential profile check, prevents silent overwrite), `resolve-variable` (cross-origin check, trusted host execution only), and `authenticate` (one-off data verification).
  - `src/information-session.ts`: Discovers visible, explicitly labeled inputs (text, email, tel, url, username, password, select, textarea, date, number) with opaque local IDs, public option labels for select, and strict evidence verification. Refuses CVV, PIN, OTP, CAPTCHA, and card number challenges.
  - `src/information-planner.ts`: Extracted shared model transport in `src/model-client.ts`. In reviewed mode, performs deterministic exact/case-insensitive matching; in remote mode, formats public field projection and variable metadata allowlist (no values, DOM, handles, or URLs). Rejects invalid outputs, extra keys, or incompatible variables.
  - `src/information-flow.ts`: Orchestrates owner-only flow: demands catalog review before planning, manages missing-info requests, handles manual variable selection and user-provided dialog values, saves profile/site variables, and validates readiness.
  - `ui/autofill.html`, `ui/autofill.js`, `ui/autofill.css`: Adds "All form fields (Agent assisted)" inspection mode, "Named variable" vault save form, variable catalog list with names/descriptions, modal `<dialog id="info-dialog">` for user to provide missing information or skip, and mapping status badges on field rows.
  - Full test suite passes: **207 passed, 0 failed** across 15 files.
  - Bumped version to `v0.1.0-preview.2` for the newer portable Windows application build.

## Hosted mode, remote HTTPS access, and operator controls (0.1.0-preview.3)

- **User direction and approvals**:
  - Explicitly approved a separate **Hosted Mode** alongside local desktop Windows Hello mode.
  - Approved **invite-only registration** protected by an operator registration invite key; no open registration.
  - Approved **HTTPS Internet access** using an ephemeral Cloudflare QuickTunnel (`https://*.trycloudflare.com`) or custom reverse proxy (`AUTOMATE_HOSTED_PUBLIC_ORIGIN` + `AUTOMATE_HOSTED_PORT`).
  - Approved **remote authentication** using an Auto-Mate username + chosen passphrase (≥12 chars) and operator invite key (≥16 chars) instead of Windows Hello for hosted sessions; local Hello remains for local desktop mode.
  - Approved **fill + separate explicit approval for website button clicks**: remote users can request website button actions (Login, Submit, Next, Pay, or destructive), each requiring manual approval in a dedicated confirmation modal popup. Autonomous model clicks and autonomous form submissions are strictly prohibited.
- **Account validation policy**: Usernames must be strictly lowercase ASCII (3–64 characters, `^[a-z0-9][a-z0-9._-]{2,63}$`); no case-folding or normalization is performed. Passphrases must be at least 12 characters and are never trimmed. Operator invite keys must be at least 16 characters. Wrong invite key fails with HTTP 403 `INVALID_REGISTRATION_KEY`.
- **Cryptographic storage & host trust**:
  - Each account has an isolated vault file (`<accountId>.vault`) stored in `%LOCALAPPDATA%\AutoMate\hosted\`.
  - Key derivation uses memory-hard `scrypt` ($N=32768, r=8, p=1$, maxmem 64 MiB) with an independent 32-byte salt per user.
  - Domain-separated HMAC-SHA256 subkeys: `authSubkey` for constant-time verifier verification (passphrases never stored), `encSubkey` for AES-256-GCM vault encryption.
  - Key buffers are zeroed with `.fill(0)` upon explicit logout or fixed 1-hour expiry. Lost passphrases cannot be recovered.
  - Host operator and any process with administrative access to the host machine can access active plaintext values in host memory during an active session. Hosted mode is not zero-knowledge.
- **Session lifecycle, disconnect, and layout**:
  - Server supports up to 4 concurrent active sessions, single session per account (signing in from a new device immediately closes the previous session).
  - Fixed 1-hour authentication expiry from sign-in (`sessionTtlMs = 3,600,000`), not an inactivity timeout. Activity and polling do not extend this fixed deadline.
  - Disconnect grace period is 5 seconds (`disconnectGraceMs = 5000`): disconnect or backgrounding > 5s closes the actual website and clears field approvals + one-offs, but the account key stays in memory until explicit logout or fixed 1-hour expiry. Resuming gets fresh state and never resurrects old authority.
  - Host sleep / suspension interrupts network tunnels and user sessions rather than necessarily terminating the server immediately, but drops connections.
  - Live observation preview renders on the right side on desktop and stacked vertically on mobile. Observation-only; preview pixels cannot be clicked or typed in.
  - Live bug caught in production testing: Cloudflare QuickTunnel dropped HTTP Server-Sent Events (SSE) stream bodies (stream state arrived locally on loopback, but public HTTPS bodies never arrived). Replaced SSE entirely with regular authenticated JSON polling (`GET /api/updates?after=sequence` at 500 ms intervals). Docs must not promise SSE.
- **Network isolation**:
  - Public-only DNS-pinned forward proxy restricts host browser traffic to port 443 HTTPS.
  - Rejects loopback (`127.0.0.0/8`, `::1`), private networks (RFC 1918 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), Carrier-Grade NAT (RFC 6598 `100.64.0.0/10`), link-local and cloud metadata (`169.254.0.0/16`, including `169.254.169.254`), and IPv6 ULA/link-local (`fc00::/7`, `fe80::/10`).
  - Off-origin requests, downloads, popups, WebSockets, and service workers are disabled or blocked.
- **Model configuration, protected boundary, and strict flat JSON contract**:
  - Configured endpoint in `model-config.json`: `https://nullify-geometric-decathlon.ngrok-free.dev/v1/chat/completions`, model `qwen3.5-9b`.
  - Server provides `POST /v1/chat/completions` only with no `/models` endpoint; model identity is unverified (do not claim 9B weights verified). Real metadata-only probes previously passed, but the exact provided endpoint currently returns HTTP 404 (`ERR_NGROK_3200`: ngrok tunnel offline / endpoint not found).
  - No Qwen or Colab setup is provided, hosted, or required.
  - External model planning requires explicit user consent and receives metadata only (public field descriptors and variable catalogs, never secrets or ciphertexts).
  - Protected-page model boundary: once a fill or approved website button click occurs, external model observation is blocked because the receiving page may echo disclosed secrets; user can explicitly select "Map locally / ask me · No API", with no automatic fallback.
  - Form mapping (`InformationPlanner`) validates that model output is a strict flat JSON map `{ [fieldId: string]: string | null }` matching all discovered field IDs to compatible available variable IDs or null. Missing or extra keys fail closed.
- **Cloudflare tunnel helper binary**:
  - Downloads and verifies official Cloudflare release 2026.10.7 Windows x64 binary (`cloudflared-windows-amd64.exe`, SHA-256 `2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343`, 55,390,512 bytes) cached in `%LOCALAPPDATA%\AutoMate\tools`.
- **Trust boundaries**:
  - Host operator and TLS reverse proxy have access to active process memory and plaintext values. Hosted mode is not zero-knowledge.
  - QuickTunnel is for temporary testing only (no SLA, URLs change on restart, connection limits, polling not SSE); production requires stable reverse proxy configuration (`AUTOMATE_HOSTED_PUBLIC_ORIGIN` + `AUTOMATE_HOSTED_PORT`).
  - Local desktop Windows Hello/DPAPI trust remains separate.
- **Historical status of 0.1.0-preview.3**: `v0.1.0-preview.3` is an immutable published GitHub release. The legacy form-planner flow (`model-config.json`, `application-planner.ts`, reviewed-command mode) is explicitly historical and no longer used by the actual app.

## Simplified Agent Workspace, ReAct Tool Loop, and Workspace Store (0.2.0-preview.1)

- **Architecture cutover**: Completely transitioned from the old form-autofill flow to an autonomous Agent Workspace powered by `AgentEngine`, a ReAct strict JSON tool loop (`{"tool":"tool_name","args":{...},"status":"..."}`).
- **Current UI layout**:
  - **Left column**: "Chats between the user and the agent" (`chat-column`) with prompt input, Send, and Stop controls.
  - **Right column (top)**: Live Masked Preview with active origin badge, live status, and off-page Sharp redaction compositing black opaque masks over all controls, iframes, and reflected secrets. Screenshots are strictly host-rendered owner previews and are **never sent to the AI model**.
  - **Right column (bottom)**: "Vault and permissions" with three tabs:
    - **Variables**: vault variable catalog (id, name, description, kind, scope, origin) and "+ Add Variable" modal.
    - **Ongoing Permissions**: quick grant to active site, task-scoped direct-fill grants, and revocation controls.
    - **Notes Space**: live research notes recorded by orchestrator and evaluator subagents with verbatim source quotes.
- **ReAct toolset**:
  - `navigate`: navigates to public HTTPS URL within whitelist/blacklist policy.
  - `observe`: observes current page structure and text.
  - `scroll`: scrolls `up` or `down`.
  - `click`: clicks links directly, or requests user confirmation for buttons and actions.
  - `type`: public search only; strictly forbidden for credential or sensitive inputs.
  - `request_information`: requests host-side filling of private vault variables into form fields. Secrets are injected host-side into the browser via `fill()`, never exposed to the model or chat.
  - `take_note`: captures topic, content, source URL, and a required verbatim evidence quote from the observed public page.
  - `spawn_subagents`: runs parallel, cookie-less evaluator workers (`research` contexts) across candidate URLs without user cookies, credentials, or interaction handles, extracting source-quoted findings.
  - `finish_task`: delivers the final synthesized answer citing recorded evidence.
- **Per-user Settings & Workspace Store**:
  - Added `src/workspace-store.ts` and `platforms/windows/workspace.ps1` providing per-user DPAPI-encrypted storage (`CurrentUser`) in desktop mode and AES-256-GCM encrypted workspace storage in hosted mode.
  - Persists user model settings, navigation policies, permanent memory, variable groups, and research notes without writing secrets to plaintext.
  - Built-in provider presets: OpenAI, Groq, OpenRouter, Ollama, LM Studio, and Custom OpenAI-compatible endpoints.
  - Boundary validation: Hosted mode strictly enforces cloud HTTPS endpoints (local loopback forbidden). Local Desktop mode permits genuine loopback (`localhost`, `127.0.0.1`, `::1`) or cloud HTTPS.
  - Navigation policy: `whitelist` or `blacklist` mode with domain rules (automatically covers subdomains, e.g. `example.com` covers `*.example.com`).
  - Opt-in permanent memory (toggle + editable up to 32 KiB) vs evidence notes (up to 100 notes with verbatim quotes).
  - Variable groups: up to 32 groups (up to 32 variables each) for bulk task-scoped grants.
- **Vault privacy & permissions**:
  - The model receives only variable metadata (`id`, `name`, `description`, `kind`, `scope`, `available`) with known private values redacted (`[private]`). Secret values and ciphertexts never reach the model.
  - Credential variables (`username`, `password`) are strictly site-bound to an exact HTTPS origin. Non-credential variables (`text`, `email`, `tel`, etc.) can be saved as shared profiles.
  - Missing-information dialog: when an unknown field needs data, a local modal dialog allows the user to enter the value privately, optionally save it as a site-bound or shared variable with name and description, or skip it.
  - One-off modal approvals vs task-scoped variable/group direct-fill grants (`workspace-grant`) and revocation (`workspace-revoke` or Stop).
  - In Local Desktop mode, reading vault secrets for field filling enforces native Windows Hello verification.
  - Stop button or follow-up instructions safely abort the active task controller, close the active browser, cancel pending dialogs, clear task grants, and reset preview.
- **Evaluators and purchase protection**:
  - `spawn_subagents` launches parallel evaluator workers (signed-out, cookie-less browser contexts) to independently check candidate URLs and verify findings with verbatim quotes.
  - Sensitive actions require confirmation; source notes contain verified quotes only, not generated interpretations. Final model synthesis remains fallible, and purchase confirmation must be checked by the user.
- **Hosted mode simplified registration & operational limits**:
  - Registration in Hosted Mode operates with lowercase username and strong passphrase (≥12 characters) without requiring an operator invite code by default. Optional operator invite code can be configured via `AUTOMATE_HOSTED_REGISTRATION_KEY`.
  - Host operator and admin processes have access to active process memory and plaintext values. Hosted mode is not zero-knowledge.
  - Redaction bypass transformations: known vault values are redacted host-side in signed-in DOM observations and URLs (`[private]`). Privacy is best-effort against malicious sites that encode or transform secrets (user explicitly accepted redacted signed-in observation over strict public-only).
  - Screenshots are strictly host-rendered owner previews and are never sent to the model.
  - Anything typed in manual chat or saved in permanent memory is sent to the configured model provider. Users must keep secrets out of chat and memory!
  - Persistent volume mounts and backups are required for hosted storage (`%LOCALAPPDATA%\AutoMate\hosted\` or `/data`).
  - Railway trial ended: prior deployment trial on Railway has ended; local desktop mode and self-hosted mode (QuickTunnel or custom reverse proxy) remain active.
- **Model endpoint errors**:
  - Model endpoint errors (e.g. `PLANNER_UNAVAILABLE`, `INVALID_AGENT_RESPONSE`, 404, connection failure) are displayed cleanly in the UI and error banners. No fake fallback or reviewed-command mode exists in the new app.
- **Status and target version**:
  - Version target: `0.2.0-preview.1`; GitHub PR/release status is authoritative. The application-only release target is https://github.com/anujparwal/Auto-Mate/releases/tag/v0.2.0-preview.1.
## Current boundaries that must not regress

- Models receive variable names/descriptions and other bounded metadata by design, but cannot invoke vault reads, ciphertext exports, internal browser handles, owner pixels, or grant APIs. Approval authorizes host insertion, not secret delivery as a model tool.
- Exact HTTPS origins and task/field scope matter. No silent origin migration, invented selectors, automatic authority, or authentication downgrade. Site navigation policy includes subdomains and is not a complete firewall for third-party site resources.
- Normal native vault reads require Windows Hello. Synthetic broker tests use isolated paths/entropy; browser integration fixtures use injected public DNS and independent contexts, not production `.test` bypasses.
- Audit failure stops execution; diagnostics/journals must not expose URLs, private IDs, credential values, tokens, or secret fingerprints.
- Do not claim remote signup/login/payment success from filling alone, universal redaction, hard real-time teardown, signed distribution, or independent security review.
- Public homepage hosting distributes reviewed static marketing files and the labeled simulated film only. It must never expose owner commands, native brokers, application vaults, model keys, or a local vault HTTP port. Public application archives require a separate explicit distribution decision.

## Remaining verification and release gates

- Successful Windows Hello on configured hardware, secure-desktop interaction with the session monitor, and actual lock/disconnect/reconnect transitions.
- Reproducible resolution of the intermittent shared-browser setup cascade, not merely one green rerun.
- End-to-end verification against the actual user-supplied OpenAI-compatible API: valid/unsupported requests, authentication refusal, consent, latency, malformed-output refusal, and cancellation. Hosting and model setup are explicitly outside this task.
- Android UI/biometric/Keystore behavior and browser automation: prior host build/unit/signature checks are not device/runtime proof; no connected device was available.
- Independent security review, supported recovery/export strategy, signed/versioned releases, and site-specific compatibility checks before private credentials or public production recommendations.
- Application source and the first preview release remain private by explicit user choice. The separate homepage is deployed on GitHub Pages HTTPS; custom-domain configuration, application signing/redistribution review, and any later public application distribution remain separate decisions and verification gates.

## Navigation for future work

- `use.md`: operator installation, use, testing, and future static-site deployment.
- `README.md`, `PRODUCT.md`, `CHANGELOG.md`: implementation scope, evidence, product boundaries, chronology.
- `src/autofill-owner.ts`, `ui/autofill.*`: real-site owner surface and Vault controls.
- `src/autofill.ts`, `src/policy.ts`, `src/preview-capture.ts`: discovery/disclosure, authorization, evidence/redaction.
- `src/windows-vault.ts`, `src/vault-record.ts`, `platforms/windows/`: trusted native storage and session lifecycle.
- `src/task-planner.ts`, `docs/model-api.md`: existing bounded model contract and supplied-API connection instructions.
- `tools/setup-windows.ps1`, `tools/build-app.ps1`, `tools/check-app.ps1`, `platforms/windows/launcher/`, `.github/workflows/`: source setup, application-only packaging, extracted-runtime verification, native launcher and Windows CI. The public homepage has its own repository/build/deployment.
- Work on the actual `Auto-Mate` checkout, not an empty temporary synthetic-preview directory. Generated `dist/`, `.local/`, caches, keys, and vaults must stay untracked.

## Conversation sources

Available Auto-Mate session references (for local archive lookup, not public data): `01a18d51-4039` (original vision/security/Windows+Android/repository), `01a19173-5048` (categories/owner approval/audit/history/cancellation), `01a19246-dfe4` (prototype/real-site autofill/Vault/glitch/extension idea), and `01a192d7-965c` (website-only testing, Qwen/Colab/software/docs/PR/public-local architecture). Move-only/empty sessions add no product decisions. Future assistants should update this file when user decisions, evidence, or release gates change—not append unverified claims as completed work.

## Workspace verification handoff

- The user explicitly chose **redacted signed-in observations** instead of a strict cookie-less mirror for the main browser, accepting that hostile sites can transform values to evade known-value matching. Research workers remain signed out; model requests never include preview images.
- Removed unused `src/application-planner.ts` and credential-free `model-config.json`; providers are configured in per-user encrypted Settings.
- Typecheck and the complete 300-test suite passed. A subsequent encoded-value observation-cutoff regression reproduced a real leak, then passed after extending host-side collection before redaction/truncation.
- Actual native UI smoke exercised private unknown-email entry, same-request draft preservation, saved metadata, individual/group direct-fill permission, separate Login approval, two parallel source evaluators, source notes, and masked preview. The labelled local HTTP protocol fixture made eight model requests without either supplied credential value; it was not Qwen or live model inference.
- Streaming conversation remained inside a 1000px-high desktop viewport; the mobile layout fit 390px. Stop remained available after task completion, closed the actual task browser, cleared grants, and removed its preview.
- Native DPAPI/browser smoke and native/hosted encrypted workspace tests passed. Positive Windows Hello hardware verification remains unexercised.
- The prior supplied ngrok model endpoint was offline. A working user-supplied API is still required for live AI inference; there is no fallback model, Colab notebook, or model-hosting setup.
- `/healthz` is a stateless readiness probe. The Linux container uses non-root uid 1000 and keeps Chromium sandboxing enabled; Linux execution remains unverified because this workstation lacks a running Docker daemon. Provider persistent storage and namespace support must be verified before public production use.
- Restarted the real hosted prototype on the updated backend while preserving `%LOCALAPPDATA%/AutoMate/hosted`. Current temporary HTTPS link: https://diagnosis-generator-lyric-champions.trycloudflare.com. The operator laptop and `AutoMateHostedWorkspace` service must remain running; the QuickTunnel URL changes on restart.
- Actual HTTPS browser smoke verified account creation without an operator code, hosted local-model controls disabled, encrypted model-key configuration reported without redisplaying the key, profile-variable creation showing metadata but not its private value, and a deliberately unavailable QA model showing an explicit error with no fallback or fabricated browser result.
- Actual connection-loss smoke disabled Send, closed the private settings dialog and erased its unsaved key; reconnection restored controls from a fresh snapshot. Logout returned `/login` and removed the session cookie. The disposable client was closed; no synthetic model server remains running.
