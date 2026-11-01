# How to use Auto-Mate

## 1. What this tool does

Auto-Mate opens an owner-only website in a local Chromium window on **your Windows PC**. It lets you save encrypted Login or Payment card records, inspect a supported HTTPS website without reading the vault, and explicitly approve individual fields for filling.

**Development preview: use fictitious data and public test forms only.** It is not a production password manager, a general autonomous agent, or a guarantee of perfect security. The app never clicks Login, Pay, or Submit in real-site autofill. Filling itself gives those values to the receiving website and its scripts; Stop cannot undo that disclosure.

The public download site is separate from the working owner website. Vault storage, Windows Hello, approval, and the protected browser run on each user's PC. There is no extension, public vault server, or cross-user credential service.

## 2. Install the required software

Supported runtime: **Windows 11 x64, build 22000+, 64-bit Windows PowerShell 5.1+, and Bun 1.4.4+**. Windows includes the native .NET/DPAPI components; no separate .NET SDK, Docker, GPU software, Android SDK, or local 9B model download is needed to run this Windows website.

### From the future public download site

1. Download `Auto-Mate-windows.zip` and `SHA256SUMS.txt` from the same reviewed release.
2. In PowerShell, run `Get-FileHash .\Auto-Mate-windows.zip -Algorithm SHA256` and compare the complete hash with `SHA256SUMS.txt`. A matching hash checks integrity, not publisher identity; this preview is an unsigned source package.
3. Extract the ZIP to a folder you control. The package is Windows-specific source, not a standalone executable.
4. Open PowerShell in the extracted folder and review `tools/setup-windows.ps1`. If Windows marked this reviewed script as downloaded, remove the mark for this file only with `Unblock-File .\tools\setup-windows.ps1`. Do not change machine-wide execution policies or override an organization's policy.
5. Run:

   ```powershell
   powershell.exe -NoProfile -File .\tools\setup-windows.ps1
   ```

The script preserves existing installations. If Bun is missing, it downloads the pinned official Windows release and verifies its published SHA-256 digest before installation. It then installs locked project dependencies (including Sharp and Playwright) and Chromium. Reopen PowerShell if Bun was newly added to your user PATH. An existing older Bun is not silently overwritten; update it deliberately and rerun setup.

### From an existing repository checkout

Open PowerShell in the repository root, then use the same setup command. Contributors can add `-DeveloperTools` to install missing Git/GitHub CLI through winget. Those tools are not required for an end user running an extracted source package. To inspect already-installed runtime prerequisites without downloading:

```powershell
powershell.exe -NoProfile -File .\tools\setup-windows.ps1 -CheckOnly
```

A prerequisite check is not a successful Windows Hello test or a complete runtime test.

## 3. Open the owner website

```powershell
bun start
```

Keep that terminal open. Auto-Mate opens its browser window automatically. Do not type the internal `*.auto-mate.invalid` URL into a normal browser: application assets and commands are bound to the browser instance launched by Auto-Mate, not a public HTTP listener.

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

## 9. Optional synthetic and supplied-API workflows

```powershell
bun start --synthetic
```

Offline mode makes no model request. Review **Run synthetic registration**, select Yellow and Red, then approve. This intercepted test workflow deliberately generates/stores a temporary password and submits once; no real account is created. Its temporary synthetic vault is deleted when the demo closes. Reopen it to test denial or Stop independently. **Audit history** is a read-only view of local journals; refreshing or browsing never authorizes a task.

The user supplies the **OpenAI-compatible API**. Follow [docs/model-api.md](docs/model-api.md) to configure the full HTTPS endpoint, exact served model name, and bearer key in the local process. No Qwen, Colab, GPU, or model-hosting setup is required or included.

Cloud consent is required. Only the typed task instruction and fixed system prompt are sent; never enter secrets. The API does not operate the real-site autofill path, and model selection never replaces field approval or Hello. Live-provider verification waits for the actual connection details.

