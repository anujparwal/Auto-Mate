# Auto-Mate Android Native Vault

Native security-first Android vault application written in Kotlin, implementing device-bound Android Keystore AES-256-GCM encryption with mandatory user authentication gating via AndroidX `BiometricPrompt` (Strong Biometrics and Device Credential).

## Security Architecture

1. **Device-Bound Android Keystore (AES-256-GCM)**:
   - Master key alias: `AutoMate_Vault_MasterKey` in `AndroidKeyStore`.
   - Key specifications: 256-bit AES, GCM block mode, no padding, randomized encryption.
   - Strict user authentication enforcement: Keys are generated requiring per-operation user authentication (`setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG or AUTH_DEVICE_CREDENTIAL)` on API 30+; `setUserAuthenticationValidityDurationSeconds(-1)` on API 28-29).
   - Fail-closed key policy validation: If an existing key lacks required user authentication, it is rejected immediately with a `SecurityException`.
   - Security assurance reporting accurately distinguishes between hardware-backed (TEE / StrongBox) and software-emulated keymaster.

2. **v2 Hardened Encrypted Metadata Envelopes**:
   - v2 records expose **ONLY** random opaque record ID, schema version (2), 12-byte IV, and ciphertext.
   - All sensitive metadata (origin, username, creation timestamp, update timestamp) and secret password are authenticated and encrypted inside the AES-GCM ciphertext payload.
   - No origin, account label, timestamp, or secret hash is visible outside the encrypted blob.
   - Additional Authenticated Data (AAD) format for v2: `AutoMate:v2:id=${recordId}:version=2`.
   - Inner payload authentication on decrypt: Inner record ID is verified against envelope ID; inner origin is strictly validated against canonical HTTPS policy. Tampering causes immediate authentication failure or `SecurityException`.

3. **Legacy v1 Support & Explicit Owner-Triggered Upgrade**:
   - Legacy v1 records contain plaintext metadata on disk (origin, username, timestamps) and password ciphertext bound to origin AAD (`AutoMate:v1:id=${recordId}:origin=${origin}`).
   - Unmigrated legacy records are explicitly marked as legacy in storage and in the UI. Metadata encryption is **never** claimed for unmigrated v1 records.
   - Upgrading requires an explicit owner-triggered **two-prompt authenticated migration**:
     1. **Prompt 1 (Authenticated Decrypt)**: Gated decrypt of legacy secret via BiometricPrompt using v1 origin-bound AAD.
     2. **Prompt 2 (Authenticated Encrypt)**: Gated encrypt of full metadata payload into v2 envelope via BiometricPrompt using v2 version-bound AAD.
   - Strict per-operation auth policy is preserved without weakening auth windows or using ungated intermediate metadata keys.
   - Atomic replacement: The legacy record remains untouched on disk until step 2 encryption and atomic write succeed. Cancellation or failure in either prompt wipes memory and preserves the original legacy record.

4. **Locked Metadata UI & Privacy Protection**:
   - The vault list displays locked, opaque records showing only truncated record IDs and security badges. Plaintext origin, username, and timestamps are hidden from locked cards.
   - Sensitive inputs and revealed widgets disable automatic view-state saving and autofill with `android:saveEnabled="false"` and `android:importantForAutofill="no"`. This does not control independent OS/keyboard/history mechanisms.
   - Decrypted password arrays are explicitly cleared and sensitive dialogs dismissed on close/background/cancellation. Metadata and JSON strings are immutable managed objects and cannot be guaranteed zeroized.
   - `authenticationEpoch` advances on backgrounding and new authentication actions, invalidating older callbacks before they can persist or display data.
   - Authenticated deletion: Deleting a record requires biometric authentication before presenting identity-specific confirmation, preventing metadata discovery via delete prompts.

5. **Origin-Bound Credential Policy**:
   - Credentials are bound strictly to canonical HTTPS origins (`https://<host>[:<port>]`).
   - Subpaths, URL queries, URL fragments, embedded user credentials, and unencrypted HTTP schemes are rejected at validation time.

