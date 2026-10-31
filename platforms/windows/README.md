# Auto-Mate Windows Native Encrypted Vault

Security-focused Windows credential adapter for Auto-Mate. Normal operations require a successful Windows Hello verification before vault access. Storage uses local DPAPI `CurrentUser` encryption with a metadata-protecting v2 envelope, cryptographically secure password generation, validated atomic v1 migration, strict cryptographic origin binding, atomic persistence, and restrictive NTFS ACL enforcement.

---

## 1. Security Architecture & Threat Boundaries

### DPAPI vs. Windows Hello (No Fake Biometrics)
- **DPAPI CurrentUser Scope**: Secrets and metadata are encrypted and decrypted using `System.Security.Cryptography.ProtectedData` scoped to `DataProtectionScope.CurrentUser`. Windows derives DPAPI master keys from the logged-in user's credentials (managed via Local Security Authority / LSASS).
- **DPAPI Does NOT Provide Per-Use Windows Hello Prompts**: Once a user logs into Windows, DPAPI unprotect operations execute transparently within the active user session without prompting for biometric/PIN confirmation on every operation. Any application running under the same user identity can request decryption. Claiming that DPAPI provides "Windows Hello biometric authentication" is deceptive and false.
- **Mandatory Application Gate**: Normal broker operations and owner `-Store`, `-Generate`, `-List`, and `-Reveal` operations require an actual successful Windows Hello verification, including before legacy migration. There is no optional authentication switch or reusable approval lease.
- **Desktop Native Verification**: The helper uses `IUserConsentVerifierInterop::RequestVerificationForWindowAsync` with an application-owned window. Only the OS `Verified` result authorizes access; cancellation, timeout, unsupported systems, unavailable hardware, policy denial, and errors fail closed. Availability checks are diagnostic only.
- **Not Cryptographic User-Presence Protection**: This gates Auto-Mate's application paths; it does not change DPAPI's same-user decryption boundary. Another same-user process can bypass application code and invoke DPAPI directly. Positive Windows Hello verification still requires hardware testing.

### Threat Model & AI Agent Boundary
- **CLI is Trusted-Owner Only**: The interactive CLI (`-Store`, `-Generate`, `-List`, `-Reveal`) is designed exclusively for the human system owner. It **MUST NOT** be exposed as a tool to autonomous AI agents or language models.
- **No Secret Read-Access for AI Models**: AI agents are untrusted observers. Exposing a generic "read-secret" tool allows malicious prompts or jailbreaks to exfiltrate stored credentials.
- **Narrow Trusted Broker Boundary (`-Broker`)**:
  - The native vault provides a dedicated stdin/stdout JSON protocol for trusted machine callers (such as the Auto-Mate parent browser executor).
  - For signup flows (`persist-generated`), the native script generates the high-entropy password via CSPRNG, persists it encrypted under DPAPI directly to the vault, and emits the plaintext only to the trusted executor's stdout pipe for direct DOM insertion. The secret never passes through the AI model's context.
  - Secrets are never transmitted as command-line arguments (preventing leakage via process auditing, Event ID 4688, or `Get-Process`).
- **No Secret Fingerprints or Hashes**: The vault deliberately avoids storing or returning secret hashes or fingerprint prefixes (such as truncated SHA-256 digests). Emitting secret fingerprints provides an offline dictionary/guessing oracle that compromises credential privacy.

---

## 2. Cryptographic Design & v2 Envelope

### 1. Version 2 Outer Envelope (Zero Plaintext Metadata at Rest)
The v2 vault on-disk file envelope exposes **ONLY** the schema version and base64 ciphertext:
```json
{
  "version": 2,
  "cipherText": "<base64 DPAPI blob>"
}
```
No origin, username, record ID, timestamps, secrets, or secret digests are exposed in the file on disk.

### 2. Internal Authenticated Vault Payload
The authenticated vault payload is encrypted under DPAPI `CurrentUser` using fixed version-specific public entropy `SHA-256("AutoMate:Vault:Entropy:v2")`:
```json
{
  "version": 2,
  "created": "2026-10-31T12:00:00.000Z",
  "records": [
    {
      "origin": "https://example.com",
      "recordId": "user1",
      "secret": "...",
      "createdAt": "2026-10-31T12:00:00.000Z",
      "updatedAt": "2026-10-31T12:00:00.000Z"
    }
  ]
}
```
Upon retrieval, the requested `origin` and `recordId` are strictly checked against the authenticated inner payload for an exact match.

