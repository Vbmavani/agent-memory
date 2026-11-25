# Guardrails

A guardrail is a check that lives **outside** the model, in code, so it still holds when the model is
fooled. The **Guardrails lab** (http://localhost:9200/guardrails.html) is a small customer-support agent
with three tools (`get_order`, `run_sql`, `issue_refund`) wrapped in four layers. It needs no database.

```
user text -> INPUT -> model -> TOOL-CALL check -> tool runs -> scan result -> model -> OUTPUT -> user
                         (BUDGET counts every step, token and second)
```

| Layer | File | What it does |
|---|---|---|
| Input | `server/guardrails/input.js` | Length cap, injection patterns, redacts emails / cards / phones. Also runs on **tool results**, because data can carry an attack (indirect injection). |
| Tool calls | `server/guardrails/tools.js` | Tool allowlist, argument checks (one `SELECT` only, refund 0 to 500), human approval for risky tools. Fails closed. |
| Output | `server/guardrails/output.js` | Blocks keys, JWTs, private keys and system-prompt leaks. |
| Budget | `server/guardrails/budget.js` | Step, token and time limits; stops the same tool call repeating. |

`server/guardrails/agent.js` is the loop that applies them, `server/guardrails/api.js` streams every decision
to the page (Server-Sent Events) and waits for the human's answer on approvals.

## Using the lab

- **Mock model** (default): free and instant, and deliberately gullible. It does whatever the text says, so
  you can watch each guardrail stop it. **DeepSeek (live)** uses `deepseek-chat` with the same guardrails
  (key from env `DEEPSEEK_API_KEY` or the Keychain, like the rest of the app).
- Switch a layer **off** to see what it was protecting you from, or press **Compare ON vs OFF** to run the
  same message both ways.
- Good experiments: *Hidden injection in data* with Input off (the agent is hijacked into a 500 refund);
  *Prompt injection* with Input off (the Output layer still catches the leak); *Huge refund* (blocked
  even if you approve).

## What these checks are, and are not

They are plain code (regexes, allowlists, limits): free and instant, but they only catch **obvious**
cases. A production system adds a small classifier for injection (for example Prompt Guard), a safety model
for outputs (for example Llama Guard), a cheap LLM judge for fuzzy policies, least-privilege credentials
and real logging. The rule of thumb: put the strongest checks on **tool calls**, because actions cannot
be un-done.

## Tests

`npm test` runs `test/guardrails.test.js`: each layer on its own, and the whole agent with a scripted fake
model, so no API key is needed.
