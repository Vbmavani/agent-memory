// Graph memory: the pure parts (names, validation, merge rules). No model, no database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanTriples, mergeEdges, nodeKey, relKey } from '../server/graph.js'

const T = (from, rel, to, extra = {}) => cleanTriples([{ from, relation: rel, to, ...extra }])
const NOW = '2026-11-07T10:00:00.000Z', LATER = '2026-11-08T10:00:00.000Z'

test('node names are matched ignoring case, accents and punctuation; the user is always "you"', () => {
  assert.equal(nodeKey('  ANA! '), 'ana')
  assert.equal(nodeKey('José'), 'jose')
  for (const me of ['You', 'me', 'I', 'the user', 'User']) assert.equal(nodeKey(me), 'you')
  assert.equal(relKey('Works At'), 'works_at')
})

test('cleanTriples keeps well-formed edges and drops junk', () => {
  const t = cleanTriples([
    { from: 'You', relation: 'works at', to: 'Acme' },
    { from: 'You', relation: 'works_at' },                 // no target
    { from: 'Ana', relation: 'knows', to: 'ana' },         // an edge to itself
    'nonsense', null, { from: '', relation: 'x', to: 'y' },
  ])
  assert.equal(t.length, 1)
  assert.deepEqual([t[0].from, t[0].rel, t[0].to], ['You', 'works_at', 'Acme'])
})

test('a new edge is added; the same edge again is skipped', () => {
  const a = mergeEdges([], T('You', 'has_pet', 'Rex'), { now: NOW })
  assert.equal(a.edges.length, 1)
  assert.deepEqual(a.changed.map((c) => c.op), ['add'])
  const b = mergeEdges(a.edges, T('you', 'HAS PET', 'rex'), { now: LATER })
  assert.equal(b.edges.length, 1)
  assert.equal(b.changed.length, 0)
})

test('a single-valued relation closes the old edge instead of keeping two homes', () => {
  const a = mergeEdges([], T('You', 'lives_in', 'Lyon'), { now: NOW })
  const b = mergeEdges(a.edges, T('You', 'lives_in', 'Berlin'), { now: LATER })
  assert.deepEqual(b.changed.map((c) => [c.op, c.to]), [['end', 'Lyon'], ['add', 'Berlin']])
  assert.equal(b.edges.find((e) => e.to === 'Lyon').until, LATER)   // closed, not deleted: history is kept
  assert.equal(b.edges.find((e) => e.to === 'Berlin').until, null)
})

test('a many-valued relation keeps every value', () => {
  const a = mergeEdges([], T('You', 'has_pet', 'Rex'), { now: NOW })
  const b = mergeEdges(a.edges, T('You', 'has_pet', 'Luna'), { now: LATER })
  assert.equal(b.edges.filter((e) => !e.until).length, 2)
})

test('"ended" closes a true edge and ignores one that is not there', () => {
  const a = mergeEdges([], T('You', 'works_at', 'Acme'), { now: NOW })
  const b = mergeEdges(a.edges, T('You', 'works_at', 'Acme', { ended: true }), { now: LATER })
  assert.deepEqual(b.changed.map((c) => c.op), ['end'])
  const c = mergeEdges(b.edges, T('You', 'works_at', 'Acme', { ended: true }), { now: LATER })
  assert.equal(c.changed.length, 0)
})
