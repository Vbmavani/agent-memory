// Live eval of the memory decision against DeepSeek: scripted situations with expected outcomes.
// Uses no database; it runs decideMemory + mergeFacts in memory.  npm run eval:memory
// Each case runs RUNS times because model output varies; a case passes only if every run passes.
import { decideMemory, mergeFacts } from '../server/memory.js'

const RUNS = Number(process.env.RUNS ?? 2)
const user = (facts) => ({ name: 'Test User', email: null, bio: '', facts })
const has = (facts, re) => facts.filter((f) => re.test(f.text)).length

const CASES = [
  {
    name: 'explicit "I am in France" with an existing Lyon fact -> one location fact',
    facts: [{ id: 'loc', text: 'User lives in Lyon' }],
    text: 'Remember that I am in France.',
    requests: [{ action: 'remember', text: 'User is currently in France' }],
    check: (f) => has(f, /lyon|france/i) === 1 && has(f, /lyon/i) === 1,
  },
  {
    name: 'automatic "I am in France" with an existing Lyon fact -> one location fact',
    facts: [{ id: 'loc', text: 'User lives in Lyon' }],
    text: "By the way, I'm in France.",
    check: (f) => has(f, /lyon|france/i) === 1,
  },
  {
    name: 'moved city -> update, not a second city',
    facts: [{ id: 'loc', text: 'User lives in Pune' }],
    text: 'Big news: I just moved to Berlin!',
    check: (f) => has(f, /berlin/i) === 1 && has(f, /pune/i) === 0,
  },
  {
    name: 'small talk -> nothing saved',
    facts: [{ id: 'food', text: 'User likes Thai food' }],
    text: 'Ugh, the weather is so grey today lol',
    check: (f) => f.length === 1,
  },
  {
    name: 'a question -> nothing saved',
    facts: [],
    text: 'What is the capital of France?',
    check: (f) => f.length === 0,
  },
  {
    name: 'explicit remember, nothing similar stored -> added once',
    facts: [{ id: 'food', text: 'User likes Thai food' }],
    text: 'Please remember that my favourite drink is mango lassi.',
    requests: [{ action: 'remember', text: "User's favourite drink is mango lassi" }],
    check: (f) => has(f, /drink/i) === 1 && f.length === 2,
  },
  {
    name: 'explicit correction -> replaced, not duplicated',
    facts: [{ id: 'drink', text: "User's favourite drink is mango lassi" }],
    text: 'Actually correct that: my favourite drink is masala chai.',
    requests: [{ action: 'remember', text: "User's favourite drink is masala chai", replaces_id: 'drink', replaces_text: "User's favourite drink is mango lassi" }],
    check: (f) => has(f, /drink/i) === 1 && has(f, /chai/i) === 1 && has(f, /lassi/i) === 0,
  },
  {
    name: 'forget two things, tool recorded only one -> both forgotten',
    facts: [
      { id: 'drink', text: "User's favourite drink is masala chai" },
      { id: 'hike', text: 'User goes hiking every weekend' },
      { id: 'food', text: 'User likes Thai food' },
    ],
    text: 'Please forget my favourite drink and that I go hiking.',
    requests: [{ action: 'forget', id: 'drink', text: "User's favourite drink is masala chai" }],
    check: (f) => f.length === 1 && f[0].id === 'food',
  },
  {
    name: 'already known -> no duplicate',
    facts: [{ id: 'allergy', text: 'User is allergic to peanuts' }],
    text: "Just so you know, I'm allergic to peanuts.",
    check: (f) => has(f, /peanut/i) === 1,
  },
]

let passed = 0
let tokens = 0
for (const c of CASES) {
  const runs = []
  for (let i = 0; i < RUNS; i++) {
    const d = await decideMemory({ user: user(c.facts), text: c.text, requests: c.requests ?? [] })
    tokens += d.tokens
    const { facts } = mergeFacts(c.facts, d.ops)
    runs.push({ ok: d.ok && c.check(facts), facts: facts.map((f) => f.text), error: d.error })
  }
  const ok = runs.every((r) => r.ok)
  if (ok) passed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!ok) runs.filter((r) => !r.ok).forEach((r) => console.log(`        got: ${JSON.stringify(r.facts)}${r.error ? `  error: ${r.error}` : ''}`))
}
console.log(`\n${passed}/${CASES.length} cases passed (${RUNS} runs each, ${tokens} tokens)`)
process.exit(passed === CASES.length ? 0 : 1)
