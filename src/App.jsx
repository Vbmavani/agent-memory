import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'

// Prefer the cheapest-looking model the key can use.
const pickCheap = (ids) =>
  ids.find((m) => m.includes('flash')) || ids.find((m) => m.includes('chat')) || ids[0] || ''

const LAST_CHAT = 'deepseek-playground:lastChat'
const store = {
  get: () => { try { return localStorage.getItem(LAST_CHAT) } catch { return null } },
  set: (v) => { try { v ? localStorage.setItem(LAST_CHAT, v) : localStorage.removeItem(LAST_CHAT) } catch {} },
}

async function api(path, init) {
  const r = await fetch('/api' + path, init)
  const d = await r.json()
  if (d.error) throw new Error(d.error)
  return d
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

function when(iso) {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

const MODE_LABEL = { keyword: 'words (step 1)', meaning: 'meaning (step 2)', hybrid: 'words + meaning' }
const MATCH_TITLE = {
  words: 'Step 1: shares words with the search (Postgres full-text search)',
  meaning: 'Step 2: close in meaning (embedding similarity, 0-1)',
  both: 'Found by both the word search and the meaning search',
}

// One tool call the model made before answering (episodic memory lookup).
function ToolCall({ call }) {
  const label = call.name === 'search_past_chats'
    ? <>Searched past chats for <b>“{call.args.query}”</b>{call.mode && <span className="tool-mode"> by {MODE_LABEL[call.mode]}</span>}</>
    : call.name === 'auto_recall'
      ? <>Recalled related chats <span className="tool-mode">automatically, by meaning</span></>
    : call.name === 'list_recent_chats'
      ? <>Listed chats from the last <b>{call.args.days ?? 7} days</b></>
      : <>Called <b>{call.name}</b></>
  return (
    <details className="tool">
      <summary>
        <span className="tool-icon" aria-hidden>{{ search_past_chats: '🔎', auto_recall: '🧭' }[call.name] ?? '🗂'}</span>
        {label} · {call.error ? <span className="tool-err">{call.error}</span> : `${call.count} found`}
      </summary>
      {call.found?.length > 0 && (
        <ul>
          {call.found.map((f, i) => (
            <li key={i}>
              <span className="tool-chat">{f.chat}</span>
              <span className="tool-date">{when(f.date)}</span>
              {f.matchedBy && (
                <span className={`match ${f.matchedBy}`} title={MATCH_TITLE[f.matchedBy]}>
                  {f.matchedBy}{f.similarity != null && ` · ${f.similarity.toFixed(2)}`}
                </span>
              )}
              {f.snippet && <div className="tool-snip">{f.snippet}</div>}
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

// What semantic memory changed because of this message.
// source 'tool' = the chat model called remember/forget because you asked; 'auto' = background extractor.
function MemoryChange({ change }) {
  const tag = change.source === 'tool'
    ? <span className="mem-src tool" title="The chat model called a memory tool because you asked">you asked</span>
    : change.source === 'lesson'
      ? <span className="mem-src lesson" title="The assistant learned this from its own experience">self-learned</span>
      : <span className="mem-src" title="Saved by the background memory extractor">automatic</span>
  if (change.kind === 'procedure') {
    if (change.op === 'add') return <div className="mem add proc">📘 Learned how to work: <b>when {change.when}</b> → {change.do}{tag}</div>
    if (change.op === 'update') return <div className="mem upd proc">📘 Updated routine: <b>when {change.when}</b> → {change.do}{tag}</div>
    return <div className="mem del proc">🗑 Stopped: <s>when {change.when}</s>{tag}</div>
  }
  if (change.op === 'add') return <div className="mem add">🧠 Remembered: <b>{change.text}</b>{tag}</div>
  if (change.op === 'update') return <div className="mem upd">✏️ Updated: <s>{change.old}</s> → <b>{change.text}</b>{tag}</div>
  return <div className="mem del">🗑 Forgot: <s>{change.text}</s>{tag}</div>
}

function Profile({ user, onSaved, onClose }) {
  const [form, setForm] = useState({ name: user.name, email: user.email ?? '', bio: user.bio ?? '' })
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (k) => (e) => { setForm({ ...form, [k]: e.target.value }); setStatus('') }

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    try {
      onSaved(await api('/profile', json('PUT', form)))
      setStatus('Saved')
    } catch (err) {
      setStatus(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-wrap" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="modal-head">
          <h2>Profile</h2>
          <button type="button" className="ghost" onClick={onClose}>Close</button>
        </div>
        <label className="field">Name<input value={form.name} onChange={set('name')} required /></label>
        <label className="field">Email<input type="email" value={form.email} onChange={set('email')} placeholder="optional" /></label>
        <label className="field">About you<textarea rows={4} value={form.bio} onChange={set('bio')} placeholder="optional" /></label>
        <div className="modal-foot">
          <span className={status === 'Saved' ? 'ok' : 'bad'}>{status}</span>
          <button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
        <p className="hint">Stored in the <code>users</code> table in Postgres. Member since {new Date(user.createdAt).toLocaleDateString()}.</p>

        <div className="facts">
          <h3>What I've learned about you ({user.facts?.length ?? 0})</h3>
          {!user.facts?.length && <p className="hint">Nothing yet. Tell me about yourself in a chat and I'll remember the parts that matter.</p>}
          <ul>
            {(user.facts ?? []).slice().reverse().map((f) => (
              <li key={f.id}>
                <span className="fact-text">{f.text}</span>
                <span className="fact-date">{when(f.updatedAt)}{f.previous?.length ? ` · was: ${f.previous.at(-1)}` : ''}</span>
                <button type="button" className="del" title="Forget this" aria-label={`Forget: ${f.text}`}
                  onClick={async () => onSaved(await api(`/profile/facts/${f.id}`, { method: 'DELETE' }))}>×</button>
              </li>
            ))}
          </ul>
        </div>

        <div className="facts">
          <h3>How I work with you ({user.procedures?.length ?? 0})</h3>
          {!user.procedures?.length && <p className="hint">No routines yet. Teach me one ("when I say standup, ask me…") or tell me how you want answers, and I'll keep doing it in every chat.</p>}
          <ul>
            {(user.procedures ?? []).slice().reverse().map((p) => (
              <li key={p.id}>
                <span className="fact-text"><b>When {p.when}</b> → {p.do}</span>
                <span className="fact-date">{when(p.updatedAt)}{{ tool: ' · you asked', lesson: ' · self-learned' }[p.source?.via] ?? ' · learned automatically'}</span>
                <button type="button" className="del" title="Stop doing this" aria-label={`Stop: ${p.when}`}
                  onClick={async () => onSaved(await api(`/profile/procedures/${p.id}`, { method: 'DELETE' }))}>×</button>
              </li>
            ))}
          </ul>
        </div>
      </form>
    </div>
  )
}

export default function App() {
  const [models, setModels] = useState([])
  const [model, setModel] = useState('')
  const [user, setUser] = useState(null)
  const [showProfile, setShowProfile] = useState(false)
  const [chats, setChats] = useState([])        // sidebar summaries
  const [chat, setChat] = useState(null)        // open chat {id, title, messages}
  const [pending, setPending] = useState(null)  // user text shown while waiting
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [drawer, setDrawer] = useState(false)
  const logRef = useRef(null)
  const inputRef = useRef(null)

  const refreshList = () => api('/chats').then((d) => setChats(d.chats)).catch((e) => setError(e.message))

  useEffect(() => {
    api('/models')
      .then((d) => { setModels(d.models); setModel(pickCheap(d.models)) })
      .catch((e) => setError(e.message))
    api('/profile').then(setUser).catch((e) => setError(e.message))
    refreshList()
    const last = store.get()
    if (last) api(`/chats/${last}`).then(setChat).catch(() => store.set(null))
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [chat, pending])

  function openChat(id) {
    setDrawer(false)
    setError('')
    api(`/chats/${id}`).then((c) => { setChat(c); store.set(c.id) }).catch((e) => setError(e.message))
  }

  function newChat() {
    setDrawer(false)
    setChat(null)
    setError('')
    store.set(null)
    inputRef.current?.focus()
  }

  async function removeChat(id) {
    await api(`/chats/${id}`, { method: 'DELETE' }).catch((e) => setError(e.message))
    if (chat?.id === id) newChat()
    refreshList()
  }

  async function send(e) {
    e.preventDefault()
    const text = input.trim()
    if (!text || pending) return
    setInput('')
    setPending(text)
    setError('')
    try {
      const c = await api(`/chats/${chat?.id ?? 'new'}/messages`, json('POST', { model, content: text }))
      setChat(c)
      store.set(c.id)
      refreshList()
      if (c.messages.at(-1)?.meta?.memory?.length) api('/profile').then(setUser).catch(() => {})
    } catch (err) {
      setError(err.message)
      setInput(text) // give the text back so it isn't lost
    } finally {
      setPending(null)
    }
  }

  const messages = chat?.messages ?? []

  return (
    <div className="shell">
      <aside className={drawer ? 'open' : ''}>
        <button className="new" onClick={newChat}>+ New chat</button>
        <div className="label">Previous chats</div>
        {!chats.length && <p className="none">No saved chats yet.</p>}
        <ul>
          {chats.map((c) => (
            <li key={c.id} className={c.id === chat?.id ? 'active' : ''}>
              <button className="item" onClick={() => openChat(c.id)}>
                <span className="title">{c.title}</span>
                <span className="sub">{when(c.updatedAt)} · {c.count} msgs</span>
              </button>
              <button className="del" title="Delete chat" aria-label={`Delete chat ${c.title}`} onClick={() => removeChat(c.id)}>×</button>
            </li>
          ))}
        </ul>
        {user && (
          <button className="me" onClick={() => { setShowProfile(true); setDrawer(false) }}>
            <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
            <span className="me-text"><span className="title">{user.name}</span><span className="sub">Profile</span></span>
          </button>
        )}
      </aside>
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}

      <div className="app">
        <header>
          <button className="ghost menu" onClick={() => setDrawer(true)}>☰ Chats</button>
          <h1>DeepSeek <span>Playground</span></h1>
          <a className="ghost lab-link" href="/vectors.html">Vectors lab</a>
          <a className="ghost lab-link" href="https://vbmavani.github.io/agent-memory/" target="_blank" rel="noopener">Learning site ↗</a>
          <label>
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!models.length}>
              {models.map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
        </header>

        <main ref={logRef}>
          {!messages.length && !pending && (
            <p className="empty">
              {user ? <>Hi {user.name}. </> : null}Start a chat. Every message is sent to the model together with this chat's previous history, and everything is saved in Postgres.
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === 'assistant' ? <div className="md"><Markdown>{m.content}</Markdown></div> : m.content}
              {m.meta?.toolCalls?.map((t, j) => <ToolCall key={j} call={t} />)}
              {m.meta?.memory?.map((c, j) => <MemoryChange key={`m${j}`} change={c} />)}
              {m.meta && (
                <div className="meta">
                  {m.meta.model} · {m.meta.profile ? `profile: ${m.meta.profile} · ` : ''}{m.meta.factsInPrompt != null ? `${m.meta.factsInPrompt} facts known · ` : ''}{m.meta.proceduresInPrompt ? `${m.meta.proceduresInPrompt} procedures · ` : ''}{m.meta.contextMessages} msgs of context ·{m.meta.modelCalls > 1 ? ` ${m.meta.modelCalls} model calls ·` : ''} {m.meta.promptTokens} in / {m.meta.outTokens} out tokens · {(m.meta.ms / 1000).toFixed(1)}s
                </div>
              )}
            </div>
          ))}
          {pending && <>
            <div className="msg user">{pending}</div>
            <div className="msg assistant thinking">…thinking (may search your past chats)</div>
          </>}
        </main>

        {error && <div className="error">{error}</div>}

        <form className="composer" onSubmit={send}>
          <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a message…" autoFocus />
          <button className="primary" disabled={!!pending || !input.trim() || !model}>Send</button>
        </form>
      </div>

      {showProfile && user && <Profile user={user} onSaved={setUser} onClose={() => setShowProfile(false)} />}
    </div>
  )
}
