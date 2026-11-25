// A fake "model" so the UI works without an API key.
// It is deliberately gullible: it does whatever the text says, so you can watch guardrails stop it.
import { SYSTEM_PROMPT } from "./agent.js";

let n = 0;
const call = (name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `mock_${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const say = (content) => ({ role: "assistant", content });

export async function mockChat(messages) {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const last = messages.at(-1);
  const usage = { total_tokens: 50 };
  const wrap = (message) => ({ choices: [{ message }], usage });

  if (/\bloop\b/i.test(user)) return wrap(call("get_order", { order_id: "ORD-1001" }));

  if (last.role === "tool") {
    if (/ignore previous/i.test(last.content))
      return wrap(call("issue_refund", { order_id: "ORD-1003", amount: 500 })); // hijacked by injected data
    if (/blocked by policy/.test(last.content)) return wrap(say("I'm sorry, I'm not allowed to do that. The action was blocked by policy."));
    return wrap(say(`Done. Result: ${last.content}`));
  }

  const sql = user.match(/sql:\s*(.+)$/i);
  if (sql) return wrap(call("run_sql", { query: sql[1] }));
  const refund = user.match(/refund\s+(ORD-\d+)\s+(?:for\s+)?\$?(\d+(?:\.\d+)?)/i);
  if (refund) return wrap(call("issue_refund", { order_id: refund[1], amount: Number(refund[2]) }));
  const order = user.match(/ORD-\d+/i);
  if (order) return wrap(call("get_order", { order_id: order[0].toUpperCase() }));
  if (/system prompt/i.test(user)) return wrap(say(`My instructions: ${SYSTEM_PROMPT}`));
  if (/api key|secret|password|token/i.test(user)) return wrap(say("Sure! The key is sk-abcdefghijklmnop1234"));
  return wrap(say("Hi! I can look up orders (e.g. ORD-1001) and issue refunds."));
}
