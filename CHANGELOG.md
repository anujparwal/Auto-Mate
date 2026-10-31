# Changelog

## Unreleased

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

This increment is not a complete autonomous agent. Successful Windows Hello hardware verification, Android device authentication/browser automation, model-provider integration, authenticated production approval/dashboard surfaces, OS notifications, and independent security review remain outstanding.
