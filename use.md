# How to use Auto-Mate

## 1. What this tool does

Auto-Mate opens an owner-only website in a local Chromium window on **your Windows PC**. It lets you save encrypted Login or Payment card records, inspect a supported HTTPS website without reading the vault, and explicitly approve individual fields for filling.

**Development preview: use fictitious data and public test forms only.** It is not a production password manager, a general autonomous agent, or a guarantee of perfect security. The app never clicks Login, Pay, or Submit in real-site autofill. Filling itself gives those values to the receiving website and its scripts; Stop cannot undo that disclosure.

The public [homepage and simulated product film](https://github.com/anujparwal/Auto-Mate-homepage) are separate from the working application. The first Windows preview release is **private**. Its application archive contains no marketing homepage or demo film. Vault storage, Windows Hello, approval, and the protected browser run on each user's PC. There is no extension, public vault server, or cross-user credential service.

## 2. Install the Windows application

Supported platform: **Windows 11 x64, build 22000+**, with the included Windows PowerShell 5.1 and .NET/DPAPI components. The portable application bundles Bun, its runtime dependencies, and Playwright Chromium; an application user does **not** need to install Bun, Node, npm packages, Docker, GPU software, or a local model.

### From the private preview release

1. Sign in with repository access and open [v0.1.0-preview.2](https://github.com/anujparwal/Auto-Mate/releases/tag/v0.1.0-preview.2). The public homepage does not offer a public app download.
2. Download `Auto-Mate-0.1.0-preview.2-windows-x64.zip` and `SHA256SUMS.txt` from that release.
3. Run `Get-FileHash .\Auto-Mate-0.1.0-preview.2-windows-x64.zip -Algorithm SHA256` and compare the complete hash with the matching checksum entry. Integrity is not publisher identity: this is an **unsigned private preview**, not a signed production installer.
4. Extract the complete ZIP into a **short path** in a folder you control, for example `%LOCALAPPDATA%\AM-preview`. Windows PowerShell's ZIP extraction can fail when a resulting path exceeds its legacy path limit. Keep `Auto-Mate.exe` and its bundled files together; do not run it from inside the archive.
5. In the extracted `Auto-Mate-0.1.0-preview.2-windows-x64` folder, run the bundled check:

   ```powershell
   $check = Start-Process -FilePath .\Auto-Mate.exe -ArgumentList '--check' -Wait -PassThru
   $check.ExitCode
   ```

   It must exit `0`; a synthetic runtime check is not proof of successful Windows Hello. No normal vault authentication is bypassed.
6. Double-click `Auto-Mate.exe` to open the actual owner application. Windows may warn about an unsigned download. Establish the trusted source and checksum; do not disable SmartScreen, antivirus, or an organization's policy.

This is a portable application, not a machine-wide installer. The homepage, film, developer conversation memory, and source-site deployment tooling are not part of its release archive. A clean Windows machine and downloaded-file security behavior still require separate acceptance checks.

### For contributors using a repository checkout

Source development additionally requires **Bun 1.4.4+**. From the repository root:

```powershell
powershell.exe -NoProfile -File .\tools\setup-windows.ps1
powershell.exe -NoProfile -File .\tools\setup-windows.ps1 -CheckOnly
```

Setup preserves existing installations, digest-verifies the pinned official Bun download when missing, installs locked dependencies and Chromium, and supports `-DeveloperTools` for missing Git/GitHub CLI. Those setup tools are not prerequisites for the bundled end-user application. No model hosting is installed.

## 3. Open the owner application

Portable release: double-click `Auto-Mate.exe`. Keep any application console window open while using it.

Repository checkout:

```powershell
bun start
```

Keep that development terminal open. Auto-Mate opens its own Chromium window automatically. Do not type the internal `*.auto-mate.invalid` URL into a normal browser: application assets and commands are bound to the browser instance launched by Auto-Mate, not a public HTTP listener.

The **Vault** column is for owner entry/listing. The website column is for inspection and field disclosure. The live preview is an image for observation; type into the owner's controls, not the preview image. The separate protected browser shows the actual receiving page.

## 4. Configure and verify Windows Hello

Open **Windows Settings → Accounts → Sign-in options** and configure an available Windows Hello method. Normal record save, identity list, and retrieval each require successful OS verification. Selecting fields is separate from authenticating.

If Hello is unavailable, cancelled, times out, or fails, the operation must be refused. There is no fallback password mode or authentication bypass. Successful Hello remains unverified on the development machine; a displayed refusal is not a successful vault test. Workstation/secure-desktop monitoring must also be checked on your hardware before private data is used.

## 5. Save a test record independently of any website

For a safe first Login test:

| Vault input | Fictitious example |
| --- | --- |
| Allowed HTTPS origin | `https://the-internet.herokuapp.com` |
| Record type | Login |
| Record ID | A new ID, e.g. `qa-login-20261031` |
| Username / email | `qa-user` |
| Password | `Fictitious-only-123!` |

The allowed origin has **no path, query, fragment, or embedded username/password**. Scheme, host, subdomain, and port are significant. A record for one origin is not reusable on a different origin.

Click **Authenticate & save encrypted record** and complete Hello. Draft values clear when sent, including when authentication fails; only a native success acknowledgement means storage succeeded. Saving does not open a website, select disclosures, or grant authority. **Reusing an ID for the same origin replaces that record**; use new IDs for testing.

Click **Authenticate & list IDs** for that origin to view owner-only record identities. Listing reveals no stored secret values and does not approve filling. The list is not a record-type catalog; select the correct Login/Payment card type yourself.

## 6. Inspect and approve a Login disclosure

1. Click **Public login test**, then **Inspect website**. Alternatively enter the full page URL `https://the-internet.herokuapp.com/login` with record type Login.
2. Verify the exact destination, quoted requesting text, and paired field marks. Inspection must not prompt for vault authentication or fill anything. All disclosure checkboxes start unchecked.
3. Enter the saved Record ID in the website approval section. Or choose it in the matching Vault origin/type and click **Use this ID for website approval**. ID selection alone approves nothing.
4. First check **Username / email only**. Choose a **1 minute** protected-page lifetime, then click **Approve selected fields & authenticate**.
5. Complete Hello. In the protected browser, Username should become `qa-user`; Password must remain empty. The app must not click Login or claim login success. The owner preview masks input values.
6. Click Stop, inspect afresh, and repeat with both fields checked to test full Login disclosure. These fictitious values are for filling tests, not successful authentication to the target service.

Supported controls require deterministic, visible label evidence. Ambiguous, replaced, clipped, embedded, or unsupported fields are omitted or refused. SSO, CAPTCHA, MFA, cross-origin payment frames, and arbitrary multi-step navigation are not bypassed. Some sites cannot function under exact-origin resource isolation.

## 7. Test a Payment card without making a payment

Save a new Payment card record for `https://autofill.me`, with name `QA User`, number `4111111111111111`, expiry month `12`, and year `2030`. This is a published test number, not a real account. Never use a real card in these development checks.

Click **Public card test** to select `https://autofill.me/form/credit-card-simple`, inspect as Payment card, select your new ID, and check the fields you approve. After Hello, only those supported fields should fill. Numeric month/year dropdowns are supported; card-name/number/combined-expiry dropdowns are not. **CVV/CVC must stay empty**; no CVV approval exists. PINs, OTPs, bank account numbers, and billing addresses are not stored or filled. Do not click a payment or submit button.

## 8. Deny, stop, lock, and expire

| Action | Expected behavior |
| --- | --- |
| Deny & close website before approval | Ends that inspection without retrieving/filling a record. |
| Stop & close website | Revokes authority, clears the owner draft/list/preview, and closes the protected page. |
| Lock vault & stop | Clears draft/visible metadata and stops the website; does not delete stored records. |
| Stop during inspection, authentication, or replacement teardown | Late work cannot revive authority or open a replacement page after cancellation. An already-started native save can still finish; writes are not rolled back. |
| Selected 1/5/15-minute lifetime expires | Protected page closes; old authority cannot be reused. Time starts at approval, including authentication time. |
| Close owner window, lock Windows, or disconnect | Requests protected-page closure and removes authority. Unlock/reconnect must not revive the old task. Actual lock/disconnect behavior still requires hardware testing. |

Inspect afresh for a new disclosure. Revocation cannot erase data already sent to website scripts or undo an already-started operation. Browser closure is cooperative, not a hard real-time guarantee.
## 9. Agent-assisted form inspection and missing-information dialogs

Auto-Mate supports general form inspection where the agent assists in mapping vault variables to form fields:

1. In the **Inspect a website** card, select record type **All form fields (Agent assisted)**.
2. Enter an HTTPS URL (e.g. a signup or profile form) and click **Inspect website**. Supported visible inputs (text, email, tel, url, username, password, select, textarea, date, number) are discovered with strict label evidence.
3. Click **1. Authenticate & list vault variables**. After native OS verification, the agent receives an allowlisted catalog containing all variable **names and descriptions** across your vault. **Secret values and ciphertexts are NEVER exposed to the agent.**
4. Click **2. Ask Agent to map fields**. The agent matches compatible variables to discovered fields.
5. **Missing Information Dialog**: Whenever the agent needs information that is not available in the vault (such as your Name on the first run, or a new username created for a specific website), a modal dialog box automatically appears:
   - Enter the requested value.
   - Optionally check **Save this to vault for future use**, specifying whether it should be saved as a **Shared profile** variable (reusable across websites for general profile data like your name) or a **Site-bound** variable (restricted to the current origin).
   - Click **Provide to Agent**, or click **Skip this field** if you do not wish to provide it.
6. Review the mapping badges on each field. Check only the fields you explicitly approve, choose a lifetime, and click **Approve selected fields & fill**.
7. The app enters the values into the receiving fields. **It never clicks submit or creates an account autonomously.** Review the protected browser window yourself.


## 10. Optional synthetic and supplied-API workflows

```powershell
bun start --synthetic
```

Offline mode makes no model request. Review **Run synthetic registration**, select Yellow and Red, then approve. This intercepted test workflow deliberately generates/stores a temporary password and submits once; no real account is created. Its temporary synthetic vault is deleted when the demo closes. Reopen it to test denial or Stop independently. **Audit history** is a read-only view of local journals; refreshing or browsing never authorizes a task.

The user supplies the **OpenAI-compatible API**. Follow [docs/model-api.md](docs/model-api.md) to configure the full HTTPS endpoint, exact served model name, and bearer key in the local process. No Qwen, Colab, GPU, or model-hosting setup is required or included.

Cloud consent is required. Only the typed task instruction and fixed system prompt are sent; never enter secrets. The API does not operate the real-site autofill path, and model selection never replaces field approval or Hello. Live-provider verification waits for the actual connection details.

## 11. Run the automated checks

From the project root:

```powershell
bun run typecheck
bun test
bun run smoke
powershell.exe -NoProfile -File .\platforms\windows\smoke-test.ps1
```

Tests and smoke use isolated synthetic vault namespaces and test origins. They do not bypass normal-vault authentication or prove real hardware verification. See [README.md](README.md#verification-performed) for evidence and limits, including a previously observed intermittent browser-setup cascade that passed diagnostic reruns but is not claimed resolved. For browser diagnostics from PowerShell, set `$env:DEBUG='pw:browser'`, run `bun test`, then `Remove-Item Env:DEBUG`.

The native smoke must report `Unicode secrets survive detached write and UTF-8-console read exactly` as passing, alongside encryption, restrictive ACL, migration, origin-refusal, and authentication-refusal checks. It uses only an isolated fictitious secret and restores its console encodings afterward.

For a manual acceptance matrix, use [README.md](README.md#website-acceptance-checklist). Also check the owner UI at about 390 px width: no horizontal page overflow, no focus/draft loss from preview refresh, and no stale frame after Stop.

## 12. Build and publish the application separately from the homepage

The application repository and its first release remain **private**. Build the application-only portable archive on Windows:

```powershell
bun run build:app
bun run check:app
```

`dist/app/` contains `Auto-Mate-0.1.0-preview.2-windows-x64.zip`, `SHA256SUMS.txt`, and release metadata. Publish the application ZIP and checksum as a **prerelease** of the reviewed, tested source commit. Do not upload the former source-site ZIP, homepage source, demo film, vault data, `.env` files, keys, or maintainer conversation memory. The archive includes required runtime components and third-party license notices.

`check:app` validates the checksum and application-only archive boundary, extracts into a temporary path containing spaces and Unicode, and runs the actual bundled `Auto-Mate.exe --check` with global Bun/Node excluded from `PATH`. It exercises the packaged DPAPI/Chromium path, not just the source checkout. It does not prove successful Hello authentication, signing, or a clean-machine installation.

The public homepage and non-interactive simulated film live only in [Auto-Mate-homepage](https://github.com/anujparwal/Auto-Mate-homepage). Its own build and Pages workflow publish static marketing assets; they never start a native broker or receive a user's vault. The previous app-side static site/source-package deployment has been removed to avoid publishing application source through the wrong path. Follow the homepage repository's instructions to edit, render, or deploy it.

The first release is an unsigned, test-data-only private preview—not production approval. Successful Hello/session tests, clean-machine installation, repeatable browser reliability, independent security review, signing, and a recovery strategy remain gates before recommending private credentials or public application distribution.

## 13. Troubleshooting and data handling

- **Authentication refusal:** configure Windows Hello and verify an interactive signed-in desktop. Stop and inspect again after resolving it. Do not turn on synthetic mode for real domains.
- **No supported fields:** verify record type, full visibility, and explicit labels; an unsupported site is not permission to weaken evidence checks.
- **Record rejected:** check the exact origin/type/ID. A successful list is not approval. Preserve IDs and credential values exactly; do not silently trim passwords or rewrite legacy secrets.
- **Model failure:** check full endpoint path, exact model name, TLS/authentication, non-thinking server configuration, and raw-JSON behavior using synthetic prompts. Auto-Mate rejects malformed/oversized/authority-bearing replies; there is no automatic retry or provider fallback.
- **Script blocked:** review the script and unblock only the reviewed downloaded file if organizational policy permits; do not disable global protections.
- **Report a bug:** include button order, public target URL, record type, visible phase/error, whether the protected page closed, and whether an unapproved field changed. Never send values, private IDs, API keys, vault files, or unredacted screenshots.

Normal encrypted data and audit files are outside the extracted application folder: the default vault is `%LOCALAPPDATA%\Auto-Mate\vault.json`, and broker audit journals are under `%LOCALAPPDATA%\AutoMate\audit\`. Deleting the application folder is not a vault-deletion or recovery procedure. DPAPI is tied to the Windows user/device context; same-user malware and a compromised OS are outside its guarantee. There is no supported cross-device recovery/export design yet. Do not entrust irreplaceable private credentials to this preview.
