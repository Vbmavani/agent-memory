// Graph memory lab: look at your graph, then WALK it (the same recursive Postgres query the chat's
// explore_graph tool runs) and see which connections each hop reaches. No model here.
const root = document.getElementById('root')
const state = { edges: [], start: 'you', hops: 2, history: false, walk: null, error: '', user: '' }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function api(path, init) {
  const r = await fetch('/api' + path, init)
  const d = await r.json()
  if (d.error) throw new Error(d.error)
  return d
}

const visible = () => state.edges.filter((e) => state.history || !e.until)
function nodesOf(edges) {
  const m = new Map()
  for (const e of edges) { m.set(e.fromKey, e.from); m.set(e.toKey, e.to) }
  return m
}

async function load() {
  try {
    const [g, me] = await Promise.all([api('/graph'), api('/profile')])
    state.edges = g.edges
    state.user = me.name
    const keys = [...nodesOf(visible()).keys()]
    if (!keys.includes(state.start)) state.start = keys.includes('you') ? 'you' : keys[0] ?? 'you'
    await doWalk()
  } catch (e) { state.error = e.message }
  render()
}

async function doWalk() {
  state.walk = visible().length
    ? await api(`/graph/walk?entity=${encodeURIComponent(state.start)}&hops=${state.hops}&history=${state.history ? 1 : 0}`)
    : null
}

// ---- drawing ----
const W = 640, H = 420
function layout(nodes, start) {
  const keys = [...nodes.keys()]
  const centre = keys.includes(start) ? start : keys[0]
  const others = keys.filter((k) => k !== centre)
  const pos = new Map()
  const box = (k) => { const w = Math.max(54, nodes.get(k).length * 7.4 + 22); return { hw: w / 2, hh: 16, w } }
  pos.set(centre, { x: W / 2, y: H / 2, ...box(centre) })
  others.forEach((k, i) => {
    const a = -Math.PI / 2 + (i / others.length) * Math.PI * 2
    pos.set(k, { x: W / 2 + Math.cos(a) * 250, y: H / 2 + Math.sin(a) * 160, ...box(k) })
  })
  return pos
}
const edgePoint = (a, b) => { // where the line from a to b meets b's box
  const dx = a.x - b.x, dy = a.y - b.y
  const t = Math.min(b.hw / (Math.abs(dx) || 1e-9), b.hh / (Math.abs(dy) || 1e-9), 1)
  return { x: b.x + dx * t, y: b.y + dy * t }
}

function drawGraph() {
  const edges = visible()
  const nodes = nodesOf(edges)
  const pos = layout(nodes, state.start)
  const hopOfEdge = new Map((state.walk?.edges ?? []).map((e) => [e.id, e.hop]))
  const nodeHop = new Map([[state.start, 0]])
  for (const e of edges) {
    const h = hopOfEdge.get(e.id)
    if (!h) continue
    for (const k of [e.fromKey, e.toKey]) nodeHop.set(k, Math.min(nodeHop.get(k) ?? 9, h))
  }
  const pair = new Map()
  const lines = edges.map((e) => {
    const a = pos.get(e.fromKey), b = pos.get(e.toKey)
    const p1 = edgePoint(b, a), p2 = edgePoint(a, b)
    const k = [e.fromKey, e.toKey].sort().join('|'), n = pair.get(k) ?? 0
    pair.set(k, n + 1)
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1
    const ox = (-(p2.y - p1.y) / len) * (n * 15), oy = ((p2.x - p1.x) / len) * (n * 15)
    const h = hopOfEdge.get(e.id)
    const cls = ['edge', state.walk ? (h ? `hop${h}` : 'off') : '', e.until ? 'closed' : ''].join(' ')
    return `<g class="${cls}"><line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" marker-end="url(#ar)"/><text x="${mx + ox}" y="${my + oy - 5}">${esc(e.rel)}</text></g>`
  })
  const boxes = [...nodes].map(([k, name]) => {
    const p = pos.get(k), h = nodeHop.get(k)
    const cls = ['node', k === state.start ? 'start' : '', state.walk ? (h ? `hop${Math.min(h, 3)}` : 'off') : ''].join(' ')
    return `<g class="${cls}" data-key="${esc(k)}" style="cursor:pointer"><rect x="${p.x - p.hw}" y="${p.y - p.hh}" width="${p.w}" height="${p.hh * 2}" rx="8"/><text x="${p.x}" y="${p.y + 4.5}" text-anchor="middle">${esc(name)}</text></g>`
  })
  return `<svg class="g" viewBox="0 0 ${W} ${H}" role="img" aria-label="Your graph: ${nodes.size} nodes, ${edges.length} connections">
    <defs><marker id="ar" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="currentColor" style="color:var(--muted)"/></marker></defs>
    ${lines.join('')}${boxes.join('')}</svg>`
}

