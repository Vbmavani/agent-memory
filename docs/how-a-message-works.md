# How one message works

Example: the user writes *"When I ask how to order something, tell me to use Amazon or Flipkart,
give me the steps, and ask which product I like."* The reply says "Saved" and shows a
📘 **Learned how to work** row tagged **you asked**.

That one message makes **4 DeepSeek calls**. The meta line under the reply shows "2 model calls"
because it only counts the chat model.

## Step by step

1. **Browser.** `send()` in [`src/App.jsx`](../src/App.jsx) posts the text to
   `POST /api/chats/:id/messages` (`new` starts a chat).

2. **Build the prompt.** `systemPrompt()` in [`server/api.js`](../server/api.js) puts in the
   profile, the facts (`- [id] text`), the procedures (`- [id] WHEN … -> …`), today's date and the
   memory instructions. Then come this chat's previous messages and the new one. The meta line's
   "N procedures" is the count at this moment, before the message is handled.

3. **Two things run at the same time** (`Promise.all`):
   - **Chat model** (`answerWithTools`):
     - Call 1: the model asks for `save_procedure` with `{when, do}`. The tool only records the
       request in `ctx.memoryRequests`.
     - Call 2: the model sees `{status: "recorded"}` and writes the reply.
   - **Speculative memory decision** (`decideMemory`), call 3: decides from the message alone, so
     learning adds no wait.

4. **One writer** (`updateMemory`). The chat model recorded a request, so the speculative decision
   is replaced. Call 4 runs `decideMemory` again with the message, the existing facts and
   procedures, and the request. It writes the final wording, merged with anything that exists. If
   that call fails, the request is applied as written, so it is never lost.

5. **Validate and merge** ([`server/memory.js`](../server/memory.js)).
   - `validateOps` keeps only safe operations: known ids, clean text, length limits, one decision
     per item.
   - `mergeItems` applies them with these rules:
     - There is one procedure per trigger, so the same trigger is updated, not added twice.
     - A write is rejected as stale if the item changed since the decision.
     - Updates keep their last 5 previous versions.

6. **Database write** (`applyMemoryOps` in [`server/db.js`](../server/db.js)). It runs
   `BEGIN`, then `SELECT … FOR UPDATE` (locks the user's row), then the merge, then
   `UPDATE users SET facts, procedures`, then `COMMIT`. Two messages at once are applied one after
   the other, so no write is lost.

7. **Source tag.** The tag is `tool` if the user asked ("you asked"), `lesson` if every request was
   `self_learned` ("self-learned"), or `auto` if the background decision did it ("automatic").

8. **Save the turn.** `saveTurn` appends the user message and the reply (with
   `meta.memory = [{kind: "procedure", op: "add", when, do, source}]`) to `chats.messages`. The UI
   draws each change as a 🧠 / ✏️ / 🗑 / 📘 row.

9. **Next message, any chat.** The new procedure is in the system prompt, so the model follows it
   without being reminded.

## Who decides what

| Part | Decides | Code |
|---|---|---|
| Chat model | *That* something should be remembered (calls a memory tool) | `answerWithTools`, `runTool` |
| Memory model | *What exactly* to store, merged with what exists | `decideMemory`, `MEMORY_PROMPT` |
| Database code | Stores it safely: lock, de-duplicate, reject stale writes | `validateOps`, `mergeItems`, `applyMemoryOps` |

## Company rules vs user procedures

- **Company rules** are hard-coded in `server/api.js`: the base system prompt and the tool rules.
  The developer sets them, and they are the same for every user.
- **Procedures** belong to one user and are stored in `users.procedures`.

Nothing yet enforces that company rules win when the two conflict. A production version should
refuse procedures that try to override them when they are saved, and should say so in the prompt.