6. **Cryptographic Password Generation**:
   - Uses `java.security.SecureRandom` to generate unbiased, high-entropy passwords with guaranteed character diversity.
   - In-memory character arrays are zeroized (`Arrays.fill(..., '\0')`) immediately after use.

7. **Storage Persistence & Backup Disabling**:
   - Stored in `context.noBackupFilesDir` under `vault_records.json`.
   - `android:allowBackup="false"` and `android:fullBackupContent="@xml/backup_rules"`.
   - Android 12+ `data_extraction_rules.xml` excludes cloud backup and device transfer.
   - Zero internet access: strictly NO `android.permission.INTERNET` requested.
   - `AtomicFile` write pipeline with automatic `.bak` recovery on interrupted writes.
   - Fail-closed storage error handling: Throws `VaultStorageException` on disk read/parse corruption, empty/truncated files, duplicate record IDs, or schema violations, and disables write operations to prevent silent vault overwrite.

8. **Application Lifecycle & UI Hardening**:
   - `WindowManager.LayoutParams.FLAG_SECURE` enforced to prevent screenshots and task switcher previews.
   - Biometric authentication cancellation (`ERROR_USER_CANCELED`, `ERROR_NEGATIVE_BUTTON`, `ERROR_CANCELED`) handled cleanly without leaking state.
   - Clipboard copies on Android 13+ set `ClipDescription.EXTRA_IS_SENSITIVE = true` to suppress clipboard overlays.
   - Protection scope: Cryptographic protection covers vault files on disk. OS history, clipboard managers on legacy Android versions, immutable String garbage collection windows, and old unmigrated backup copies are outside application control.

## Build Prerequisites

1. **Java Development Kit (JDK)**:
   - Use JDK 17 or 21 with the pinned Gradle 8.9 / Android Gradle Plugin 8.7.2 toolchain.
   - Configure `JAVA_HOME`. No machine-specific JDK path is committed.

2. **Android SDK**:
   - Location: `ANDROID_HOME` or `ANDROID_SDK_ROOT` (e.g. `C:\Users\Anuj parwal\AppData\Local\Android\Sdk`).
   - Required components:
     - `platforms;android-35` (Android 15 SDK Platform)
     - `build-tools;35.0.0`
     - `platform-tools`
     - `cmdline-tools;latest`

3. **Android Device / Emulator**:
   - Physical device or Android Emulator running Android 9.0+ (API 28+), recommended Android 14/15 (API 34/35).
   - Secure lock screen (PIN, Pattern, or Password) and/or enrolled Biometrics (Fingerprint / Face) required for hardware-authenticated key operations.

## Build and Test Commands

Run all commands from `platforms/android`:

### Gradle Wrapper Verification
```bash
gradlew.bat -v
# or on Linux/macOS:
./gradlew -v
```

### Unit Tests (Pure JVM)
Executes pure JVM unit tests for payload codec, JCE AES-GCM encryption/decryption, AAD tampering detection, inner ID mismatch rejection, origin policy enforcement, strict envelope parsing, and zeroization:
```bash
gradlew.bat testDebugUnitTest
```

### Assemble Debug APK
```bash
gradlew.bat assembleDebug
```
Output artifact: `app/build/outputs/apk/debug/app-debug.apk`

### Combined Build and Unit Test from Repository Root (PowerShell)
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& ./tools/build-android.ps1 -Task assembleDebug,testDebugUnitTest"
```

## Device Smoke Verification Steps

To verify hardware-authenticated Keystore operations and BiometricPrompt flows on a connected device or emulator (API 28+):

1. **Prerequisites on Device**:
   - Ensure a secure lock screen (PIN, pattern, or password) is set in Android Settings > Security.
   - Enroll at least one fingerprint or biometric credential.

2. **Install and Launch**:
   ```bash
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   adb shell am start -n com.automate.vault/.ui.MainActivity
   ```

3. **Verify Security Status**:
   - Status banner should display: `Hardware-Backed (TEE/StrongBox) Keystore Active • Auth-Gated` (or Software Keystore Active if running on an emulator without TEE).

4. **Verify Credential Creation (v2 Encrypted Metadata)**:
   - Tap `+` FAB.
   - Enter origin: `https://login.example.com`, username: `testuser@example.com`, and password (or tap Generate).
   - Tap Save.
   - BiometricPrompt appears: `Authenticate to Store Credential`.
   - Authenticate with fingerprint or lock screen PIN.
   - Locked list displays new item: `Encrypted Credential (xxxxxx)` with `v2 Envelope • Biometric Gated`. Origin, username, and timestamp are **not** visible.

