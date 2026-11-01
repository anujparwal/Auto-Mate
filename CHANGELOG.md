# Changelog

## Unreleased

- Fixed console-dependent native broker encoding: machine IPC now reads/writes explicit BOM-free UTF-8 without changing console code pages. Corrected the legacy .NET smoke client's inherited UTF-8 BOM and response decoders. A cross-console Unicode credential regression failed before and passed after the repair; a same-code-page roundtrip alone had concealed the corruption.
- Bound native vault cmdlet loading to the executing PowerShell host's built-in modules. Hosted diagnostics showed `Set-Acl` could not load `Microsoft.PowerShell.Security` because inherited cross-runtime type data conflicted; ACL enforcement remains mandatory. The standalone native CI smoke runs under Windows PowerShell, while app tests retain the PowerShell 7 parent to exercise interoperability.
- Fixed an independently reproduced synthetic-vault portability failure caused by different `TEMP`/`TMP` precedence in Node/Bun and native Windows. Synthetic native children now share the adapter's isolated temporary base; normal-mode authentication, path/origin guards, and entropy separation are unchanged. Added a real cross-process DPAPI regression that failed before and passed after the repair.
- Gave the real seven-process Windows vault roundtrip and 4,097-file audit-bound fixture explicit integration-test budgets after hosted runs hit Bun's generic five-second deadline. Assertions, production deadlines, and security refusals are unchanged; no retry or skipped test was added.
- Added `use.md` for installation, website use, safe acceptance checks, supplied-API connection, and future deployment; consolidated project decisions, superseded requests, evidence, and remaining gates in `CONTEXT.MD`.
- Added idempotent Windows x64 prerequisite setup with a digest-verified official Bun download when missing, frozen dependencies, Chromium installation, and optional developer tools, plus hosted Windows verification CI.
- Prepared a static public download site, allowlisted Windows source ZIP/SHA-256 build, and manual-main-only Pages deployment. Each user's vault and protected browser stay on their own PC; no remote vault service, public deployment, signing, or repository-visibility change is implied.
- Documented the existing user-supplied OpenAI-compatible API contract. Per the latest instruction, no Qwen/Colab model setup, weights, GPU provisioning, notebook, or hosting stack is included.
- Verified existing-install setup/check-only behavior, all 171 tests/typecheck, native and browser DPAPI smoke, workflow syntax, public-site desktop/mobile rendering and download integrity, and a fresh extracted-package install/typecheck/smoke. No actual provider API, successful Hello, fresh-machine Bun bootstrap, hosted CI run, or public deployment is claimed by those local checks.

- Fixed Stop/Lock racing with replacement-website teardown: a cancelled inspection cannot open a new protected page after the previous context finishes closing.
- Made pending inspection setup cancellable without waiting for the setup hook, and awaited the original abort-triggered context closure before reporting cancellation. Unsupported cardholder/number/combined-expiry dropdowns are now refused during discovery rather than offered for approval and rejected during filling; numeric month/year dropdown support is unchanged.
- Added a website acceptance checklist with fictitious-data examples, exact expected results, authentication/cancellation/expiry checks, and hardware-verification limits. Chromium smoke checks covered selected-only login filling, card filling with CVV untouched, no submission, masked preview, public-site inspection, and authentication refusal; successful Windows Hello remains unverified.

- Added a separate owner-only Vault column with independent exact-origin login/card entry, native authenticated save/list, owner-only identity selection, and Lock & Stop. Saving or listing never grants website disclosure; models receive neither a vault API nor plaintext/ciphertext exports.
- Replaced live-page screenshot masks and animation/caret manipulation with trusted off-page Sharp redaction, including open-shadow-root controls and whole iframe rectangles. Raw screenshots remain transient host-only data; masked owner pixels are still not universally redacted or model-safe.
- Stabilized real-site preview decoding and layout: identical frames/annotations are retained, in-flight duplicate frames do not starve decoding, and revision/generation guards reject old frames and callbacks after Stop or a new inspection. Lock remains an interruption even with an older inspection revision; late native results cannot restore metadata.
- Verified native encrypted pre-inspection record entry and selected-only retrieval with isolated fictitious `.test` data, actual public-login capture without DOM/style mutations, stale-decode/list races, and desktop/390 px layouts. Normal Windows Hello success remains hardware-unverified.

- Changed `bun start` to open approved real-website autofill, with deterministic labelled-field discovery, exact-origin record selection, initially unchecked field disclosures, active filled-page protection, and no application submission/payment action. Retained the synthetic/model-planning demonstration under `bun start --synthetic`.
- Added typed encrypted login/payment-card records inside the existing DPAPI envelope, normal Windows Hello list/save/read integration, strict CVV/OTP/bank-field exclusion, and bounded native pipes. Preserved existing raw-password reads without silent data migration.
- Added native WTS/input-desktop session monitoring with bounded heartbeat freshness for the real-site launcher; inactive/unavailable sessions remove authority. Added numeric expiry-select filling and visibility proofs for fully visible text inside rectangular overflow containers, without accepting hidden/partially clipped text.
- Verified two actual public HTTPS test forms using only published/fictitious in-memory fixture data, isolated encrypted native record/Unicode roundtrips, and the real normal-vault authentication refusal. Positive Windows Hello and actual OS lock/disconnect behavior remain hardware-unverified; there is no real-data authentication bypass.

