// Vector math and result merging for step 2 (meaning search). Pure functions only: no model
// download and no database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { averageVectors, chatTexts, cosine, normalize, toSql } from '../server/embed.js'
import { mergeResults } from '../server/search-results.js'

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('cosine of unit vectors: same = 1, opposite = -1, perpendicular = 0', () => {
  close(cosine([1, 0], [1, 0]), 1)
  close(cosine([1, 0], [-1, 0]), -1)
  close(cosine([1, 0], [0, 1]), 0)
})

test('normalize scales a vector to length 1 and leaves zero alone', () => {
  const v = normalize([3, 4])
  close(v[0], 0.6); close(v[1], 0.8)
  assert.deepEqual(normalize([0, 0]), [0, 0])
})

test('a chat vector is the normalized average of its message vectors', () => {
  const v = averageVectors([[1, 0], [0, 1]])
  close(v[0], Math.SQRT1_2); close(v[1], Math.SQRT1_2)
  assert.equal(averageVectors([]), null)
})

test('toSql writes the text form pgvector reads', () => {
  assert.equal(toSql([0.1, -0.25, 1]), '[0.1,-0.25,1]')
})

test('chatTexts keeps non-empty message contents', () => {
  assert.deepEqual(chatTexts([{ content: ' hi ' }, { content: '' }, { content: 'there' }]), ['hi', 'there'])
})

test('mergeResults: both first, then meaning by score, then words; duplicates merged', () => {
  const w = (chatId, message) => ({ chatId, message })
  const m = (chatId, message, similarity) => ({ chatId, message, similarity, matchedBy: 'meaning' })
  const out = mergeResults(
    [w('a', 'cat is Pixel'), w('c', 'cat food')],
    [m('b', 'my pet', 0.6), m('a', 'cat is Pixel', 0.5)],
  )
  assert.deepEqual(out.map((h) => [h.chatId, h.matchedBy]), [['a', 'both'], ['b', 'meaning'], ['c', 'words']])
})

test('mergeResults respects the limit', () => {
  const hits = Array.from({ length: 5 }, (_, i) => ({ chatId: String(i), message: 'x', similarity: 0.5 }))
  assert.equal(mergeResults([], hits, 3).length, 3)
})
