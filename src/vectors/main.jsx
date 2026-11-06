// Word vectors with just 3 numbers: a hands-on playground for "similar meaning = similar direction".
// No AI model here: the numbers are written by hand, so every step can be checked on paper.
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { angleDeg, cosine, dot, length, nearest } from './math.js'
import './vectors.css'

// Each word is 3 scores from 0 to 1: [how much it is an animal, how much it is food, how big it is]
const DIMS = ['Animal', 'Food', 'Big']
const STARTER = [
  { name: 'cat', v: [0.9, 0.1, 0.2] },
  { name: 'dog', v: [0.9, 0.1, 0.4] },
  { name: 'mouse', v: [0.9, 0, 0.05] },
  { name: 'lion', v: [1, 0, 0.7] },
  { name: 'elephant', v: [1, 0, 1] },
  { name: 'chicken', v: [0.7, 0.7, 0.2] },
  { name: 'apple', v: [0, 0.9, 0.15] },
  { name: 'banana', v: [0, 0.9, 0.2] },
  { name: 'pizza', v: [0, 1, 0.35] },
  { name: 'watermelon', v: [0, 0.8, 0.5] },
  { name: 'car', v: [0, 0, 0.7] },
  { name: 'truck', v: [0, 0, 0.95] },
]

const KEY = 'vectors:custom'
const loadCustom = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? [] } catch { return [] } }
const saveCustom = (w) => { try { localStorage.setItem(KEY, JSON.stringify(w)) } catch {} }

const f2 = (x) => (Math.round(x * 100) / 100).toString()
const sc = (x) => x.toFixed(2) // similarity scores always with 2 decimals
const vec = (v) => `[${v.map(f2).join(', ')}]`
function meaning(score) {
  if (score >= 0.95) return 'almost the same'
  if (score >= 0.8) return 'very similar'
  if (score >= 0.5) return 'somewhat similar'
  if (score >= 0.2) return 'a little similar'
  return 'unrelated'
}

// ---------- 3D picture: each word is an arrow from the corner (0,0,0) ----------
// Screen axes: Animal -> x, Big -> up, Food -> depth. Drag to turn it.
function project(v, rot, size) {
  const x = v[0] - 0.5, y = v[2] - 0.5, z = v[1] - 0.5
  const cy = Math.cos(rot.yaw), sy = Math.sin(rot.yaw)
  const x1 = x * cy - z * sy, z1 = x * sy + z * cy
  const cp = Math.cos(rot.pitch), sp = Math.sin(rot.pitch)
  const y1 = y * cp - z1 * sp
  const s = size * 0.5
  return [size / 2 + x1 * s, size / 2 - y1 * s]
}

