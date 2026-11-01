# Connect a supplied OpenAI-compatible API

Auto-Mate connects to a user-supplied OpenAI-compatible API to power its ReAct agent loop (`AgentEngine`).

**Do not install, download, host, or configure local Qwen or a Colab runtime.** The host machine does not need GPU hardware or local model serving software. Auto-Mate communicates over HTTPS (or local loopback in desktop mode) with the configured endpoint.

---

## 1. Provider Presets and Configuration

Model settings are configured directly within the application's **⚙️ Settings** modal and stored securely in the per-user encrypted workspace store (`src/workspace-store.ts`).

### Built-in Provider Presets

Auto-Mate provides built-in presets for popular OpenAI-compatible providers:

| Preset | Mode | Default Endpoint | Default Model | Key Required |
| :--- | :--- | :--- | :--- | :--- |
| **OpenAI** | Cloud | `https://api.openai.com/v1/chat/completions` | `gpt-4o-mini` | Yes |
| **Groq** | Cloud | `https://api.groq.com/openai/v1/chat/completions` | `llama-3.3-70b-versatile` | Yes |
| **OpenRouter** | Cloud | `https://openrouter.ai/api/v1/chat/completions` | `meta-llama/llama-3.3-70b-instruct` | Yes |
| **Ollama** | Local | `http://127.0.0.1:11434/v1/chat/completions` | `llama3.2` | Optional |
| **LM Studio** | Local | `http://127.0.0.1:1234/v1/chat/completions` | `qwen2.5-7b-instruct` | Optional |
| **Custom** | Cloud / Local | User-specified | User-specified | Optional |

### Operational Mode Boundaries

- **Hosted Mode (`bun run host` / `Auto-Mate.exe --hosted`)**:
  - **Cloud HTTPS Only**: Hosted sessions strictly require `https://` cloud endpoints with public hostnames.
  - **Local Models Forbidden**: Local loopback endpoints (`127.0.0.1`, `localhost`, `::1`) are strictly rejected with `LOCAL_MODEL_FORBIDDEN_IN_HOSTED` to protect host internal services.
- **Local Desktop Mode (`bun start` / `Auto-Mate.exe`)**:
  - **Local Loopback**: Genuine loopback addresses (`localhost`, `127.0.0.1`, `[::1]`) permit `http://` or `https://`.
  - **Cloud Endpoints**: Remote endpoints strictly require `https://` with valid certificates.

### URL Validation Rules
- Endpoints are automatically normalized to append `/v1/chat/completions` if omitted.
- Embedded credentials (`UserInfo`), URL query parameters (`?query`), and URL fragments (`#fragment`) are strictly prohibited and fail validation (`INVALID_MODEL_ENDPOINT`).
- Private IP addresses (RFC 1918), Carrier-Grade NAT (RFC 6598), and cloud metadata endpoints (`169.254.169.254`) are rejected as cloud endpoints (`CLOUD_ENDPOINT_CANNOT_BE_PRIVATE`).

### Provider Verification Status and Historical Endpoints
- The legacy default endpoint (`https://nullify-geometric-decathlon.ngrok-free.dev/v1/chat/completions`, model `qwen3.5-9b`) previously passed metadata-only probes, but currently returns HTTP 404 (`ERR_NGROK_3200`: ngrok tunnel offline / endpoint not found).
- The server exposed `POST /v1/chat/completions` only with no `/models` endpoint; the server's actual underlying model weights cannot be cryptographically verified. The label `qwen3.5-9b` was provider-supplied; Auto-Mate makes no claim that 9B weights have been verified.
- **No model hosting is set up**: The user supplies their own API endpoint and key. No Qwen or Colab setup is provided or required.
- **Legacy Flow Obsolete**: The previous `model-config.json`, `application-planner.ts` form flow, and synthetic reviewed-command mode are **historical** and no longer used by the actual app.
- **Visible Model Errors**: When the selected endpoint is offline, returns HTTP errors, or returns malformed output, the error is displayed cleanly in the UI (e.g., *"The selected model could not be reached. Check its endpoint, model name and API key. No provider fallback was used."*). **There is no fake fallback or synthetic reviewed-command mode in the new app.**

---

## 2. ReAct Agent Engine Tool Contract

Auto-Mate's `AgentEngine` interacts with the model in a strict ReAct loop. The model must return **ONLY** a valid JSON object matching:

```json
{
  "tool": "tool_name",
  "args": { ... },
  "status": "brief user-facing action summary"
}
```

