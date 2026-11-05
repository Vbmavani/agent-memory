// Unit tests for the pure memory logic (no database, no network).  npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, validateOps, mergeFacts, requestsToOps, MAX_FACTS } from '../server/memory.js'

const facts = () => [
  { id: 'loc', text: 'User lives in Lyon' },
  { id: 'food', text: 'User likes Thai food' },
]
let n = 0
const opts = { now: '2026-01-01T00:00:00.000Z', source: { via: 'test' }, makeId: () => `new${++n}` }

test('normalize ignores case, punctuation and the "User" prefix', () => {
  assert.equal(normalize("User's favourite drink is Chai!"), normalize('user favourite drink is chai'))
  assert.equal(normalize('  User   lives in   Lyon. '), 'lives in lyon')
})

test('validateOps drops unknown ids, empty text, junk and duplicate adds', () => {
  const ops = validateOps([
    { op: 'update', id: 'nope', text: 'x' },
    { op: 'delete', id: 'nope' },
    { op: 'add', text: '   ' },
    { op: 'add', text: 'User likes thai food.' }, // same as an existing fact
    { op: 'add', text: 'User has a cat' },
    { op: 'add', text: 'user has a cat!' },           // duplicate within the batch
    null, 'garbage', { op: 'explode' },
  ], facts())
  assert.deepEqual(ops, [{ op: 'add', text: 'User has a cat' }])
})

test('validateOps keeps one decision per fact (last wins) and snapshots the text it saw', () => {
  const ops = validateOps([
    { op: 'update', id: 'loc', text: 'User lives in Montreal' },
    { op: 'update', id: 'loc', text: 'User lives in Lyon, France' },
  ], facts())
  assert.deepEqual(ops, [{ op: 'update', id: 'loc', expect: 'User lives in Lyon', text: 'User lives in Lyon, France' }])
})

test('validateOps handles a non-array model answer', () => {
  assert.deepEqual(validateOps(undefined, facts()), [])
  assert.deepEqual(validateOps({ op: 'add', text: 'x' }, facts()), [])
})

test('mergeFacts updates in place and keeps the previous value', () => {
  const ops = validateOps([{ op: 'update', id: 'loc', text: 'User lives in Lyon, France' }], facts())
  const r = mergeFacts(facts(), ops, opts)
  assert.equal(r.facts.length, 2)
  assert.equal(r.facts[0].text, 'User lives in Lyon, France')
  assert.deepEqual(r.facts[0].previous, ['User lives in Lyon'])
  assert.deepEqual(r.changed, [{ op: 'update', id: 'loc', text: 'User lives in Lyon, France', old: 'User lives in Lyon' }])
})

test('mergeFacts rejects a stale write (fact changed after the decision was made)', () => {
  const ops = validateOps([{ op: 'update', id: 'loc', text: 'User lives in Lyon, France' }], facts())
  const now = [{ id: 'loc', text: 'User lives in Berlin' }, facts()[1]] // someone else changed it
  const r = mergeFacts(now, ops, opts)
  assert.equal(r.facts[0].text, 'User lives in Berlin')
  assert.equal(r.changed.length, 0)
  assert.equal(r.skipped[0].reason, 'stale')
})

test('mergeFacts never stores the same fact twice', () => {
  const r = mergeFacts(facts(), [{ op: 'add', text: 'user likes THAI food!' }], opts)
  assert.equal(r.facts.length, 2)
  assert.equal(r.skipped[0].reason, 'duplicate')
})

test('mergeFacts merges an update that would duplicate another fact', () => {
  const r = mergeFacts(facts(), [{ op: 'update', id: 'food', text: 'User lives in Lyon' }], opts)
  assert.deepEqual(r.facts.map((f) => f.id), ['loc'])
  assert.equal(r.changed[0].op, 'delete')
  assert.equal(r.changed[0].mergedInto, 'User lives in Lyon')
})

test('mergeFacts deletes, and skips missing ids and no-op updates', () => {
  const r = mergeFacts(facts(), [
    { op: 'delete', id: 'food' },
    { op: 'delete', id: 'food' },
    { op: 'update', id: 'loc', text: 'user lives in lyon' },
  ], opts)
  assert.deepEqual(r.facts.map((f) => f.id), ['loc'])
  assert.deepEqual(r.skipped.map((s) => s.reason), ['missing', 'unchanged'])
})