### 3. Lossless Atomic v1 Migration
Legacy v1 vault files expose plaintext origin, recordId, and timestamps with per-record ciphertexts encrypted under origin entropy `SHA-256("AutoMate:Vault:OriginEntropy:v1:" + origin)`.
After successful Windows Hello verification, loading a supported v1 vault:
1. All records are decrypted and their inner origin and recordId are verified against outer metadata.
2. All `createdAt` and `updatedAt` timestamps and global `created` timestamps are preserved.
3. Duplicate identities are rejected fail-closed.
4. The entire vault is atomically converted and saved to the v2 encrypted envelope.
5. Corrupt or tampered records fail closed immediately, refusing mutation without modifying existing files.
6. Legacy per-record encryption is retired for new writes and retained strictly as a migration decoder.

### 4. CSPRNG Password Generation & Memory Hygiene
- Generated using `[System.Security.Cryptography.RandomNumberGenerator]::Create()` with rejection sampling.
- Sensitive byte arrays and SecureString BSTRs are explicitly cleared with `[System.Array]::Clear` and `Marshal.ZeroFreeBSTR` immediately after use.
- DPAPI v2 decrypts the complete vault inside the trusted native process. Immutable PowerShell/.NET strings cannot be guaranteed zeroized. CLI metadata arguments, terminal output, OS process logs, old backups, file lengths, and filesystem timestamps are outside vault-file encryption.

---

## 3. Filesystem Persistence & Concurrency

- **NTFS Restrictive ACLs**:
  - Vault files and directories are configured with `System.Security.AccessControl.FileSecurity` / `DirectorySecurity`.
  - Inheritance is disabled (`SetAccessRuleProtection($true, $false)`), granting `FullControl` to the current user's SID. This restricts ordinary other-user access; privileged administrators and compromised operating systems are outside this protection.
- **Crash-Consistent Atomic Persistence**:
  - Staged to a unique temporary file (`vault_staging_<guid>.tmp`) with restrictive ACL applied before swap.
  - Atomic swap using `[System.IO.File]::Replace` with `.NET NullString` backup parameter (no plaintext backups created, no copy fallback).
- **Global Mutex Concurrency**:
  - Cross-process concurrency is guarded by a per-user named mutex (`Global\AutoMateVault-<SID>`), ensuring safe read-modify-write across parallel callers.

## 4. Usage & Commands

### Prerequisites
- Windows 11 build 22000 or newer, in an interactive signed-in session with Windows Hello configured for normal vault access. Unsupported or unavailable authentication fails closed.
- Windows PowerShell 5.1 and .NET Framework 4.8. No separate .NET SDK installation is required.
- Node.js / Bun runtime for the parent policy broker

### Owner-Facing CLI Commands

#### 1. Interactive Store
Requires Windows Hello, then prompts for the secret interactively via masked `SecureString` and verifies confirmation:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File platforms/windows/vault.ps1 -Store -Origin "https://github.com" -RecordId "user@example.com"
```

#### 2. Password Generation
Generates high-entropy password (default 24 characters) and DPAPI-encrypts it directly into the vault without printing plaintext to the terminal:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File platforms/windows/vault.ps1 -Generate -Origin "https://github.com" -RecordId "user@example.com" -Length 32
```

#### 3. List Stored Entries
Requires Windows Hello before decrypting and displaying metadata (Origin, Record ID, Timestamps). Never reveals secrets:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File platforms/windows/vault.ps1 -List
```

#### 4. Reveal Secret
Requires Windows Hello and explicit typed confirmation (`YES`) before displaying the secret in the owner terminal:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File platforms/windows/vault.ps1 -Reveal -Origin "https://github.com" -RecordId "user@example.com"
```

---

## 5. Trusted Broker Protocol (`-Broker`)

Invoked by the parent policy broker over stdin/stdout JSON pipes:
```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File platforms/windows/vault.ps1 -Broker [-VaultPath <path>]
```

### Protocol Payloads

#### Action: `persist-generated`
Generates CSPRNG password, DPAPI-encrypts and persists to vault, and returns generated secret to trusted stdout:
- **STDIN**:
  ```json
  {
    "action": "persist-generated",
    "origin": "https://example.com",
    "recordId": "user1",
    "length": 24
  }
  ```
- **STDOUT (Exit 0)**:
  ```json
  {
    "success": true,
    "authentication": "windows-hello",
    "action": "persist-generated",
    "origin": "https://example.com",
    "recordId": "user1",
    "generatedSecret": "..."
  }
  ```

#### Action: `store-secret`
Stores a secret supplied securely via stdin:
- **STDIN**:
  ```json
  {
    "action": "store-secret",
    "origin": "https://example.com",
    "recordId": "user1",
    "secret": "..."
  }
  ```
- **STDOUT (Exit 0)**:
  ```json
  {
    "success": true,
    "authentication": "windows-hello",
    "action": "store-secret",
    "origin": "https://example.com",
    "recordId": "user1"
  }
  ```

