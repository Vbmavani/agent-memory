// Live eval of the memory decision: scripted situations (eval/memory-cases.js) with expected outcomes.
// Uses no database; it runs decideMemory + mergeFacts/mergeProcedures in memory.
//   npm run eval:memory                                              # DeepSeek (default)
//   LLM_PROVIDER=openrouter MEMORY_MODEL=openai/gpt-5-nano npm run eval:memory
// Each case runs RUNS times (default 2) because model output varies; a case passes only if every
// run passes. CASES=1,3,5 runs only those cases. A full report (inputs, the model's raw JSON, final
// memory, verdict, tokens, time) is written to eval/results/<model>-<date>.json.
import fs from 'node:fs'
import { decideMemory, mergeFacts, mergeProcedures, MEMORY_MODEL, MEMORY_REASONING } from '../server/memory.js'
import { provider } from '../server/deepseek.js'
import { CASES } from './memory-cases.js'

const RUNS = Number(process.env.RUNS ?? 2)
const only = process.env.CASES ? new Set(process.env.CASES.split(',').map(Number)) : null
const user = (facts, procedures = []) => ({ name: 'Test User', email: null, bio: '', facts, procedures })

const report = { model: MEMORY_MODEL, provider: provider().name, reasoning: MEMORY_REASONING, runs: RUNS, startedAt: new Date().toISOString(), cases: [] }
let passed = 0, ran = 0, tokens = 0
console.log(`memory eval · ${provider().name} · ${MEMORY_MODEL}${MEMORY_REASONING ? ` (reasoning: ${MEMORY_REASONING})` : ''} · ${RUNS} runs per case\n`)
for (const [i, c] of CASES.entries()) {
  if (only && !only.has(i + 1)) continue
  ran++
  const runs = []
  for (let r = 0; r < RUNS; r++) {
    const t = Date.now()
    const d = await decideMemory({ user: user(c.facts, c.procedures ?? []), text: c.text, previousReply: c.previousReply ?? '', requests: c.requests ?? [] })
    const ms = Date.now() - t
    tokens += d.tokens
    const { facts } = mergeFacts(c.facts, d.ops)
    const { procedures } = mergeProcedures(c.procedures ?? [], d.procOps)
    runs.push({
      ok: d.ok && c.check(facts, procedures),
      ms, tokens: d.tokens, error: d.error ?? null,
      modelJson: d.raw ?? null,
      finalFacts: facts.map((f) => f.text),
      finalProcedures: procedures.map((p) => ({ when: p.when, do: p.do })),
    })
  }
  const ok = runs.every((r) => r.ok)
  if (ok) passed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(i + 1).padStart(2)}. ${c.name}`)
  if (!ok) runs.filter((r) => !r.ok).forEach((r) => console.log(`        got: ${JSON.stringify([...r.finalFacts, ...r.finalProcedures.map((p) => `[proc] when ${p.when}: ${p.do}`)])}${r.error ? `  error: ${r.error}` : ''}`))
  report.cases.push({
    n: i + 1, name: c.name, pass: ok,
    input: { facts: c.facts, procedures: c.procedures ?? [], message: c.text, requests: c.requests ?? [], previousReply: c.previousReply ? c.previousReply.slice(0, 120) + '…' : '' },
    grader: c.check.toString(),
    runs,
  })
}
const ms = report.cases.flatMap((c) => c.runs.map((r) => r.ms))
report.summary = { passed, cases: ran, tokens, avgMs: Math.round(ms.reduce((a, b) => a + b, 0) / (ms.length || 1)) }
fs.mkdirSync(new URL('./results/', import.meta.url), { recursive: true })
const tag = process.env.EVAL_TAG ? `-${process.env.EVAL_TAG}` : ''
const file = new URL(`./results/${MEMORY_MODEL.replace(/\W+/g, '-')}${tag}-${report.startedAt.slice(0, 10)}.json`, import.meta.url)
fs.writeFileSync(file, JSON.stringify(report, null, 2))
console.log(`\n${passed}/${ran} cases passed (${RUNS} runs each, ${tokens} tokens, avg ${report.summary.avgMs} ms per call)`)
console.log(`report: eval/results/${file.pathname.split('/').pop()}`)
process.exit(passed === ran ? 0 : 1)