test('mergeFacts stops adding at the memory limit', () => {
  const full = Array.from({ length: MAX_FACTS }, (_, i) => ({ id: `f${i}`, text: `User fact number ${i}` }))
  const r = mergeFacts(full, [{ op: 'add', text: 'User one more fact' }], opts)
  assert.equal(r.facts.length, MAX_FACTS)
  assert.equal(r.skipped[0].reason, 'full')
})

test('requestsToOps turns explicit requests into safe ops (fallback path)', () => {
  const ops = requestsToOps([
    { action: 'remember', text: 'User has a dog called Max' },
    { action: 'remember', text: 'User lives in Lyon, France', replaces_id: 'loc' },
    { action: 'forget', id: 'food' },
    { action: 'forget', id: 'unknown' },
  ], facts())
  assert.deepEqual(ops, [
    { op: 'add', text: 'User has a dog called Max' },
    { op: 'update', id: 'loc', expect: 'User lives in Lyon', text: 'User lives in Lyon, France' },
    { op: 'delete', id: 'food', expect: 'User likes Thai food' },
  ])
})

// ---------- procedural memory ----------
import { mergeProcedures, requestsToProcOps, MAX_PROCEDURES } from '../server/memory.js'

const procs = () => [
  { id: 'su', when: "the user says 'standup'", do: 'Ask about yesterday, today and blockers, then write a Slack summary.' },
]

test('procedure ops: one procedure per trigger, partial updates keep the other field', () => {
  const ops = validateOps([
    { op: 'add', when: "The user says 'Standup'!", do: 'Something else' }, // same trigger -> dropped
    { op: 'add', when: 'explaining a technical concept', do: '' },          // no instructions -> dropped
    { op: 'add', when: 'explaining a technical concept', do: 'Use 3 bullets and one example.' },
    { op: 'update', id: 'su', do: 'Ask about mood first, then yesterday, today and blockers.' },
  ], procs(), 'procedure')
  assert.deepEqual(ops, [
    { op: 'add', when: 'explaining a technical concept', do: 'Use 3 bullets and one example.' },
    { op: 'update', id: 'su', expect: "When the user says 'standup': Ask about yesterday, today and blockers, then write a Slack summary.",
      when: "the user says 'standup'", do: 'Ask about mood first, then yesterday, today and blockers.' },
  ])
})

test('mergeProcedures updates in place, keeps history, and rejects stale writes', () => {
  const ops = validateOps([{ op: 'update', id: 'su', do: 'Ask about mood first.' }], procs(), 'procedure')
  const r = mergeProcedures(procs(), ops, opts)
  assert.equal(r.procedures[0].do, 'Ask about mood first.')
  assert.equal(r.procedures[0].previous[0], "When the user says 'standup': Ask about yesterday, today and blockers, then write a Slack summary.")
  const changedMeanwhile = [{ ...procs()[0], do: 'Something newer' }]
  assert.equal(mergeProcedures(changedMeanwhile, ops, opts).skipped[0].reason, 'stale')
})

test('mergeProcedures never merges away instructions when a trigger collides', () => {
  const two = [...procs(), { id: 'wk', when: "the user says 'weekly'", do: 'List open tasks.' }]
  const ops = validateOps([{ op: 'update', id: 'wk', when: "the user says 'standup'" }], two, 'procedure')
  const r = mergeProcedures(two, ops, opts)
  assert.equal(r.procedures.length, 2)
  assert.equal(r.skipped[0].reason, 'duplicate')
})

test('mergeProcedures stops at the limit and facts/procedures requests stay separate', () => {
  const full = Array.from({ length: MAX_PROCEDURES }, (_, i) => ({ id: `p${i}`, when: `trigger ${i}`, do: 'x' }))
  assert.equal(mergeProcedures(full, [{ op: 'add', when: 'one more', do: 'y' }], opts).skipped[0].reason, 'full')
  const requests = [
    { action: 'remember', text: 'User has a dog' },
    { action: 'learn_procedure', when: 'the user says weekly', do: 'List open tasks.' },
    { action: 'forget_procedure', id: 'su' },
  ]
  assert.deepEqual(requestsToOps(requests, facts()), [{ op: 'add', text: 'User has a dog' }])
  assert.deepEqual(requestsToProcOps(requests, procs()).map((o) => o.op), ['add', 'delete'])
})
