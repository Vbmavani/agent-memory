// Testing the eval itself. A grader (a case's `check`) is only useful if it passes right answers AND
// fails wrong ones. For every case in eval/memory-cases.js this feeds a hand-written correct final
// memory (must pass) and typical wrong ones (must fail). No model calls, so it runs in milliseconds.
//   npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CASES, STANDUP } from '../eval/memory-cases.js'

// Facts can be written as plain strings; ids are added unless given.
const F = (...items) => items.map((x, i) => (typeof x === 'string' ? { id: `f${i}`, text: x } : x))
const P = (when, d, id = 'p0') => ({ id, when, do: d })
const SU = STANDUP[0]

// case number -> { good: [facts, procedures], bad: { why: [facts, procedures] } }
const FIXTURES = {
  1: { good: [F('User lives in Lyon, France'), []],
       bad: { 'two location facts': [F('User lives in Lyon', 'User is currently in France'), []],
              'lost Lyon': [F('User is currently in France'), []] } },
  2: { good: [F('User lives in Lyon, France'), []],
       bad: { 'two location facts': [F('User lives in Lyon', 'User is in France'), []] } },
  3: { good: [F('User lives in Berlin'), []],
       bad: { 'not updated': [F('User lives in Pune'), []], 'both cities': [F('User lives in Pune', 'User lives in Berlin'), []] } },
  4: { good: [F('User likes Thai food'), []],
       bad: { 'saved small talk': [F('User likes Thai food', 'User finds the weather grey today'), []] } },
  5: { good: [[], []],
       bad: { 'saved a question': [F('User asked a question'), []] } },
  6: { good: [F('User likes Thai food', "User's favourite drink is mango lassi"), []],
       bad: { 'saved twice': [F('User likes Thai food', "User's favourite drink is mango lassi", 'User drinks mango lassi'), []],
              'not saved': [F('User likes Thai food'), []] } },
  7: { good: [F("User's favourite drink is masala chai"), []],
       bad: { 'old one kept': [F("User's favourite drink is mango lassi", "User's favourite drink is masala chai"), []],
              'not corrected': [F("User's favourite drink is mango lassi"), []] } },
  8: { good: [[{ id: 'food', text: 'User likes Thai food' }], []],
       bad: { 'hiking kept': [[{ id: 'hike', text: 'User goes hiking every weekend' }, { id: 'food', text: 'User likes Thai food' }], []],
              'wrong fact deleted': [[{ id: 'hike', text: 'User goes hiking every weekend' }], []] } },
  9: { good: [F('User is allergic to peanuts'), []],
       bad: { duplicate: [F('User is allergic to peanuts', 'User has a peanut allergy'), []] } },
  10: { good: [[], [P("the user says 'standup'", 'Ask yesterday, today and blockers one at a time, then a short Slack message')]],
        bad: { 'also saved a fact': [F('User does standups'), [P("the user says 'standup'", 'Ask yesterday, today and blockers')]],
               'nothing saved': [[], []] } },
  11: { good: [[], [P('explaining a technical concept', 'Give 3 bullets and one example')]],
        bad: { 'saved as a fact': [F('User wants 3 bullets and one example'), []] } },
  12: { good: [[], []],
        bad: { 'one-off saved as a rule': [[], [P('answering', 'Keep answers short')]] } },
  13: { good: [[], [SU]],
        bad: { 'saved the answer as a fact': [F('User fixed the login bug'), [SU]],
               'routine rewritten': [[], [{ ...SU, do: 'Ask about the login bug' }]] } },
  14: { good: [[], [{ ...SU, do: 'Ask how their energy is, then yesterday, today and any blockers, one at a time' }]],
        bad: { 'old steps lost': [[], [{ ...SU, do: 'Ask how their energy is' }]],
               'added a second routine': [[], [SU, P("the user says 'standup'", 'Ask about energy first', 'p9')]] } },
  15: { good: [[], []],
        bad: { 'not deleted': [[], [SU]] } },
  16: { good: [[], [P('searching past chats', 'Use 2-3 distinctive keywords; retry with synonyms')]],
        bad: { 'lesson not saved': [[], []], 'saved as a fact': [F('User found the chat with keywords'), []] } },
}

test('every eval case has grader fixtures', () => {
  assert.equal(Object.keys(FIXTURES).length, CASES.length)
})

CASES.forEach((c, i) => {
  const fx = FIXTURES[i + 1]
  test(`grader ${i + 1} passes a right answer: ${c.name}`, () => {
    assert.equal(c.check(...fx.good), true)
  })
  for (const [why, outcome] of Object.entries(fx.bad)) {
    test(`grader ${i + 1} fails a wrong answer (${why})`, () => {
      assert.equal(c.check(...outcome), false)
    })
  }
})

// Known gaps: wrong answers the current graders still let through. They're marked `todo`, so they
// show up in every test run (as TODO) without failing it, until the grader is tightened.
const GAPS = {
  2: { 'lost Lyon, kept only France': [F('User is in France'), []] },
  4: { 'replaced the food fact with small talk': [F('User finds the weather grey today'), []] },
  9: { 'duplicate worded without "peanut"': [F('User is allergic to peanuts', 'User has a nut allergy'), []] },
}
for (const [n, gaps] of Object.entries(GAPS)) {
  for (const [why, outcome] of Object.entries(gaps)) {
    test(`grader ${n} should fail (${why})`, { todo: 'grader too loose' }, () => {
      assert.equal(CASES[n - 1].check(...outcome), false)
    })
  }
}
