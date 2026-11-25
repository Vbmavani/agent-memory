# Guardrails lab

A guardrail is a check that lives **outside** the model, in code, so it still holds when the model is fooled.
The **Guardrails lab** (http://localhost:9200/guardrails.html) is a small customer-support agent with three
tools (`get_order`, `run_sql`, `issue_refund`) wrapped in **13 switchable layers**. It needs no database.
The concepts, the full catalog of 26 checks and the production advice are in [guardrails-guide.md](guardrails-guide.md).

```
user text → INPUT → trained models → cheap LLM checks → agent → TOOL gate → tool → scan result → agent → OUTPUT → user
                        (BUDGET and RATE / BREAKER wrap the loop; the AUDIT trail records every request)
```

## The 13 layers

| Group | Switch | How it works | File |
|---|---|---|---|
| Input | **Patterns & PII** | Code: length cap, injection regexes, redacts emails / cards / phones. Also runs on tool results. | `input.js` |
| Input | **Injection model** | **Trained model**: scores 0 to 1, blocks at 0.9 or more. Also runs on tool results, in windows so a deep attack is still seen. | `classifiers.js` |
| Input | **Toxicity model** | **Trained model**: blocks at 0.8 or more. Checks your message and the reply. | `classifiers.js` |
| Input | **Scope check** | **Cheap LLM**, fresh context: on topic or not. Off-topic never reaches the agent. | `llm-checks.js` |
| Input | **LLM judge** | **Cheap LLM**: SAFE or UNSAFE for fuzzy injections. | `llm-checks.js` |
| Tools | **Allowlist & approval** | Code: tool allowlist, argument checks (one `SELECT` only, refund 0 to 500), human approval for refunds. Fails closed. | `tools.js` |
| Tools | **Roles & limits** | Policy as data: least privilege by role (`customer` or `support`) plus a cumulative refund cap of 600 per session. | `policy.js` |
| Output | **Secrets & prompt leak** | Code: keys, JWTs, private keys, the system prompt. | `output.js` |
| Output | **Personal data** | Code: redacts emails, cards and phones in the reply and keeps the rest. | `agent.js` |
| Output | **Grounding** | Code: every number, price or code in the reply must exist in the data the agent was given. | `output.js` |
| Output | **Format** | Code: no scripts or event handlers, no raw JSON, 1500 character cap. | `output.js` |
| Runtime | **Budget** | Steps (6), tokens (20,000), time (60 s), and repeated identical tool calls. | `budget.js` |
| Runtime | **Rate limit & breaker** | 5 requests per 30 s per session; the breaker opens after 3 model failures for 20 s. | `runtime.js` |

Always on (not a switch, on purpose): the **kill switch** button (a human stops every request) and the **audit trail**
(`audit.js`: in-memory plus `data/guardrails-audit.jsonl`, messages stored after PII redaction, alert rules for probing,
unguarded high-risk tools and skipped checks).

All files are in `server/guardrails/`. `agent.js` is the loop that applies them in order, cheapest first.

## Using the lab

- **Mock model** (default): free and instant, deliberately gullible, so you can watch each guardrail stop it. The scope and judge
  checks use a keyword stand-in in mock mode. **DeepSeek (live)** uses `deepseek-chat` for the agent *and* for the cheap LLM checks
  (key from env `DEEPSEEK_API_KEY` or the Keychain, like the rest of the app). The two trained models run locally in both modes.
- **Demo mode** (default on): each example runs with *only* the layer it demonstrates, so that layer does the work. With it off,
  examples use your switches. Typed messages always use your switches.
- **Compare ON vs OFF** runs your typed message twice, with every layer on and then with every layer off.
- **Role** picks who is asking. The *Customer* role cannot use `run_sql` or `issue_refund`, whatever the model says.
- **Kill switch** refuses every request until you switch it back. **Reset counters** clears refund totals, the rate limiter, the breaker and the audit view.
- Good experiments: *Paraphrased injection* with only Patterns on (it passes) and then only the Injection model on (blocked);
  *Attack hidden in data* with nothing on (the agent is hijacked into a 500 refund); *Two refunds of 400* pressed twice;
  *Six quick requests*; *Model outage (x4)*.

## The local models

Both run in Node through `@huggingface/transformers` (the same library as `server/embed.js`), are downloaded **once on first use**
from huggingface.co and cached, and need no API key. The lab page starts loading them when it opens, and the header shows their status.

| Model | File used | Size | Licence |
|---|---|---|---|
| `Horizon-Labs/prompt-injection-guard-small` (injection) | `onnx/model_quantized.onnx` | about 268 MB | Apache-2.0 |
| `Xenova/toxic-bert` (toxicity) | `onnx/model_int8.onnx` | about 110 MB | not stated on its page: check before commercial use |

Set `INJECTION_MODEL=protectai/deberta-v3-base-prompt-injection-v2` for the better-known (but 739 MB) alternative. If a model
cannot load, its check is **skipped and flagged** in the trace, and an alert is raised. It is never silently treated as safe.

Measured on these models: attacks score 0.99 to 1.0; harmless commands such as `Refund ORD-1001 50` score about 0.6; ordinary
questions score under 0.02. The 0.9 threshold sits in that gap. Measure on your own traffic before trusting it.

## API (a separate Vite plugin, `server/guardrails/api.js`)

| Route | |
|---|---|
| `GET /api/guardrails/status` | Is a key available, model status, kill switch, roles. Also starts loading the models. |
| `POST /api/guardrails/chat` | `{message, mock, guards, role, sessionId}` → Server-Sent Events: `log` per decision, `approval`, `alert`, `final`. |
| `POST /api/guardrails/approve` | `{id, ok}`: the human's answer to an `approval` event (denied after 60 s). |
| `POST /api/guardrails/kill` | `{on}`: the kill switch. |
| `GET /api/guardrails/audit` | Recent requests and alerts. |
| `POST /api/guardrails/reset` | Clear counters and the audit view. |

## Things the tests found

Worth knowing, because real systems hit the same traps:

- **Evidence must not include the model's own words.** The first grounding check "proved" an invented tracking number because the reply was already in the message list it searched.
- **Order matters.** The phone-number regex masked part of an invented tracking number *before* the grounding check could see it. Pass or fail checks run first; **redaction runs last**.
- **A stricter layer can hide a weaker one.** With everything on, an injection model may block `DROP TABLE` before the tool gate sees it. Demo mode turns the others off so each layer is visible.

## Tests

`npm test` runs `test/guardrails.test.js`: every layer on its own and the whole agent with a scripted fake model and fake
classifiers, so it is fast and needs no key or download. `RUN_MODELS=1 npm test` also runs the real downloaded models.
