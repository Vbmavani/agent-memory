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

  if (/break the model/i.test(user)) throw new Error("simulated model outage"); // trips the circuit breaker

  if (/\bloop\b/i.test(user)) return wrap(call("get_order", { order_id: "ORD-1001" }));

  if (last.role === "tool") {
    if (/ignore previous/i.test(last.content))
      return wrap(call("issue_refund", { order_id: "ORD-1003", amount: 500 })); // hijacked by injected data
    if (/blocked by policy/.test(last.content)) return wrap(say("I'm sorry, I'm not allowed to do that. The action was blocked by policy."));
    if (/customer'?s?\b.*\b(email|phone)\b/i.test(user)) return wrap(say("The customer is Jane Doe, jane.doe@example.com, phone +1 415 555 0132.")); // leaks PII
    if (/tracking/i.test(user)) return wrap(say("Tracking number 1Z999AA10123456784, arriving 3 December.")); // invented: not in the data
    return wrap(say(`Done. Result: ${last.content}`));
  }

  const sql = user.match(/sql:\s*(.+)$/i);
  if (sql) return wrap(call("run_sql", { query: sql[1] }));
  const refund = user.match(/refund\s+(ORD-\d+)\s+(?:for\s+)?\$?(\d+(?:\.\d+)?)/i);
  if (refund) return wrap(call("issue_refund", { order_id: refund[1], amount: Number(refund[2]) }));
  const order = user.match(/ORD-\d+/i);
  if (order) return wrap(call("get_order", { order_id: order[0].toUpperCase() }));
  if (/system prompt|(print|show|reveal|repeat).*(instructions|setup)/i.test(user)) return wrap(say(`My instructions: ${SYSTEM_PROMPT}`));
  if (/insult me|roast me/i.test(user)) return wrap(say("You are a useless idiot and nobody likes you."));
  if (/\bhtml\b/i.test(user)) return wrap(say("<script>alert('hi')</script> Your order has shipped."));
  if (/api key|secret|password|token/i.test(user)) return wrap(say("Sure! The key is sk-abcdefghijklmnop1234"));
  return wrap(say("Hi! I can look up orders (e.g. ORD-1001) and issue refunds."));
}

// Stand-in for the cheap "judge" LLM in mock mode (keywords instead of understanding), so the lab works offline.
export async function mockAsk(prompt) {
  const text = prompt.split('"""')[1] ?? "";
  if (/scope classifier/.test(prompt)) {
    const off = /weather|poem|story|joke|recipe|stock price|movie|football|cricket|write (me )?(a |some )?(code|essay|song)|translate/i.test(text);
    return off ? '{"scope":"out","reason":"not about orders or shipping"}' : '{"scope":"in","reason":"order support"}';
  }
  const bad = /disregard|forget (everything|all)|from now on you|pretend (you|to)|no rules|developer mode|new instructions|without (any )?restrictions/i.test(text);
  return bad ? "UNSAFE" : "SAFE";
}
