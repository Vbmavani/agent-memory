// Tests for the word-vector math used by the vectors playground (vectors.html).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dot, length, cosine, angleDeg, nearest } from '../src/vectors/math.js'

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('dot product and length', () => {
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 32)
  assert.equal(length([3, 4, 0]), 5)
})

test('cosine: same direction = 1, right angle = 0, length does not matter', () => {
  close(cosine([1, 0, 0], [5, 0, 0]), 1)
  close(cosine([0.2, 0.4, 0.6], [0.1, 0.2, 0.3]), 1)
  close(cosine([1, 0, 0], [0, 1, 0]), 0)
  close(angleDeg([1, 0, 0], [0, 1, 0]), 90)
  assert.equal(cosine([0, 0, 0], [1, 1, 1]), 0) // an all-zero vector has no direction
})

test('nearest ranks by similarity and skips the word itself', () => {
  const words = [
    { name: 'cat', v: [0.9, 0.1, 0.2] },
    { name: 'dog', v: [0.9, 0.1, 0.4] },
    { name: 'apple', v: [0, 0.9, 0.2] },
  ]
  const r = nearest(words[0].v, words, 'cat')
  assert.deepEqual(r.map((w) => w.name), ['dog', 'apple'])
  assert.ok(r[0].score > 0.9 && r[1].score < 0.3)
})