// Paths from the start node, like "You → managed_by → Ana → lives_in → Paris" (from the walk result)
function pathsText() {
  const es = state.walk?.edges ?? []
  const byId = new Map(state.edges.map((e) => [e.id, e]))
  const out = []
  const grow = (key, trail, seen) => {
    const next = es.map((w) => byId.get(w.id)).filter((e) => e && (e.fromKey === key || e.toKey === key))
      .filter((e) => !seen.has(e.id))
    if (!next.length) { if (trail.length) out.push(trail); return }
    for (const e of next) {
      const fwd = e.fromKey === key, other = fwd ? e.toKey : e.fromKey
      if (trail.some((t) => t.key === other)) continue
      grow(other, [...trail, { key: other, text: fwd ? `—${e.rel}→ ${e.to}` : `←${e.rel}— ${e.from}` }], new Set([...seen, e.id]))
    }
  }
  grow(state.start, [], new Set())
  const startName = nodesOf(state.edges).get(state.start) ?? state.start
  return out.slice(0, 10).map((t) => `${esc(startName)} ${t.map((x) => esc(x.text)).join(' ')}`).join('\n')
}

function reachedList() {
  const es = state.walk?.edges ?? []
  const byHop = {}
  const names = nodesOf(state.edges)
  const seen = new Set([state.start])
  const byId = new Map(state.edges.map((e) => [e.id, e]))
  for (const w of es) {
    const e = byId.get(w.id); if (!e) continue
    for (const k of [e.fromKey, e.toKey]) {
      if (seen.has(k)) continue
      seen.add(k); (byHop[w.hop] ??= []).push(names.get(k))
    }
  }
  return [1, 2, 3].filter((h) => h <= state.hops).map((h) =>
    `<li><span class="tag h${h}c">hop ${h}</span><span>${byHop[h]?.length ? byHop[h].map(esc).join(', ') : '<span style="color:var(--muted)">nothing new</span>'}</span></li>`).join('')
}