function Space({ words, a, b, draft }) {
  const ref = useRef(null)
  const [size, setSize] = useState(420)
  const [rot, setRot] = useState({ yaw: 0.55, pitch: 0.35 })
  const drag = useRef(null)

  useEffect(() => {
    const el = ref.current
    const ro = new ResizeObserver(([e]) => setSize(Math.min(480, Math.floor(e.contentRect.width))))
    ro.observe(el.parentElement)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const cv = ref.current
    const dpr = window.devicePixelRatio || 1
    cv.width = size * dpr
    cv.height = size * dpr
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const css = getComputedStyle(document.documentElement)
    const c = (n) => css.getPropertyValue(n).trim()
    const P = (v) => project(v, rot, size)
    g.clearRect(0, 0, size, size)
    g.lineWidth = 1
    // a name next to a point; flips to the left when it would run off the canvas
    const label = (text, x, y) => {
      const w = g.measureText(text).width
      g.fillText(text, x + 7 + w > size - 2 ? x - 7 - w : x + 7, y)
    }

    // the box (all scores between 0 and 1)
    const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => [x, y, z])))
    g.strokeStyle = c('--line')
    for (const p of corners) for (const q of corners) {
      if (p.reduce((n, _, i) => n + (p[i] !== q[i]), 0) !== 1 || p.join() > q.join()) continue
      const [x1, y1] = P(p), [x2, y2] = P(q)
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke()
    }
    // the three axes
    g.font = '600 12px system-ui, sans-serif'
    DIMS.forEach((name, i) => {
      const end = [0, 0, 0]; end[i] = 1.12
      const [x0, y0] = P([0, 0, 0]), [x1, y1] = P(end)
      g.strokeStyle = c('--muted'); g.lineWidth = 1.5
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke()
      g.fillStyle = c('--muted'); label(name, x1 - 3, y1 + 4)
    })

    const arrow = (v, color, dashed) => {
      const [x0, y0] = P([0, 0, 0]), [x1, y1] = P(v)
      g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2.5
      g.setLineDash(dashed ? [6, 4] : [])
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke()
      g.setLineDash([])
      const ang = Math.atan2(y1 - y0, x1 - x0)
      g.beginPath(); g.moveTo(x1, y1)
      g.lineTo(x1 - 10 * Math.cos(ang - 0.4), y1 - 10 * Math.sin(ang - 0.4))
      g.lineTo(x1 - 10 * Math.cos(ang + 0.4), y1 - 10 * Math.sin(ang + 0.4))
      g.closePath(); g.fill()
    }
    if (draft) arrow(draft.v, c('--warn'), true)
    if (b) arrow(b.v, c('--good'))
    if (a) arrow(a.v, c('--accent'))

    // every word as a dot with its name
    for (const w of words) {
      const [x, y] = P(w.v)
      const hot = w.name === a?.name ? '--accent' : w.name === b?.name ? '--good' : null
      g.fillStyle = hot ? c(hot) : c('--ink')
      g.beginPath(); g.arc(x, y, hot ? 5 : 3.5, 0, Math.PI * 2); g.fill()
      g.font = hot ? '700 13px system-ui, sans-serif' : '12px system-ui, sans-serif'
      g.fillStyle = hot ? c(hot) : c('--muted')
      label(w.name, x, y - 6)
    }
    if (draft) {
      const [x, y] = P(draft.v)
      g.fillStyle = c('--warn'); g.font = '700 13px system-ui, sans-serif'
      label(draft.name || 'your word', x, y - 6)
    }
  }, [words, a, b, draft, rot, size])

  return (
    <canvas
      ref={ref}
      className="space"
      style={{ width: size, height: size }}
      aria-label="3D picture of the word vectors. Drag to rotate."
      onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y
        drag.current = { x: e.clientX, y: e.clientY }
        setRot((r) => ({ yaw: r.yaw + dx * 0.01, pitch: Math.max(-1.4, Math.min(1.4, r.pitch + dy * 0.01)) }))
      }}
      onPointerUp={() => { drag.current = null }}
    />
  )
}

// ---------- the step-by-step math for two words ----------
function Math3({ a, b }) {
  const d = dot(a.v, b.v), la = length(a.v), lb = length(b.v), s = cosine(a.v, b.v)
  const terms = (x, y) => x.map((n, i) => `${f2(n)}×${f2(y[i])}`).join(' + ')
  const squares = (x) => x.map((n) => `${f2(n)}²`).join(' + ')
  return (
    <div className="card math">
      <h2>How <span className="a">{a.name}</span> vs <span className="b">{b.name}</span> is worked out</h2>
      <pre>{`${a.name.padEnd(10)} = ${vec(a.v)}
${b.name.padEnd(10)} = ${vec(b.v)}

1. multiply matching numbers, add up   ${terms(a.v, b.v)} = ${f2(d)}
2. length of ${a.name} arrow            √(${squares(a.v)}) = ${f2(la)}
3. length of ${b.name} arrow            √(${squares(b.v)}) = ${f2(lb)}
4. similarity = step 1 ÷ (step 2 × step 3) = ${f2(d)} ÷ (${f2(la)} × ${f2(lb)}) = ${sc(s)}`}</pre>
      <p className="verdict">
        <b>{sc(s)}</b> means <b>{meaning(s)}</b>. The two arrows are <b>{Math.round(angleDeg(a.v, b.v))}°</b> apart
        (0° = pointing the same way, 90° = nothing in common).
      </p>
    </div>
  )
}

