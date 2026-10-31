# Changelog

## 0.1.0 — Development

- Introduced task- and origin-bound authorization with expiry, revocation, exact-origin blocking, and submission limits.
- Added protected registration execution through isolated Chromium contexts, with no raw page observations returned after credential use.
- Added native Windows DPAPI persistence and an executor-only generated-password bridge.
- Added a separate Android Keystore vault application; platform build/device verification is required before security claims.
- Added deterministic policy regression tests and a controlled Windows vault-to-browser smoke scenario.

This increment is not a complete autonomous agent. Windows Hello gating, Android browser automation, model-provider integration, production approval/dashboard surfaces, persistent audit notifications, and independent security review are not implemented.