#### Action: `retrieve-fill`
Retrieves a secret for trusted DOM autofill strictly matching the origin:
- **STDIN**:
  ```json
  {
    "action": "retrieve-fill",
    "origin": "https://example.com",
    "recordId": "user1"
  }
  ```
- **STDOUT (Exit 0)**:
  ```json
  {
    "success": true,
    "authentication": "windows-hello",
    "action": "retrieve-fill",
    "origin": "https://example.com",
    "recordId": "user1",
    "secret": "..."
  }
  ```

#### Action: `list`
Returns metadata array of records:
- **STDIN**:
  ```json
  {
    "action": "list",
    "origin": "https://example.com"
  }
  ```
- **STDOUT (Exit 0)**:
  ```json
  {
    "success": true,
    "authentication": "windows-hello",
    "action": "list",
    "entries": [
      {
        "origin": "https://example.com",
        "recordId": "user1",
        "createdAt": "2026-10-30T12:00:00.000Z",
        "updatedAt": "2026-10-30T12:00:00.000Z"
      }
    ]
  }
  ```

#### Error Handling (Exit 1)
Any failure emits a sanitized JSON error object without leaking internal exception messages, origin details, or secret values:
```json
{
  "success": false,
  "error": "VAULT_REQUEST_DENIED"
}
```

Authentication denial instead returns exit 1 with `{"success":false,"error":"VAULT_AUTHENTICATION_REQUIRED"}` before reading, creating, migrating, or changing a vault. The trusted TypeScript adapter defaults to this normal authenticated mode and verifies the native authentication context and requested identity before accepting a generated secret.

### Isolated Synthetic Execution

`-Synthetic` exists only for controlled test/demo data. It requires an explicit vault path below a child directory of `%TEMP%\AutoMate-Synthetic\` and `.test` destination origins. It never authenticates a production vault operation.

Synthetic v2 entropy is `SHA-256("AutoMate:Synthetic:Vault:Entropy:v2")`; synthetic v1 fixture entropy is `SHA-256("AutoMate:Synthetic:Vault:OriginEntropy:v1:" + origin)`. These differ from normal vault entropy. Copying a normal v1 or v2 file into the synthetic directory does not make it decryptable through the unauthenticated test path. Successful synthetic broker responses are marked `"authentication":"synthetic-isolated"`, never `"windows-hello"`.

The preview and browser smoke explicitly select this isolated mode. Their success proves synthetic persistence and execution, not a successful biometric/PIN gesture or production credential use. Never enter real credentials into a synthetic fixture.

### Availability Diagnostic

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File platforms/windows/hello.ps1 -CheckAvailability
```

This checks OS availability only; it neither authenticates the user nor accesses the vault. Desktop interop requirements follow Microsoft's [UserConsentVerifier desktop guidance](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier?view=winrt-26100) and [IUserConsentVerifierInterop contract](https://learn.microsoft.com/en-us/windows/win32/api/userconsentverifierinterop/nn-userconsentverifierinterop-iuserconsentverifierinterop).

---

## 6. Verification Smoke Test

Execute the local verification smoke test using isolated synthetic fixtures:
```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File platforms/windows/smoke-test.ps1
```
The smoke verification exercises real native broker persist/read/list APIs using `-Synthetic`; it does not simulate a successful Windows Hello result:
1. Broker `persist-generated` generation, DPAPI persistence, and stdout response.
2. Fresh v2 at-rest metadata and secret absence (envelope exposes ONLY `version` and `cipherText`).
3. Absence of plaintext secrets, origins, or record IDs in on-disk vault files.
4. Restrictive NTFS user ACL application (inheritance disabled).
5. Broker `list` metadata retrieval after native decryption (no secret or fingerprint leaks).
6. Broker `retrieve-fill` success for valid origins.
7. Broker `retrieve-fill` refusal for cross-origin queries (`VAULT_REQUEST_DENIED`).
8. Concurrent encrypted updates and identity preservation across parallel processes.
9. Lossless atomic v1 migration (preserving secret, `createdAt`/`updatedAt` timestamps, and verifying zero plaintext metadata on disk after).
10. Corrupt-v1 operation refusal with zero disk mutation.
11. Tampered-v2 operation refusal with zero disk mutation.
12. Case-sensitive account IDs retain their own passwords without overwriting one another.
13. Unsupported/coerced versions, empty files, non-array collections, and duplicate legacy identities refuse writes without mutating existing data.

Legacy migration validates the origin and identity already bound to each v1 secret. It preserves historical timestamp strings as found; it cannot authenticate v1 metadata that was never protected or erase earlier plaintext copies.