Any markdown code fences (` ```json `), reasoning preambles, missing keys, or extra unrecognized keys cause an immediate fail-closed error (`INVALID_AGENT_RESPONSE`).

### Supported Tools

| Tool | Arguments | Purpose & Security Constraint |
| :--- | :--- | :--- |
| `navigate` | `{"url": "https://..."}` | Navigate the main browser to public HTTPS, subject to website policy. After a private fill, navigation also requires explicit action approval. |
| `observe` | `{}` | Re-inspect the current webpage DOM, text, fields, and actions. |
| `scroll` | `{"direction": "up" \| "down"}` | Scroll the active page viewport. |
| `click` | `{"actionId": "..."}` | Click a current opaque action. Buttons require approval; after a private fill, links require approval too. Variable/group grants never approve clicks. |
| `type` | `{"fieldId": "...", "text": "..."}` | Type text into a field. **Restricted to public search inputs only.** Strictly forbidden for credentials or private information. |
| `request_information` | `{"fieldId": "...", "variableId": "..."}` | Request host-side filling of a private vault variable. **Values are filled directly by the host into the browser**; secret values are NEVER sent to the model or chat. |
| `take_note` | `{"topic": "...", "sourceUrl": "...", "evidence": "..."}` | Save an exact quote from an observed page. The content is the verified quote, not an unchecked generated interpretation. |
| `spawn_subagents` | `{"tasks": [{"name": "...", "goal": "...", "url": "..."}]}` | Spawn parallel, cookie-less subagents to evaluate independent candidate URLs. |
| `finish_task` | `{"answer": "..."}` | Conclude the task and deliver the synthesized answer citing recorded evidence. |

---

## 3. Data Privacy and Information Boundary

### What the Model Receives
1. **User Prompt & Chat History**: User-typed instructions and past assistant responses (untrusted context).
2. **Permanent Memory (Opt-in)**: If enabled by the user in Settings, the permanent memory text (up to 32 KiB).
3. **Research Notes**: Up to 30 recent notes recorded during research, including topic, content, source URL, and verbatim evidence quotes.
4. **Sanitized Browser Observations (`BrowserObservation`)**:
   - Page URL (with known private values replaced with `[private]`).
   - Page title (redacted).
   - Rendered page text (up to 16,000 characters, redacted before model-facing truncation).
   - Discovered fields: `id`, `label` (redacted), `kind`, `required`, and public `options` (for select dropdowns).
   - Discovered actions: `id`, `label` (redacted), `kind` (`link` or `button`), and safe `href`.
5. **Variable Metadata Catalog**:
   - `id`, `name` (redacted), `description` (redacted), `kind`, `scope`, and `available`.

### Data Excluded from the Host's Model Interface
- **Vault read results and ciphertexts** are not exposed through model tools. Known filled values are matched and redacted from subsequent observations. This is not a guarantee that arbitrary signed-in page content is secret-free: transformed values, unknown account data, and user-typed chat/memory may disclose information.
- **Browser Cookies & Storage**: Cookies and session state remain inside the Playwright browser.
- **Raw DOM & Internal Selectors**: The model operates only with opaque local IDs.
- **Owner Preview Screenshots**: The live preview image with off-page Sharp masking is strictly rendered for the human owner. **Screenshots are NEVER sent to the AI model.**

---

## 4. Parallel Evaluator Subagents (`spawn_subagents`)

When comparing products, verifying facts across candidate URLs, or concluding multi-source research:
1. The orchestrator triggers `spawn_subagents` with 2–6 tasks.
2. The host executes tasks using up to 3 parallel worker contexts.
3. **Cookie-less & Signed-Out**: Evaluator contexts are completely separate, signed-out browser instances with no cookies, sessions, or credentials from the main browser.
4. **Read-Only**: Evaluators cannot click, type, or interact; they only observe page text.
5. **Verbatim Evidence Verification**: Findings use `{"findings":[{"evidence":"exact source quote"}]}`. Quotes absent from the observed source are rejected (`NOTE_EVIDENCE_MISSING`); generated interpretations are not stored as facts. The final model synthesis can still be wrong—check its sources.
6. Findings are recorded in the **Notes Space** tab for user inspection.

---

## 5. Purchase and Action Protections

- **No unattended sensitive clicks**: Buttons require explicit confirmation; after any private fill, main-browser navigation and link clicks require confirmation too. An approved action may complete a real purchase and cannot necessarily be undone.
- **No purchase-proof guarantee**: Model wording is not proof of an order. Verify the website confirmation and receipt yourself. Source quotes and independent evaluators reduce unsupported claims; they do not make an LLM infallible.
- **Model System Prompt Guard**: The system prompt instructs:
  > *"Never invent a completed click, purchase, price or specification. Cite recorded evidence when recommending. A user purchase goal is NOT permission to bypass checkout approval. Do not bypass CAPTCHA, MFA or website restrictions. Never claim login, checkout or purchase success without evidence; a dispatched click alone is not proof."*

---

## 6. Technical Request Limits

| Parameter | Limit |
| :--- | :--- |
| **Request Timeout** | 30 seconds |
| **Max Completion Content** | 12,000 characters |
| **Max Stream Body** | 64 KiB (`MAX_STREAM_BYTES`) |
| **Max Tokens per Turn** | 1,600 tokens |
| **Max Step Count** | 48 ReAct turns per user task |
| **Permanent Memory Limit** | 32 KiB |
| **Notes Limit** | 100 notes per workspace |
| **Retries / Fallback** | None (fail closed with clear error message) |

Provider availability, latency, token limits, and serving uptime are the provider operator's responsibility.
