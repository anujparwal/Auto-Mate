# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

This record scopes the owner-only Windows browser-preview surface. Auto-Mate as a product targets Windows and Android; the user explicitly selected Windows preview first. Android preview is deferred, not represented as implemented.

## Users

The local machine owner supervising credential-bearing browser tasks.

## Product Purpose

Show what the executor is doing, which webpage text requests which field, and what configured credential category is involved. The AI must not receive secrets or the owner preview.

## Operating Context

Existing Bun/TypeScript broker and Playwright executor on Windows. Native DPAPI storage. The current executable workflow is a synthetic registration demonstration; no AI provider is connected.

## Capabilities and Constraints

- Deterministic code validates text-to-field relationships and draws paired, numbered highlights.
- Yellow, Orange, and Red are user-requested credential secrecy categories. Trusted configuration assigns them; registration rejects labels that disagree with the broker catalog, and credential use requires explicit category-scoped authorization. Category editing/persistence UI and Android category policy remain unimplemented.
- The owner must explicitly approve categories and a 1/5/15-minute single-task duration or deny before worker navigation. This synthetic approval does not bypass native authentication or open a blanket auto-approval window.
- Broker authorization events persist with opaque session/task tokens and no raw account identities; an audit write failure prevents further credential use. The read-only historical viewer supports paginated sessions/events, incomplete-tail warnings, strict corruption refusal, and explicit live refresh without granting execution authority. OS notifications remain unimplemented.
- Active grant expiry and revocation promptly request protected-browser closure even during pending work. Already-started native persistence remains awaited and may complete after cancellation; this is not OS session-lock enforcement or rollback.
- Association evidence is DOM structure, not proof that a website is trustworthy or its request is legitimate.
- Owner-only frames are not a model-safe redaction channel. Never expose them to AI tools.
- Show explicit execution states and unverified associations; never use color as the only explanation.
- No remote preview server, Android pairing, or live Android execution in this increment.

## Evidence on Hand

`tools/smoke.ts` exercises actual DPAPI persistence, Chromium against intercepted synthetic HTTPS pages, and strict history-reader roundtrip. Actual owner history browsing, error recovery, read-only behavior, and live refresh were exercised with isolated synthetic journals. Cancellation was exercised during held navigation and a delayed acknowledgement from real synthetic Windows persistence; owner Stop and active-expiry states were also observed in Chromium. No production website or customer claims exist.

## Product Principles

- Authorization stays outside the model.
- Unsupported or changed evidence fails closed before credential use.
- The observer must not create an alternate AI observation path.
- Demonstrations and limitations are labelled honestly.
