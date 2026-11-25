// TOOL-CALL GUARDRAILS: the most important layer.
// Enforced in code, not in the prompt, so a jailbroken model still can't bypass it.

// Policy per tool: allowlist + argument validation + risk level.
export const POLICY = {
  get_order: {
    risk: "low",
    validate: (a) =>
      /^ORD-\d{4,8}$/.test(a.order_id ?? "") ? null : "order_id must look like ORD-12345",
  },
  run_sql: {
    risk: "medium",
    validate: (a) => {
      const q = String(a.query ?? "").trim();
      if (!/^select\s/i.test(q)) return "only SELECT queries are allowed";
      if (/;\s*\S/.test(q)) return "multiple statements are not allowed";
      if (/\b(drop|delete|update|insert|alter|truncate|grant)\b/i.test(q))
        return "write/DDL keywords are not allowed";
      return null;
    },
  },
  issue_refund: {
    risk: "high", // needs a human
    validate: (a) => {
      if (!/^ORD-\d{4,8}$/.test(a.order_id ?? "")) return "bad order_id";
      if (!(typeof a.amount === "number" && a.amount > 0 && a.amount <= 500))
        return "amount must be a number between 0 and 500";
      return null;
    },
  },
};

/**
 * Decide whether a tool call may run.
 * `approve` is an async (name, args) => boolean callback (CLI prompt, Slack button, etc.)
 * Returns { allow: boolean, reason?: string }
 */
export async function checkToolCall(name, args, approve) {
  const policy = POLICY[name];
  if (!policy) return { allow: false, reason: `tool "${name}" is not allowed` };

  if (typeof args !== "object" || args === null)
    return { allow: false, reason: "arguments must be an object" };

  const problem = policy.validate(args);
  if (problem) return { allow: false, reason: problem };

  if (policy.risk === "high") {
    const ok = await approve(name, args);
    if (!ok) return { allow: false, reason: "human approval denied" };
  }
  return { allow: true };
}
