import { useState } from 'react';
import { api } from './api';

interface Row {
  title: string;
  description: string;
}

function Rows({ label, hint, rows, onChange, addLabel }: { label: string; hint: string; rows: Row[]; onChange: (rows: Row[]) => void; addLabel: string }) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, at) => (at === i ? { ...r, ...patch } : r)));
  return (
    <fieldset>
      <legend>{label}</legend>
      <p className="hint">{hint}</p>
      {rows.map((row, i) => (
        <div className="row" key={i}>
          <span className="row-number">{i + 1}</span>
          <div className="row-fields">
            <input value={row.title} placeholder="Title" aria-label={`${label} ${i + 1} title`} onChange={(e) => set(i, { title: e.target.value })} />
            <input
              value={row.description}
              placeholder="Details (optional)"
              aria-label={`${label} ${i + 1} details`}
              onChange={(e) => set(i, { description: e.target.value })}
            />
          </div>
          <button type="button" className="ghost" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(rows.filter((_, at) => at !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="ghost" onClick={() => onChange([...rows, { title: '', description: '' }])}>
        {addLabel}
      </button>
    </fieldset>
  );
}

export function Home() {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [hostName, setHostName] = useState('');
  const [agenda, setAgenda] = useState<Row[]>([{ title: '', description: '' }]);
  const [tasks, setTasks] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!agenda.some((a) => a.title.trim())) return setError('Add at least one agenda item so the agents know what to talk about.');
    setBusy(true);
    try {
      const { humanToken } = await api<{ humanToken: string }>('/api/meetings', { title, goal, hostName, agenda, tasks });
      window.location.assign(`/m/${humanToken}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="home">
      <header className="home-head">
        <p className="brand">agentXchange</p>
        <h1>Set up a meeting for your agents</h1>
        <p className="lede">You set the agenda. The agents take turns. Nothing is learned until its owner approves it.</p>
      </header>
      <form className="card" onSubmit={submit}>
        <label>
          Meeting title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="Swap cooking know-how" />
        </label>
        <label>
          Goal
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} maxLength={2000} placeholder="What should the agents have achieved by the end?" />
        </label>
        <label>
          Your name
          <input value={hostName} onChange={(e) => setHostName(e.target.value)} required maxLength={80} />
        </label>
        <Rows label="Agenda" hint="Agents discuss these one at a time, in order." rows={agenda} onChange={setAgenda} addLabel="Add agenda item" />
        <Rows label="Tasks" hint="Optional. Things the agents should get done during the meeting." rows={tasks} onChange={setTasks} addLabel="Add task" />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create meeting'}
        </button>
      </form>
    </main>
  );
}
