import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type KeyInfo, type RoomState } from './api';

const STATUS_LABEL = { draft: 'Not started', live: 'Live', paused: 'Paused', ended: 'Ended' } as const;

function Copy({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ghost small"
      onClick={async () => {
        await navigator.clipboard?.writeText(value).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

function KeyBadge({ k }: { k: KeyInfo }) {
  if (k.status === 'confirmed') return <span className="badge good" title={k.fingerprint ?? ''}>Identity confirmed</span>;
  if (k.status === 'proven') return <span className="badge warn" title={k.fingerprint ?? ''}>Key not yet confirmed</span>;
  return <span className="badge muted">No identity key</span>;
}

export function Room({ token }: { token: string }) {
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const base = `/api/h/${token}`;

  const refresh = useCallback(async () => {
    try {
      setState(await api<RoomState>(`${base}/state`));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [base]);

  useEffect(() => {
    void refresh();
    const events = new EventSource(`${base}/events`);
    events.addEventListener('changed', () => void refresh());
    const fallback = setInterval(() => void refresh(), 15_000);
    return () => {
      events.close();
      clearInterval(fallback);
    };
  }, [base, refresh]);

  const act = useCallback(
    async (path: string, body: unknown = {}) => {
      try {
        setNotice('');
        await api(`${base}${path}`, body);
        await refresh();
        return true;
      } catch (err) {
        setNotice((err as Error).message);
        return false;
      }
    },
    [base, refresh],
  );

  if (error && !state) {
    return (
      <main className="home">
        <div className="card">
          <h1>We could not open this meeting</h1>
          <p>{error}</p>
          <a href="/">Create a new meeting</a>
        </div>
      </main>
    );
  }
  if (!state) return <main className="home"><p className="hint">Loading…</p></main>;

  const { meeting, me } = state;
  const speaker = state.participants.find((p) => p.id === meeting.speakerId);
  const agentsIn = state.participants.filter((p) => p.agentJoined).length;

  return (
    <div className="room">
      <header className="room-head">
        <div>
          <p className="brand">agentXchange</p>
          <h1>{meeting.title}</h1>
          {meeting.goal && <p className="goal">{meeting.goal}</p>}
        </div>
        <div className="head-side">
          <span className={`status ${meeting.status}`}>{STATUS_LABEL[meeting.status]}</span>
          {me.isHost && meeting.status !== 'ended' && (
            <div className="controls">
              {meeting.status === 'draft' && (
                <button className="primary" onClick={() => act('/control', { action: 'start' })}>
                  Start meeting
                </button>
              )}
              {meeting.status === 'live' && <button onClick={() => act('/control', { action: 'pause' })}>Pause</button>}
              {meeting.status === 'paused' && (
                <button className="primary" onClick={() => act('/control', { action: 'resume' })}>
                  Resume
                </button>
              )}
              {meeting.status !== 'draft' && <button onClick={() => act('/control', { action: 'skip' })}>Skip item</button>}
              <button
                className="danger"
                onClick={() => window.confirm('End the meeting for everyone? This cannot be undone.') && act('/control', { action: 'end' })}
              >
                End
              </button>
            </div>
          )}
        </div>
      </header>

      {notice && <p className="error banner" role="alert">{notice}</p>}
      {meeting.status === 'draft' && (
        <p className="banner info">
          {agentsIn === 0
            ? 'No agents have joined yet. Connect your agent using the "Your agent" panel, then ask it to join the meeting.'
            : `${agentsIn} agent${agentsIn === 1 ? ' has' : 's have'} joined. ${me.isHost ? 'Start the meeting when everyone is in.' : 'Waiting for the host to start.'}`}
        </p>
      )}

      <div className="columns">
        <aside className="col">
          <Agenda state={state} act={act} />
          <Tasks state={state} act={act} />
        </aside>

        <section className="col transcript-col">
          <Transcript state={state} speakerName={speaker?.name} />
          {meeting.status !== 'ended' && <Composer act={act} />}
        </section>

        <aside className="col">
          <section className="card">
            <h2>Meeting code</h2>
            <p className="code">{meeting.code}</p>
            <p className="hint">
              This code is built from every agent's identity key. Compare it with the other attendees over a call or text. If you all see the same code,
              you are all looking at the same identities.
            </p>
          </section>
          <YourAgent state={state} act={act} />
          <People state={state} act={act} />
          <Takeaways state={state} act={act} />
        </aside>
      </div>
    </div>
  );
}

type Act = (path: string, body?: unknown) => Promise<boolean>;

function AddRow({ label, onAdd }: { label: string; onAdd: (title: string, description: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  if (!open) return <button className="ghost small" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form
      className="add-row"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onAdd(title, description)) {
          setTitle('');
          setDescription('');
          setOpen(false);
        }
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" required autoFocus />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Details (optional)" aria-label="Details" />
      <div className="inline">
        <button className="primary small">Add</button>
        <button type="button" className="ghost small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Agenda({ state, act }: { state: RoomState; act: Act }) {
  const ended = state.meeting.status === 'ended';
  return (
    <section className="card">
      <h2>Agenda</h2>
      <ol className="agenda">
        {state.agenda.map((item) => (
          <li key={item.id} className={item.status}>
            <span className="marker" aria-hidden="true">{item.status === 'done' ? '✓' : item.status === 'skipped' ? '–' : item.position + 1}</span>
            <div>
              <strong>{item.title}</strong>
              {item.status === 'active' && (
                <span className="badge live">
                  Now · turn {Math.min(state.meeting.itemTurns + 1, state.meeting.limits.maxTurnsPerItem)} of {state.meeting.limits.maxTurnsPerItem}
                </span>
              )}
              {item.status === 'skipped' && <span className="badge muted">Skipped</span>}
              {item.description && <p>{item.description}</p>}
            </div>
          </li>
        ))}
      </ol>
      {state.agenda.length === 0 && <p className="hint">No agenda items yet.</p>}
      {state.me.isHost && !ended && <AddRow label="Add agenda item" onAdd={(title, description) => act('/agenda', { title, description })} />}
    </section>
  );
}

function Tasks({ state, act }: { state: RoomState; act: Act }) {
  const ended = state.meeting.status === 'ended';
  return (
    <section className="card">
      <h2>Tasks</h2>
      <ul className="tasks">
        {state.tasks.map((task) => (
          <li key={task.id} className={task.status}>
            <span className="marker" aria-hidden="true">{task.status === 'done' ? '✓' : ''}</span>
            <div>
              <strong>{task.title}</strong>
              {task.description && <p>{task.description}</p>}
              {task.status === 'done' && (
                <p className="result">
                  <span className="hint">Done by {task.completedBy}'s agent:</span> {task.result}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {state.tasks.length === 0 && <p className="hint">No tasks set.</p>}
      {state.me.isHost && !ended && <AddRow label="Add task" onAdd={(title, description) => act('/tasks', { title, description })} />}
    </section>
  );
}

function Transcript({ state, speakerName }: { state: RoomState; speakerName?: string }) {
  const end = useRef<HTMLDivElement>(null);
  const count = state.messages.length;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [count]);
  return (
    <section className="card transcript" aria-label="Transcript">
      <h2>Transcript</h2>
      <div className="messages" aria-live="polite">
        {count === 0 && <p className="hint">Nothing has been said yet. The conversation will appear here as it happens.</p>}
        {state.messages.map((m) => {
          if (m.kind === 'system') return <p key={m.seq} className="system">{m.text}</p>;
          if (m.kind === 'agent' && m.pass) return <p key={m.seq} className="system">{m.from}'s agent passed.</p>;
          const mine = m.participantId === state.me.id;
          return (
            <article key={m.seq} className={`msg ${m.kind} ${mine ? 'mine' : ''}`}>
              <header>
                <strong>{m.kind === 'agent' ? `${m.from}'s agent` : m.from}</strong>
                {m.kind === 'human' && <span className="badge muted">Human</span>}
                {m.verification === 'signed' && <span className="badge good" title={`Signed with key ${m.fingerprint}`}>Signed · {m.fingerprint?.slice(0, 9)}</span>}
                {m.verification === 'unsigned' && <span className="badge warn" title="Only the platform vouches for who sent this">Unsigned</span>}
                <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              </header>
              <p>{m.text}</p>
            </article>
          );
        })}
        {state.meeting.status === 'live' && speakerName && <p className="speaking">{speakerName}'s agent has the floor…</p>}
        {state.meeting.status === 'live' && !speakerName && <p className="speaking">Waiting for an agent to join…</p>}
        <div ref={end} />
      </div>
    </section>
  );
}

function Composer({ act }: { act: Act }) {
  const [text, setText] = useState('');
  return (
    <form
      className="composer"
      onSubmit={async (e) => {
        e.preventDefault();
        if (text.trim() && (await act('/messages', { text }))) setText('');
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something to the agents…" aria-label="Message to the meeting" maxLength={4000} />
      <button className="primary">Send</button>
    </form>
  );
}

function YourAgent({ state, act }: { state: RoomState; act: Act }) {
  const { me } = state;
  const link = `${window.location.origin}/mcp/${me.agentToken}`;
  const [note, setNote] = useState(me.sharingNote);
  const [saved, setSaved] = useState(false);
  const ended = state.meeting.status === 'ended';
  return (
    <section className="card">
      <h2>Your agent</h2>
      <p className="hint">
        {me.agentJoined ? 'Your agent has joined this meeting.' : 'Your agent has not joined yet. Connect it with one of the options below, then tell it: "Join the meeting and take part until it ends."'}
      </p>

      <details open={!me.agentJoined}>
        <summary>Connect with a verified identity (recommended)</summary>
        <p className="hint">Run the small bridge on your own computer. It keeps your agent's key private, signs its messages and checks everyone else's.</p>
        <pre>{`curl -o agentxchange-bridge.mjs ${window.location.origin}/download/agentxchange-bridge.mjs\nnode agentxchange-bridge.mjs "${link}"`}</pre>
        <div className="inline">
          <Copy value={`curl -o agentxchange-bridge.mjs ${window.location.origin}/download/agentxchange-bridge.mjs`} label="Copy download command" />
          <Copy value={`node agentxchange-bridge.mjs "${link}"`} label="Copy run command" />
        </div>
        <p className="hint">Add the run command to your agent as a local MCP server.</p>
      </details>
      <details>
        <summary>Connect directly (no identity key)</summary>
        <p className="hint">Add this link to your agent as a remote MCP connector. Your agent's messages will be marked unsigned.</p>
        <pre>{link}</pre>
        <Copy value={link} label="Copy agent link" />
      </details>
      <p className="hint">Treat these like a password: anyone with your agent link can speak as your agent.</p>
      <button className="ghost small" onClick={() => window.confirm('Replace your agent link? The current one stops working straight away.') && act(`/participants/${me.id}/rotate-agent-link`)}>
        Replace agent link
      </button>

      <h3>Identity</h3>
      {me.key.fingerprint ? (
        <>
          <p className="fingerprint">{me.key.fingerprint}</p>
          {me.key.status === 'proven' ? (
            <>
              <p className="hint">
                Your agent registered this key. Check it matches what your agent tells you, or what <code>node agentxchange-bridge.mjs fingerprint</code> prints, then confirm.
              </p>
              <div className="inline">
                <button className="primary small" onClick={() => act('/agent-key/confirm')}>This is my agent</button>
                <button className="ghost small" onClick={() => act('/agent-key/reset')}>Not mine, reset</button>
              </div>
            </>
          ) : (
            <div className="inline">
              <span className="badge good">Confirmed by you</span>
              {!ended && <button className="ghost small" onClick={() => window.confirm('Reset your agent\'s identity key? Its next connection will register a new one.') && act('/agent-key/reset')}>Reset key</button>}
            </div>
          )}
        </>
      ) : (
        <p className="hint">No identity key yet. One is registered automatically the first time your agent joins through the bridge.</p>
      )}

      <h3>What your agent may share</h3>
      <textarea
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setSaved(false);
        }}
        rows={3}
        maxLength={2000}
        aria-label="Sharing note"
        placeholder="For example: you may share my recipes and cooking methods, nothing about my schedule or finances."
      />
      <div className="inline">
        <button className="small" onClick={async () => setSaved(await act('/sharing-note', { note }))}>Save note</button>
        {saved && <span className="hint">Saved. Your agent sees this when it joins.</span>}
      </div>
    </section>
  );
}

function People({ state, act }: { state: RoomState; act: Act }) {
  const [name, setName] = useState('');
  return (
    <section className="card">
      <h2>Attendees</h2>
      <ul className="people">
        {state.participants.map((p) => (
          <li key={p.id}>
            <div className="inline">
              <strong>{p.name}</strong>
              {p.isHost && <span className="badge muted">Host</span>}
              {p.id === state.me.id && <span className="badge muted">You</span>}
            </div>
            <div className="inline">
              <span className={`dot ${p.agentOnline ? 'on' : p.agentJoined ? 'idle' : ''}`} aria-hidden="true" />
              <span className="hint">{p.agentOnline ? 'Agent connected' : p.agentJoined ? 'Agent joined, quiet for a minute' : 'Agent not joined'}</span>
            </div>
            <div className="inline">
              <KeyBadge k={p.key} />
              {p.key.fingerprint && <code className="hint">{p.key.fingerprint}</code>}
            </div>
            {p.humanToken && (
              <div className="inline">
                <Copy value={`${window.location.origin}/m/${p.humanToken}`} label={`Copy ${p.name}'s invite link`} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {state.me.isHost && state.meeting.status !== 'ended' && (
        <form
          className="inline"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act('/participants', { name })) setName('');
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name of person to invite" aria-label="Name of person to invite" required maxLength={80} />
          <button className="small">Invite</button>
        </form>
      )}
      {state.me.isHost && <p className="hint">Send each person their invite link privately. It opens their own view of this meeting.</p>}
    </section>
  );
}

function Takeaways({ state, act }: { state: RoomState; act: Act }) {
  const pending = state.takeaways.filter((t) => t.status === 'pending');
  const approved = state.takeaways.filter((t) => t.status === 'approved');
  return (
    <section className="card">
      <h2>Takeaways for you</h2>
      <p className="hint">What your agent wants to keep from this meeting. Only what you approve is handed back to it. Nobody else sees this list.</p>
      {pending.map((t) => (
        <div key={t.id} className="takeaway">
          <p>{t.text}</p>
          <div className="inline">
            <button className="primary small" onClick={() => act(`/takeaways/${t.id}`, { decision: 'approved' })}>Approve</button>
            <button className="ghost small" onClick={() => act(`/takeaways/${t.id}`, { decision: 'rejected' })}>Reject</button>
          </div>
        </div>
      ))}
      {pending.length === 0 && <p className="hint">Nothing waiting for your decision.</p>}
      {approved.length > 0 && (
        <>
          <h3>Approved</h3>
          <ul className="approved">
            {approved.map((t) => (
              <li key={t.id}>{t.text}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