function render() {
  const edges = visible()
  const nodes = nodesOf(edges)
  const startOptions = [...nodes].map(([k, n]) => `<option value="${esc(k)}"${k === state.start ? ' selected' : ''}>${esc(n)}</option>`).join('')
  const table = state.edges.length ? `<table><thead><tr><th>From</th><th>Connection</th><th>To</th><th></th></tr></thead><tbody>${
    state.edges.filter((e) => state.history || !e.until).map((e) =>
      `<tr class="${e.until ? 'closed' : ''}"><td>${esc(e.from)}</td><td class="rel">${esc(e.rel)}</td><td>${esc(e.to)}</td><td><button class="del" data-del="${esc(e.id)}" aria-label="Delete this connection" title="Delete">×</button></td></tr>`).join('')
  }</tbody></table>` : ''
  root.innerHTML = `<div class="page">
    <header>
      <a class="back" href="/">← Back to the chat</a>
      <h1>Graph memory lab</h1>
      <p class="lead">A fact is a sentence. A <b>graph</b> keeps the same knowledge as <b>connections</b>: <b>nodes</b> (people, places, things) joined by <b>edges</b> (<i>works_at</i>, <i>lives_in</i>…). Questions that join several facts, like <i>"which city does my manager live in?"</i>, become a <b>walk</b>: start at <b>You</b>, follow one connection per hop. Postgres does the walk with a recursive query. Showing the graph of <b>${esc(state.user)}</b>.</p>
    </header>
    ${state.error ? `<p class="err">${esc(state.error)}</p>` : ''}
    <div class="grid">
      <section class="card">
        <h2>The graph</h2>
        <p class="hint">Click a node to start the walk from it. Chat in the app ("My manager Ana lives in Paris") and connections appear here by themselves.</p>
        <div class="svgwrap">${edges.length ? drawGraph() : `<div class="empty">No connections yet.<br><br><button class="primary" id="example">Add an example graph</button></div>`}</div>
        ${edges.length && state.walk ? `<div class="legend"><span><i class="dot" style="background:var(--h1)"></i>hop 1</span><span><i class="dot" style="background:var(--h2)"></i>hop 2</span><span><i class="dot" style="background:var(--h3)"></i>hop 3</span><span><i class="dot" style="background:var(--off)"></i>not reached</span></div>` : ''}
      </section>
      <section class="card">
        <h2>Walk it</h2>
        <div class="controls">
          <label>Start at<select id="start" ${edges.length ? '' : 'disabled'}>${startOptions}</select></label>
          <label>How many hops<span class="seg" role="group" aria-label="Hops">${[1, 2, 3].map((h) => `<button data-hops="${h}" aria-pressed="${state.hops === h}">${h}</button>`).join('')}</span></label>
          <label class="check"><input type="checkbox" id="history" ${state.history ? 'checked' : ''}> Include connections that are no longer true</label>
        </div>
        ${state.walk ? `<ul class="reached">${reachedList()}</ul><div class="paths">${pathsText() || 'No paths.'}</div>` : '<p class="hint">Add connections first.</p>'}
      </section>
    </div>
    <section class="card">
      <h2>How the walk works</h2>
      <ol class="steps">
        <li><b>Unpack:</b> the connections sit in one jsonb column (<code>users.edges</code>). Postgres turns them into one row per edge.</li>
        <li><b>Start:</b> the walk begins at one node (hop 0).</li>
        <li><b>Step:</b> from every node it has reached, it follows every edge touching it, in both directions, one hop further.</li>
        <li><b>Stop:</b> it never steps back onto a node already on its path (so loops end) and stops after your number of hops.</li>
      </ol>
      <details><summary>Show the SQL (WITH RECURSIVE)</summary><pre>${esc(state.walk?.sql ?? '(walk something first)')}</pre></details>
    </section>
    <section class="card">
      <h2>Connections</h2>
      ${table || '<p class="hint">Nothing stored yet.</p>'}
    </section>
  </div>`
  bind()
}

function bind() {
  root.querySelector('#example')?.addEventListener('click', async () => { await api('/graph/example', { method: 'POST' }); state.start = 'you'; load() })
  root.querySelector('#start')?.addEventListener('change', async (e) => { state.start = e.target.value; await doWalk(); render() })
  root.querySelector('#history')?.addEventListener('change', async (e) => { state.history = e.target.checked; await doWalk(); render() })
  root.querySelectorAll('[data-hops]').forEach((b) => b.addEventListener('click', async () => { state.hops = Number(b.dataset.hops); await doWalk(); render() }))
  root.querySelectorAll('.node').forEach((n) => n.addEventListener('click', async () => { state.start = n.dataset.key; await doWalk(); render() }))
  root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { await api(`/graph/edges/${b.dataset.del}`, { method: 'DELETE' }); load() }))
}

load()