function App() {
  const [custom, setCustom] = useState(loadCustom)
  const words = useMemo(() => [...STARTER, ...custom], [custom])
  const [aName, setA] = useState('cat')
  const [bName, setB] = useState('dog')
  const [draft, setDraft] = useState({ name: '', v: [0.5, 0.5, 0.5] })
  const a = words.find((w) => w.name === aName) ?? words[0]
  const ranked = nearest(a.v, words, a.name)
  const b = words.find((w) => w.name === bName && w.name !== a.name) ?? ranked[0]
  const draftNearest = nearest(draft.v, words).slice(0, 3)
  const draftName = draft.name.trim().toLowerCase()
  const taken = words.some((w) => w.name === draftName)

  const updateCustom = (next) => { setCustom(next); saveCustom(next) }
  function addDraft(e) {
    e.preventDefault()
    if (!draftName || taken) return
    updateCustom([...custom, { name: draftName, v: draft.v, mine: true }])
    setA(draftName)
    setDraft({ name: '', v: [0.5, 0.5, 0.5] })
  }

  return (
    <div className="page">
      <header>
        <a href="/" className="back">← Chat</a>
        <h1>Word vectors, with only 3 numbers</h1>
        <p className="lead">
          A vector is just a list of numbers. Here every word gets 3 scores from 0 to 1:
          {' '}<b>how much it is an animal</b>, <b>how much it is food</b>, and <b>how big it is</b>.
          Draw those 3 numbers as an arrow and <b>words with similar meaning point the same way</b>.
          That is all "vector search" is.
        </p>
      </header>

      <div className="grid">
        <section className="card">
          <h2>The space <span className="hint">drag to turn it</span></h2>
          <div className="space-wrap"><Space words={words} a={a} b={b} draft={draftName || draft.v.some((n) => n !== 0.5) ? { ...draft, name: draftName } : null} /></div>
          <p className="legend">
            <span className="a">● {a.name}</span> <span className="b">● {b.name}</span>
            {(draftName || draft.v.some((n) => n !== 0.5)) && <span className="w">● {draftName || 'your word'}</span>}
          </p>
        </section>

        <section className="card">
          <h2>Words closest to <span className="a">{a.name}</span></h2>
          <p className="hint">Pick a word in the table below. Click a row here to see the math.</p>
          <ol className="ranks">
            {ranked.map((w) => (
              <li key={w.name}>
                <button className={w.name === b.name ? 'on' : ''} onClick={() => setB(w.name)}>
                  <span className="rname">{w.name}</span>
                  <span className="bar"><span style={{ width: `${Math.max(0, w.score) * 100}%` }} /></span>
                  <span className="score">{sc(w.score)}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <Math3 a={a} b={b} />

      <div className="grid">
        <section className="card">
          <h2>All words</h2>
          <table>
            <thead><tr><th>Word</th>{DIMS.map((d) => <th key={d}>{d}</th>)}<th /></tr></thead>
            <tbody>
              {words.map((w) => (
                <tr key={w.name} className={w.name === a.name ? 'sel' : ''} onClick={() => setA(w.name)}>
                  <td><button className="link">{w.name}</button></td>
                  {w.v.map((n, i) => <td key={i} className="num">{f2(n)}</td>)}
                  <td>{w.mine && (
                    <button className="del" aria-label={`Remove ${w.name}`}
                      onClick={(e) => { e.stopPropagation(); updateCustom(custom.filter((c) => c.name !== w.name)) }}>×</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {custom.length > 0 && <button className="ghost" onClick={() => updateCustom([])}>Remove my words</button>}
        </section>

        <form className="card" onSubmit={addDraft}>
          <h2>Make your own word</h2>
          <p className="hint">Move the sliders. The dashed arrow shows where your word sits, and the closest words update live. That is exactly a search: "find words near this arrow".</p>
          <label className="field">Word<input value={draft.name} maxLength={20} placeholder="e.g. horse" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          {DIMS.map((d, i) => (
            <label key={d} className="slider">
              <span>{d}</span>
              <input type="range" min="0" max="1" step="0.05" value={draft.v[i]}
                onChange={(e) => setDraft({ ...draft, v: draft.v.map((n, j) => (j === i ? +e.target.value : n)) })} />
              <span className="num">{f2(draft.v[i])}</span>
            </label>
          ))}
          <p className="vec">vector = <b>{vec(draft.v)}</b></p>
          <p className="hint">Closest: {draftNearest.map((w) => `${w.name} (${sc(w.score)})`).join(', ')}</p>
          <button className="primary" disabled={!draftName || taken}>{taken ? 'That word exists' : `Add ${draftName ? `"${draftName}"` : 'word'}`}</button>
        </form>
      </div>

      <section className="card notes">
        <h2>Things to try</h2>
        <ul>
          <li><b>cat vs dog</b>: almost the same arrow, so 0.98. <b>cat vs apple</b>: nearly at right angles, so only 0.14.</li>
          <li><b>apple vs banana</b> score about 1.00: with only 3 numbers they look identical. Real models use about 1,000 numbers per word, so they can tell them apart.</li>
          <li><b>chicken</b> is half animal, half food, so it sits between the two groups.</li>
          <li><b>car vs elephant</b> scores 0.7 only because both are big. The numbers carry exactly the meaning you put in, nothing more.</li>
          <li>Make "horse" with Animal 0.9, Big 0.8 and see which words it lands near.</li>
        </ul>
        <h2>How this becomes memory later</h2>
        <p>
          An embedding model turns any text into a long vector for you (you don't pick the numbers).
          Store one vector per fact or message. When a question comes in, turn it into a vector too,
          and pull out the stored ones whose arrows point the most the same way, using the same
          similarity you see above.
        </p>
      </section>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)
