# Connect a supplied OpenAI-compatible API

The user will provide the API. **Do not install, download, host, or configure Qwen or a Colab runtime.** This guide configures only Auto-Mate's existing client. Qwen3.5-9B may be the provider's underlying model; the application uses the exact model identifier advertised by that provider.

## Required connection information

- Full HTTPS chat-completions URL, normally ending `/v1/chat/completions` (not just a server base URL).
- Exact served model identifier.
- Bearer API key. Supply it to the local process, not source control, the public website, or chat logs.

These values have not been supplied yet, so live-provider inference cannot currently be verified. No paid resource or model-hosting setup is required on the Windows PC.

## Configure the Windows process

In PowerShell, from the Auto-Mate folder:

```powershell
$env:AUTOMATE_PLANNER = 'cloud'
$env:AUTOMATE_MODEL_ENDPOINT = Read-Host 'Full HTTPS chat-completions URL'
$env:AUTOMATE_MODEL = Read-Host 'Exact served model identifier'
$key = Read-Host 'API key' -AsSecureString
$env:AUTOMATE_MODEL_API_KEY = [System.Net.NetworkCredential]::new('', $key).Password
try {
    bun start --synthetic
} finally {
    Remove-Item Env:AUTOMATE_MODEL_API_KEY -ErrorAction SilentlyContinue
    $key.Dispose()
}
```

This keeps the literal key out of PowerShell command history; plaintext still exists transiently in the process environment/memory and is not protected against same-user malware. Never paste an actual key into a committed `.env`, screenshot, PR description, or public page. The app does not display it.

If the API is genuinely served on this Windows PC's loopback, `AUTOMATE_PLANNER=local` accepts HTTP(S) `localhost`, `127.0.0.1`, or `[::1]`. A remote Colab/server endpoint is **cloud**, even if you own it. Remote APIs require HTTPS and a nonempty key. URLs with credentials, query strings, fragments, or redirects are rejected; TLS validation stays enabled.

## Use the existing model workflow

1. Start `bun start --synthetic` after setting the environment; running processes do not pick up later terminal changes.
2. Check the cloud-disclosure consent box. Only the typed instruction and fixed workflow-selection system prompt are sent to the provider. Never type private account information or credentials.
3. Enter **Run synthetic registration** and click **Ask model to plan**.
4. A valid reply shows the reviewed synthetic plan. It grants no authority by itself. Select the required Yellow and Red categories and approve separately to execute the intercepted test workflow.
5. An unsupported request, e.g. **Transfer money**, must not produce a runnable arbitrary browser task. Test denial and Stop independently by restarting the demonstration.

The API receives no vault values, ciphertext export, IDs/catalog, webpage content, owner preview, selectors, browser handles, or approval controls. **The real-site `bun start` autofill flow does not call a model.** This integration does not expand it into general autonomous browsing or let the provider operate the vault.

## Expected API contract

The client sends a non-streaming-compatible OpenAI chat-completions POST with `model`, `messages`, `temperature: 0`, JSON content type, and `Authorization: Bearer ...`. The provider must return HTTP 200 JSON containing `choices[0].message.content` as a string holding exactly one JSON key:

```json
{"workflow":"synthetic-registration"}
```

or, for unsupported instructions:

```json
{"workflow":"unsupported"}
```

Model prose, visible thinking preambles, markdown fences, extra authority keys, malformed JSON, redirects, and oversized responses fail closed. If the provider's model emits reasoning, have the supplied API return only final JSON in `content`; do not weaken the client's parser or grant arbitrary tools to work around it. Provider-native alternate APIs/extra mandatory headers are not automatically OpenAI-compatible with this contract.

Instruction limit: 2,000 characters. Request deadline: 30 seconds. Response-body limit: 32 KiB. Completion-content limit: 4,096 characters. There are no automatic retries or provider fallbacks. Provider availability, billing, retention, model behavior, and serving configuration are the API operator's responsibility.

## Return to offline mode

```powershell
$env:AUTOMATE_PLANNER = 'reviewed'
Remove-Item Env:AUTOMATE_MODEL_API_KEY -ErrorAction SilentlyContinue
bun start --synthetic
```

Offline reviewed mode makes no model request. Protocol-fixture tests can verify client boundaries without your endpoint, but they are not proof that the supplied provider has passed. Once the URL/model/key are available, exercise valid/unsupported requests, authentication refusal, consent, cancellation, and response limits against that actual service using synthetic instructions only.
