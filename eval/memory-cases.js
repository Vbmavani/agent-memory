// The memory eval's test cases, shared by the live eval (eval/memory-eval.js) and the grader
// tests (test/eval-graders.test.js). Each case is one situation:
//   facts / procedures  what memory already holds
//   text                the new user message (previousReply: what the assistant said before it)
//   requests            what the chat model's memory tools recorded, if anything
//   check(facts, procs) the grader: plain code that says whether the final memory is right
export const has = (facts, re) => facts.filter((f) => re.test(f.text)).length
export const hasProc = (procs, re) => procs.filter((p) => re.test(`${p.when} ${p.do}`)).length
export const STANDUP = [{ id: 'su', when: "the user says 'standup'", do: 'Ask what they did yesterday, what they will do today and any blockers, one question at a time, then write a short Slack-ready summary.' }]
export const LONG_REPLY = '## How JWT works\n\nA JSON Web Token has three parts: a header, a payload and a signature... ' + 'More detail about claims, signing algorithms, expiry and refresh tokens. '.repeat(25)

export const CASES = [
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
  // ---------- procedural memory ----------
  {
    name: 'teaching a routine -> one procedure, no facts',
    facts: [],
    text: "From now on, when I say 'standup', ask me what I did yesterday, what I'm doing today and any blockers, one at a time, then give me a short Slack message.",
    check: (f, p) => f.length === 0 && p.length === 1 && /standup/i.test(p[0].when) && /blocker/i.test(p[0].do),
  },
  {
    name: 'correction of how it answered, meant for the future -> procedure, not a fact',
    facts: [],
    previousReply: LONG_REPLY,
    text: 'Too long. For tech explanations, give me 3 bullets and one example.',
    check: (f, p) => f.length === 0 && p.length === 1 && /3|three/i.test(p[0].do) && /example/i.test(p[0].do),
  },
  {
    name: 'one-off tweak of this answer -> nothing',
    facts: [],
    previousReply: LONG_REPLY,
    text: 'Can you make that one shorter?',
    check: (f, p) => f.length === 0 && p.length === 0,
  },
  {
    name: 'answers during a running routine -> nothing saved',
    facts: [],
    procedures: STANDUP,
    previousReply: 'Standup time! What did you get done yesterday?',
    text: 'Fixed the login bug and reviewed two PRs.',
    check: (f, p) => f.length === 0 && p.length === 1 && p[0].do === STANDUP[0].do,
  },
  {
    name: 'refining a routine -> updated in place, old steps kept',
    facts: [],
    procedures: STANDUP,
    text: 'For standup, also ask how my energy is before the other questions.',
    check: (f, p) => p.length === 1 && p[0].id === 'su' && /energy/i.test(p[0].do) && /blocker/i.test(p[0].do),
  },
  {
    name: 'stop a routine -> procedure deleted',
    facts: [],
    procedures: STANDUP,
    text: "Let's drop the standup thing, I don't need it anymore.",
    check: (f, p) => p.length === 0,
  },
  {
    name: 'assistant-recorded lesson -> stored as a procedure',
    facts: [],
    text: 'Yes, that was the chat, thanks!',
    requests: [{ action: 'learn_procedure', when: 'searching past chats', do: 'Search with 2-3 distinctive keywords, not full sentences; if nothing is found, retry with synonyms.' }],
    check: (f, p) => f.length === 0 && hasProc(p, /keyword/i) === 1,
  },
]