## 10. Run the automated checks

From the project root:

```powershell
bun run typecheck
bun test
bun run smoke
powershell.exe -NoProfile -File .\platforms\windows\smoke-test.ps1
```

Tests and smoke use isolated synthetic vault namespaces and test origins. They do not bypass normal-vault authentication or prove real hardware verification. See [README.md](README.md#verification-performed) for evidence and limits, including a previously observed intermittent browser-setup cascade that passed diagnostic reruns but is not claimed resolved. For browser diagnostics from PowerShell, set `$env:DEBUG='pw:browser'`, run `bun test`, then `Remove-Item Env:DEBUG`.

For a manual acceptance matrix, use [README.md](README.md#website-acceptance-checklist). Also check the owner UI at about 390 px width: no horizontal page overflow, no focus/draft loss from preview refresh, and no stale frame after Stop.

## 11. Prepare or deploy the public download site later

The agreed architecture is a static public site plus a local Windows app for each user—not a hosted vault or multi-user browser service.

```powershell
bun run build:site
```

This generates `dist/site/` containing the static HTML/CSS, usage/model guides, Windows source ZIP, and checksum. The build packages allowlisted source roots only; it excludes `.git`, `.local`, default vault data, environment files, dependency caches, and maintainer conversation memory. These exclusions are not a substitute for reviewing source for accidentally committed secrets. `dist/` is ignored by Git.

To publish later on GitHub Pages:

1. Merge a reviewed PR into `main` after Windows verification passes.
2. Review what the ZIP exposes and obtain any required redistribution/license approvals. Publishing the site intentionally distributes source, even if the Git repository itself remains private. The preview is unsigned and must retain its development warnings.
3. In repository **Settings → Pages**, select **GitHub Actions** as the source. Repository visibility/plan must support Pages; a private repository may need an eligible paid plan. This work does not change repository visibility or purchase a plan.
4. Configure the `github-pages` environment with required reviewer approval if desired.
5. Under **Actions → Deploy public download site → Run workflow**, choose `main`. The workflow runs Windows tests/smoke, builds the package, and deploys only `dist/site`. It does not upload local vaults, API keys, or install a remote vault server.
6. Check the resulting HTTPS page, ZIP download, checksum, and fresh Windows setup. No deployment has been performed merely by creating this workflow. You can instead host the contents of `dist/site` on another approved static host.

A public development download is not production security readiness. Positive Hello/session tests, repeatable browser-test reliability, independent security review, and a signed/versioned release and recovery strategy remain release gates before recommending private credentials.

## 12. Troubleshooting and data handling

- **Authentication refusal:** configure Windows Hello and verify an interactive signed-in desktop. Stop and inspect again after resolving it. Do not turn on synthetic mode for real domains.
- **No supported fields:** verify record type, full visibility, and explicit labels; an unsupported site is not permission to weaken evidence checks.
- **Record rejected:** check the exact origin/type/ID. A successful list is not approval. Preserve IDs and credential values exactly; do not silently trim passwords or rewrite legacy secrets.
- **Model failure:** check full endpoint path, exact model name, TLS/authentication, non-thinking server configuration, and raw-JSON behavior using synthetic prompts. Auto-Mate rejects malformed/oversized/authority-bearing replies; there is no automatic retry or provider fallback.
- **Script blocked:** review the script and unblock only the reviewed downloaded file if organizational policy permits; do not disable global protections.
- **Report a bug:** include button order, public target URL, record type, visible phase/error, whether the protected page closed, and whether an unapproved field changed. Never send values, private IDs, API keys, vault files, or unredacted screenshots.

Normal encrypted data and audit files are outside the extracted application folder, under the user's local AutoMate data directory. Deleting app source is not a vault-deletion or recovery procedure. DPAPI is tied to the Windows user/device context; same-user malware and a compromised OS are outside its guarantee. There is no supported cross-device recovery/export design yet. Do not entrust irreplaceable private credentials to this preview.
