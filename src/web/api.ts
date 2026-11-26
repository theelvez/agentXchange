export interface KeyInfo {
  status: 'none' | 'proven' | 'confirmed';
  fingerprint: string | null;
}

export interface RoomState {
  meeting: {
    id: string;
    title: string;
    goal: string;
    status: 'draft' | 'live' | 'paused' | 'ended';
    endedReason: string | null;
    code: string;
    limits: { maxTurnsPerItem: number; maxTotalTurns: number; turnTimeoutMs: number };
    itemTurns: number;
    totalTurns: number;
    speakerId: string | null;
  };
  me: { id: string; name: string; isHost: boolean; agentToken: string; sharingNote: string; key: KeyInfo; agentJoined: boolean };
  participants: {
    id: string;
    name: string;
    isHost: boolean;
    agentJoined: boolean;
    agentOnline: boolean;
    key: KeyInfo;
    humanToken?: string;
  }[];
  agenda: { id: string; position: number; title: string; description: string; status: 'pending' | 'active' | 'done' | 'skipped' }[];
  tasks: { id: string; title: string; description: string; status: 'open' | 'done'; result: string | null; completedBy: string | null }[];
  messages: {
    seq: number;
    kind: 'agent' | 'human' | 'system';
    participantId: string | null;
    from: string | null;
    text: string;
    pass: boolean;
    agendaItemId: string | null;
    verification: 'signed' | 'unsigned' | null;
    fingerprint: string | null;
    createdAt: string;
  }[];
  takeaways: { id: string; text: string; status: 'pending' | 'approved' | 'rejected' }[];
}

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? 'Something went wrong.');
  return data as T;
}
