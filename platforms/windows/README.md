# Auto-Mate Windows Native Encrypted Vault

Security-focused Windows credential adapter for Auto-Mate. Provides local DPAPI `CurrentUser` encrypted storage, cryptographically secure password generation, strict cryptographic origin binding, atomic persistence, and restrictive NTFS ACL enforcement.

---

## 1. Security Architecture & Threat Boundaries

### DPAPI vs. Windows Hello (No Fake Biometrics)
- **DPAPI CurrentUser Scope**: Secrets are encrypted and decrypted using `System.Security.Cryptography.ProtectedData` scoped to `DataProtectionScope.CurrentUser`. Windows derives DPAPI master keys from the logged-in user's credentials (managed via Local Security Authority / LSASS).
- **DPAPI Does NOT Provide Per-Use Windows Hello Prompts**: Once a user logs into Windows, DPAPI unprotect operations execute transparently within the active user session without prompting for biometric/PIN confirmation on every operation. Any application running under the same user identity can request decryption. Claiming that DPAPI provides "Windows Hello biometric authentication" is deceptive and false.
- **Windows Hello Not Implemented**: `-RequireHello` always refuses execution. Checking whether Hello hardware is available is not authentication. No biometric-gated Windows credential use is claimed.

### Threat Model & AI Agent Boundary
- **CLI is Trusted-Owner Only**: The interactive CLI (`-Store`, `-Generate`, `-List`, `-Reveal`) is designed exclusively for the human system owner. It **MUST NOT** be exposed as a tool to autonomous AI agents or language models.
- **No Secret Read-Access for AI Models**: AI agents are untrusted observers. Exposing a generic "read-secret" tool allows malicious prompts or jailbreaks to exfiltrate stored credentials.
- **Narrow Trusted Broker Boundary (`-Broker`)**:
  - The native vault provides a dedicated stdin/stdout JSON protocol for trusted machine callers (such as the Auto-Mate parent browser executor).
  - For signup flows (`persist-generated`), the native script generates the high-entropy password via CSPRNG, persists it encrypted under DPAPI directly to the vault, and emits the plaintext only to the trusted executor's stdout pipe for direct DOM insertion. The secret never passes through the AI model's context.
  - Secrets are never transmitted as command-line arguments (preventing leakage via process auditing, Event ID 4688, or `Get-Process`).
- **No Secret Fingerprints**: The vault deliberately avoids storing or returning secret hashes or fingerprint prefixes (such as truncated SHA-256 digests). Emitting secret fingerprints provides an offline dictionary/guessing oracle that compromises credential privacy.

---

## 2. Cryptographic Design

1. **Origin Binding Entropy**:
   - Every stored entry is cryptographically bound to a canonical origin (e.g. `https://github.com`).
   - The DPAPI `optionalEntropy` parameter is derived from SHA-256 of the canonical origin string (`AutoMate:Vault:OriginEntropy:v1:<canonical-origin>`).
   - Even if an attacker tampers with vault storage or attempts cross-origin retrieval, DPAPI decryption fails cryptographically at the OS level due to entropy mismatch.
   - Decrypted payloads additionally verify origin and record ID integrity before delivery.
2. **CSPRNG Password Generation**:
   - Uses `[System.Security.Cryptography.RandomNumberGenerator]::Create()`.
   - Generates unbiased characters with rejection sampling across uppercase, lowercase, numeric, and symbol character sets.
   - Uniform Fisher-Yates array shuffling ensures maximum entropy without bias.
3. **Memory Hygiene**:
   - Sensitive intermediate byte arrays and SecureString BSTRs are explicitly cleared with `[System.Array]::Clear` and `Marshal.ZeroFreeBSTR` immediately after cryptographic operations.

---

## 3. Filesystem Persistence & Restrictive ACL

- **NTFS Restrictive ACLs**:
  - Vault files and directories are configured with `System.Security.AccessControl.FileSecurity` / `DirectorySecurity`.
  - Inheritance is disabled (`SetAccessRuleProtection($true, $false)`), and all access rules are stripped except for `FullControl` granted exclusively to the current user's SID (`[WindowsIdentity]::GetCurrent().User`). Other accounts on the machine cannot read or tamper with the vault.
- **Crash-Consistent Atomic Persistence**:
  - Writes are staged into a unique temporary file (`vault_staging_<guid>.tmp`).
  - Restrictive ACLs are applied to the temporary file before commit.
  - The file is atomically swapped into place using `[System.IO.File]::Replace` on NTFS, preventing corrupted files during unexpected termination.

---

## 4. Usage & Commands

### Prerequisites
- Windows 10 / Windows 11 / Windows Server 2016+
- PowerShell 5.1 (built into Windows) or PowerShell 7+ (`pwsh`)
- Node.js / Bun runtime for the parent policy broker

### Owner-Facing CLI Commands

#### 1. Interactive Store
Prompts for secret interactively via masked `SecureString` and verifies confirmation:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File platforms/windows/vault.ps1 -Store -Origin "https://github.com" -RecordId "user@example.com"
```

#### 2. Password Generation
Generates high-entropy password (default 24 characters) and DPAPI-encrypts it directly into the vault without printing plaintext to the terminal:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File platforms/windows/vault.ps1 -Generate -Origin "https://github.com" -RecordId "user@example.com" -Length 32
```

#### 3. List Stored Entries
Displays metadata only (Origin, Record ID, Timestamps). Never reveals secrets:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File platforms/windows/vault.ps1 -List
```

#### 4. Reveal Secret
Requires explicit typed confirmation (`YES`) before decrypting secret to the owner terminal:
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
Any failure emits a JSON error object without leaking secret values or stack traces:
```json
{
  "success": false,
  "error": "Sanitized error description"
}
```

---

## 6. Verification Smoke Test

Execute the local verification smoke test in an isolated temporary vault:
```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File platforms/windows/smoke-test.ps1
```
The test verifies:
1. DPAPI CurrentUser roundtrip encryption and decryption with origin entropy.
2. Cryptographic origin binding rejection with mismatched entropy.
3. Broker `persist-generated` generation, DPAPI persistence, and stdout response.
4. Absence of plaintext secrets in on-disk vault files.
5. Restrictive NTFS user ACL application.
6. Broker `retrieve-fill` success for valid origins.
7. Broker `retrieve-fill` refusal for cross-origin queries.
8. Broker `list` metadata hygiene (no secrets or fingerprints).