- Added `bun start`: owner task entry, trusted execution-plan review, separate category-scoped approval, and the existing live synthetic Windows browser workflow. Default reviewed-command mode works offline and is explicitly not AI inference.
- Added optional bounded local/cloud OpenAI-compatible workflow routing with strict model-output validation, loopback-only local transport, HTTPS cloud configuration, explicit cloud disclosure consent, cancellation, response limits, and no browser/vault/approval model tools.
- Added planner and owner authorization regressions; verified actual reviewed-plan execution through Windows DPAPI and Chromium, invalid model authority/retry/denial against an isolated protocol fixture, and desktop/390 px UI layouts. This synthetic route does not establish real-model inference or production-site safety.

- Added grant-bound cancellation signals and active monotonic expiry timers. Revocation, Stop, destination blocking, reclassification, and audit faults cancel affected executions; expiry is recorded as `grant_expired` without exposing account metadata.
- Made protected browser-context teardown independent of pending navigation, context creation, observer work, and native persistence. Already-started native writes remain awaited for an honest persistence result and are never filled/submitted after cancellation.
- Preserved final owner capture on success, cancelled finished-grant timers, prevented reentrant reclassification from leaving another affected task authorized, and bounded teardown errors without falsely reporting completion.
- Added broker and actual Chromium cancellation regressions; verified real Windows synthetic persistence with delayed acknowledgement and owner Stop/expiry/history behavior.

- Added an owner-only historical audit viewer with read-only session/event pagination, manual active-journal refresh, opaque task correlation, and bounded error/incomplete-tail states; browsing never approves or starts a task.
- Added bounded asynchronous journal snapshots with strict full-file validation, shared writer/reader allowlists, unknown-field/corruption refusal, traversal protection, and explicit file/row/directory limits. Existing independent file/session UUIDs remain supported without changing journal format.
- Added history privacy, pagination, boundary, and live-append regressions. Verified the actual owner UI, including late-response isolation, stale-row clearing, manual error recovery, and 390 px layout.

- Added explicit owner single-task approval/denial with initially unchecked categories, a 1/5/15-minute duration selector, fixed destination/operation disclosure, retry for insufficient category scope, and terminal audit-failure handling.
- Added per-session metadata-minimal durable JSONL audit records and mandatory synchronous broker sinks. Audit failure revokes all grants and permanently locks out the broker; asynchronous sinks cannot silently authorize before persistence.
- Preserved stopped/denied preview states and paused periodic capture across intentional submission navigation to avoid false evidence failures; restored the final completed-page capture.
- Fixed native Windows list/retrieve/reveal results lost inside mutex callback scopes and function-local Hello script resolution under PowerShell strict mode.

- Enforced explicit Yellow/Orange/Red grant scopes against a trusted credential catalog; unknown references and category-mismatched approvals fail closed without consuming task identifiers.
- Added trusted-owner credential reclassification that revokes affected grants, while preserving unrelated grants and keeping same-category assignments unchanged.
- Bound registration preview categories to broker policy, snapshotted reviewed descriptors, and rechecked around native persistence, fills, and submission. Added category-scope and reclassification regressions; completed synthetic Windows DPAPI/Chromium and owner-preview verification.

- Added mandatory desktop Windows Hello application gating for normal native vault operations, including listing and migration; only an actual OS `Verified` result authorizes vault access.
- Separated unauthenticated synthetic browser demos and native fixtures into a temporary `.test`-only namespace with distinct v1/v2 DPAPI entropy and explicit authentication-context responses.
- Made the Windows executor adapter authenticated by default and removed the obsolete optional Hello flag. Successful hardware authentication remains unverified; DPAPI still permits same-user decryption outside Auto-Mate.
- Encrypted Windows vault metadata in a DPAPI v2 envelope and added validated atomic v1 migration with corruption refusal and exact account-identity preservation.
- Added Android v2 authenticated metadata payloads, locked account lists, authenticated identity-aware deletion, and explicit two-prompt legacy upgrades without weakening per-operation key authorization.
- Added native migration/privacy regressions and production Android envelope tests using real JCE ciphers; Android system authentication remains device-unverified.
- Added a Windows-first owner-only live browser preview with deterministic paired request/field annotations, credential-category colors, masked control values, execution activity, and stop handling.
- Replaced selector-only registration fields with typed credential/request/field descriptors. Explicit DOM associations and node identity are checked before secret insertion.
- Added regression coverage for unrelated request text, replaced fields, changed requesting text, and input-mask invariance.
- Kept owner pixels separate from model observations; no remote preview server, Android preview, or AI-provider connection was introduced.

## 0.1.0 — Development

- Introduced task- and origin-bound authorization with expiry, revocation, exact-origin blocking, and submission limits.
- Added protected registration execution through isolated Chromium contexts, with no raw page observations returned after credential use.
- Added native Windows DPAPI persistence and an executor-only generated-password bridge.
- Added a separate Android Keystore vault application; platform build/device verification is required before security claims.
- Added deterministic policy regression tests and a controlled Windows vault-to-browser smoke scenario.

This increment is not a complete autonomous agent. Successful Windows Hello and lifecycle hardware verification, Android device authentication/browser automation, real-model inference verification, broader production-site compatibility, authenticated production approval/process boundaries, OS notifications, and independent security review remain outstanding.