5. **Verify Reveal Flow**:
   - Tap `Reveal` on the locked card.
   - BiometricPrompt appears: `Authenticate to Reveal Credential`.
   - Authenticate: Dialog opens showing decrypted origin, username, and password.
   - 30-second progress bar counts down. Tap Copy to copy securely with sensitive flag.
   - Tap Close or wait 30 seconds: view clears and password character array is zeroized.

6. **Verify Backgrounding & Lifecycle Guard**:
   - Tap `Reveal`, authenticate so the dialog is visible.
   - Press device Home button or switch tasks.
   - Bring the app back: Dialog is dismissed; application-owned password arrays were cleared. This is not a claim that every managed String copy was zeroized.
   - Repeat during the Create flow: form fields and pending passwords are wiped.

7. **Verify Authenticated Delete**:
   - Tap `Delete` on a credential card.
   - BiometricPrompt appears: `Authenticate to Delete`.
   - Authenticate: Confirmation dialog appears showing `Permanently delete credential for https://... (user)?`.
   - Tap Delete: Item is removed from the vault.

8. **Verify Legacy Upgrade (Two-Prompt Migration)**:
   - If a legacy v1 fixture is present, the card shows `Legacy Credential (xxxxxx)` with an `Upgrade to v2` button.
   - Tap `Upgrade to v2`.
   - Prompt 1 appears: `Upgrade to v2 (Step 1 of 2): Authenticate to decrypt legacy credential`. Authenticate.
   - Prompt 2 appears: `Upgrade to v2 (Step 2 of 2): Authenticate to encrypt into v2 metadata envelope`. Authenticate.
   - Success message is displayed. Card transitions to `Encrypted Credential (xxxxxx)` with `v2 Envelope`. The legacy unencrypted record on disk is atomically replaced with the v2 envelope.
   - Cancelling either prompt leaves the legacy record intact.

## Verification Status

- **Toolchain**: Pinned Gradle 8.9 wrapper, Eclipse Temurin JDK 21, Android API 35 SDK.
- **Pure JVM Codec & Logic Verification**: `testDebugUnitTest` covers:
  - `CredentialRecordTest`: strict v2 envelope fields/types/sizes and opaque identity, rejection of exposed metadata, and an original unversioned v1 fixture preserving identity and timestamps.
  - `VaultPayloadCodecTest`: the same production `encrypt`/`decrypt` operations used by the app, supplied with real JCE ciphers; Unicode metadata/password recovery, moved-identity/ciphertext tamper refusal, strict inner-payload validation, array wiping, and metadata/password-safe diagnostic output.
  - `OriginValidatorTest` & `PasswordGeneratorTest`: canonical HTTPS origin validation and secure random password generation with diversity guarantees.
- **Hardware Keystore & Biometric Device Operations**: Device-unverified at implementation time (no physical Android device or active emulator attached during development). Real Android Keystore user-authenticated key gating, TEE backing, and BiometricPrompt system dialogs require hardware smoke execution per the instructions above.

The combined APK build and eleven JVM tests passed on the host. No Android device/emulator was attached; locked-list rendering, two-prompt upgrade/cancellation, system credential fallback, and lifecycle behavior still need native runtime verification. Use synthetic credentials for those checks.

Existing legacy username/timestamp fields were not all authenticated by v1. Upgrading seals the values present; it cannot establish their pre-upgrade authenticity or erase old backups/filesystem history. Noncanonical or unexpected record formats fail closed rather than being silently rewritten.
