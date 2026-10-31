# Auto-Mate Android Native Vault

Native security-first Android vault application written in Kotlin, implementing device-bound Android Keystore AES-256-GCM encryption with mandatory user authentication gating via AndroidX `BiometricPrompt` (Strong Biometrics and Device Credential).

## Security Architecture

1. **Device-Bound Android Keystore (AES-256-GCM)**:
   - Master key alias: `AutoMate_Vault_MasterKey` in `AndroidKeyStore`.
   - Key specifications: 256-bit AES, GCM block mode, no padding, randomized encryption.
   - Strict user authentication enforcement: Keys are generated requiring per-operation user authentication (`setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG or AUTH_DEVICE_CREDENTIAL)` on API 30+; `setUserAuthenticationValidityDurationSeconds(-1)` on API 28-29).
   - Fail-closed key policy validation: If an existing key lacks required user authentication, it is rejected immediately with a `SecurityException`.
   - Security assurance reporting accurately distinguishes between hardware-backed (TEE / StrongBox) and software-emulated keymaster.

2. **Additional Authenticated Data (AAD) Cryptographic Binding**:
   - Each credential record binds its unique UUID and exact normalized HTTPS origin into the AES-GCM tag calculation using `cipher.updateAAD(aadBytes)`.
   - Format: `AutoMate:v1:id=${recordId}:origin=${normalizedOrigin}`.
   - Prevents ciphertext or metadata swapping attacks: Any alteration or re-association of ciphertext with a different origin or ID causes an `AEADBadTagException` during decryption.

3. **Origin-Bound Credential Policy**:
   - Credentials are bound strictly to canonical HTTPS origins (`https://<host>[:<port>]`).
   - Subpaths, URL queries, URL fragments, embedded user credentials, and unencrypted HTTP schemes are rejected at validation time.

4. **Cryptographic Password Generation**:
   - Uses `java.security.SecureRandom` to generate unbiased, high-entropy passwords with guaranteed character diversity (uppercase, lowercase, digits, symbols).
   - In-memory character arrays are zeroized (`Arrays.fill(..., '\0')`) immediately after use.

5. **Storage Persistence & Backup Disabling**:
   - Stored in `context.noBackupFilesDir` under `vault_records.json`.
   - `android:allowBackup="false"` and `android:fullBackupContent="@xml/backup_rules"`.
   - Android 12+ `data_extraction_rules.xml` excludes cloud backup and device transfer.
   - Zero internet access: strictly NO `android.permission.INTERNET` requested.
   - `AtomicFile` write pipeline with automatic `.bak` recovery on interrupted writes.
   - Fail-closed storage error handling: Throws `VaultStorageException` on disk read/parse corruption and disables write operations to prevent silent vault overwrite.

6. **Application Lifecycle & UI Hardening**:
   - `WindowManager.LayoutParams.FLAG_SECURE` enforced to prevent screenshots and task switcher previews.
   - Biometric authentication cancellation (`ERROR_USER_CANCELED`, `ERROR_NEGATIVE_BUTTON`, `ERROR_CANCELED`) handled cleanly without leaking state.
   - Decrypted secrets are displayed in an ephemeral view with a 30-second auto-clear countdown timer.
   - Application-owned plaintext character arrays are cleared on backgrounding, dialog dismissal, or timer expiration. Android widgets, clipboard contents, and immutable strings cannot be guaranteed zeroized.
   - Clipboard copies on Android 13+ set `ClipDescription.EXTRA_IS_SENSITIVE = true` to suppress clipboard overlays.
   - Secrets and raw key material are never logged.

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
   - Android SDK Command-line tools can be downloaded from:
     `https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip`

3. **Android Device / Emulator**:
   - Physical device or Android Emulator running Android 9.0+ (API 28+), recommended Android 14/15 (API 34/35).
   - Secure lock screen (PIN, Pattern, or Password) and/or enrolled Biometrics (Fingerprint / Face) required for hardware-authenticated key operations.

## Build and Run Commands

Run all commands from `platforms/android`:

### Gradle Wrapper Verification
```bash
gradlew.bat -v
# or on Linux/macOS:
./gradlew -v
```

### Dependency Resolution & Tasks
```bash
gradlew.bat tasks
```

### Build from the repository root on Windows
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build-android.ps1
```
The launcher honors `JAVA_HOME` and `ANDROID_HOME`, or uses the project-local `.local/jdk21` and `.local/android-sdk` installations when available.

### Assemble Debug APK
```bash
gradlew.bat assembleDebug
```
Output artifact: `app/build/outputs/apk/debug/app-debug.apk`

### Install and Launch
```bash
# Install to connected device or emulator
adb install -r app/build/outputs/apk/debug/app-debug.apk

# Launch MainActivity
adb shell am start -n com.automate.vault/.ui.MainActivity
```

## Verification status

`assembleDebug` succeeded with Gradle 8.9, Eclipse Temurin JDK 21, and the Android API 35 SDK. The APK signature verifies using v2 signing. Packaged permissions contain biometric permissions but no `INTERNET` permission.

No Android device or emulator was attached during implementation. Authentication, Keystore encryption/decryption, backgrounding behavior, and visual layout remain device-unverified. Android 9–10 support uses strong biometrics only; device-credential fallback is configured for Android 11+.

This development vault encrypts passwords, not its username/origin metadata. Do not store real identities or credentials until metadata protection and device verification are complete.
