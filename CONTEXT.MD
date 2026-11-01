# Auto-Mate project context

Consolidated project memory from all available Auto-Mate conversations through the current release-preparation session. This is a maintained context summary, not a verbatim transcript or a claim that every original goal is implemented. It deliberately excludes tokens, private credentials, raw vault data, unrelated command history, and machine-specific session files. It is not included in the public Windows download package.

## Current user decisions — read these first

1. Continue with the **website**, not a browser extension. The earlier extension idea (including automatic file filling) was explicitly superseded. Do not resume extension development or promise arbitrary file autofill.
2. Prioritize testing existing features and fixing demonstrated bugs over adding features. The user repeatedly requests correctness; never translate that into a guarantee of zero bugs or perfect security.
3. The user initially mentioned Qwen3.5-9B hosted on Google Colab, then explicitly clarified: **they will provide an OpenAI-compatible API; do not set up the model**. This later instruction supersedes Colab/model-hosting preparations. Do not download weights, install model-serving software, create notebooks/tunnels, or provision GPUs. Configure and verify the supplied endpoint/model/key when available; no connection details have been supplied yet.
4. Public deployment choice, explicitly selected by the user: **the vault and protected browser stay on each user's Windows PC**. A public static website distributes the source package and instructions. Installation is required; this is not a pure-browser vault or a hosted multi-tenant credential service.
5. Install/verify the software actually needed for supported running/testing. Do not download unrelated GPU/Docker/Android tooling for the Windows website. Never buy cloud compute or change repository visibility without separate authorization.
6. Keep clear usage instructions in `use.md`, conversation decisions in `CONTEXT.MD`, and create a PR containing the work so far. The existing repository is private; publishing a download site later intentionally distributes the packaged source and requires owner review.

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

## Current boundaries that must not regress

- Models cannot access plaintext, ciphertext exports, vault listings, browser handles, owner pixels, or grant APIs. Approval authorizes trusted insertion, not secret delivery to AI.
- Exact HTTPS origins and task/field/category scope matter. No wildcards, silent origin migration, invented selectors, automatic authority, or authentication downgrade.
- Normal native operations require actual OS verification. Synthetic tests are restricted to isolated temporary paths, separate DPAPI entropy, and `.test` origins; they are not a bypass for real domains or normal vaults.
- Audit failure stops execution; diagnostics/journals must not expose URLs, private IDs, credential values, tokens, or secret fingerprints.
- Do not claim remote signup/login/payment success from filling alone, universal redaction, hard real-time teardown, signed distribution, or independent security review.
- Public hosting must distribute only reviewed static files/source. It must not expose `exposeBinding` owner commands, native brokers, a local vault HTTP port, or model keys to remote pages.

## Remaining verification and release gates

- Successful Windows Hello on configured hardware, secure-desktop interaction with the session monitor, and actual lock/disconnect/reconnect transitions.
- Reproducible resolution of the intermittent shared-browser setup cascade, not merely one green rerun.
- End-to-end verification against the actual user-supplied OpenAI-compatible API: valid/unsupported requests, authentication refusal, consent, latency, malformed-output refusal, and cancellation. Hosting and model setup are explicitly outside this task.
- Android UI/biometric/Keystore behavior and browser automation: prior host build/unit/signature checks are not device/runtime proof; no connected device was available.
- Independent security review, supported recovery/export strategy, signed/versioned releases, and site-specific compatibility checks before private credentials or public production recommendations.
- Repository/Pages permissions, hosting account/domain/TLS, redistribution review, and deployment approval. The repo remains private unless the user explicitly changes that choice.

## Navigation for future work

- `use.md`: operator installation, use, testing, and future static-site deployment.
- `README.md`, `PRODUCT.md`, `CHANGELOG.md`: implementation scope, evidence, product boundaries, chronology.
- `src/autofill-owner.ts`, `ui/autofill.*`: real-site owner surface and Vault controls.
- `src/autofill.ts`, `src/policy.ts`, `src/preview-capture.ts`: discovery/disclosure, authorization, evidence/redaction.
- `src/windows-vault.ts`, `src/vault-record.ts`, `platforms/windows/`: trusted native storage and session lifecycle.
- `src/task-planner.ts`, `docs/model-api.md`: existing bounded model contract and supplied-API connection instructions.
- `tools/setup-windows.ps1`, `tools/build-site.ps1`, `.github/workflows/`: installation and release/deployment checks.
- Work on the actual `Auto-Mate` checkout, not an empty temporary synthetic-preview directory. Generated `dist/`, `.local/`, caches, keys, and vaults must stay untracked.

## Conversation sources

Available Auto-Mate session references (for local archive lookup, not public data): `01a18d51-4039` (original vision/security/Windows+Android/repository), `01a19173-5048` (categories/owner approval/audit/history/cancellation), `01a19246-dfe4` (prototype/real-site autofill/Vault/glitch/extension idea), and `01a192d7-965c` (website-only testing, Qwen/Colab/software/docs/PR/public-local architecture). Move-only/empty sessions add no product decisions. Future assistants should update this file when user decisions, evidence, or release gates change—not append unverified claims as completed work.
