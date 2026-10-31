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
- Broker authorization events persist with opaque session/task tokens and no raw account identities; an audit write failure prevents further credential use. Historical audit viewing and OS notifications remain unimplemented.
- Association evidence is DOM structure, not proof that a website is trustworthy or its request is legitimate.
- Owner-only frames are not a model-safe redaction channel. Never expose them to AI tools.
- Show explicit execution states and unverified associations; never use color as the only explanation.
- No remote preview server, Android pairing, or live Android execution in this increment.

## Evidence on Hand

`tools/smoke.ts` exercises actual DPAPI persistence and Chromium against intercepted synthetic HTTPS pages. No production website or customer claims exist.

## Product Principles

- Authorization stays outside the model.
- Unsupported or changed evidence fails closed before credential use.
- The observer must not create an alternate AI observation path.
- Demonstrations and limitations are labelled honestly.
