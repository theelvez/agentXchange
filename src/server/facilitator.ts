// The facilitator: a pure state machine that decides whose turn it is.
// It knows nothing about the database or the network, which keeps it easy to test.

export type MeetingStatus = 'draft' | 'live' | 'paused' | 'ended';

export interface Limits {
  /** Turns (messages or passes) allowed on one agenda item before moving on. */
  maxTurnsPerItem: number;
  /** Turns allowed in the whole meeting before it ends. */
  maxTotalTurns: number;
  /** How long an agent may hold the floor before the turn moves on. */
  turnTimeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = { maxTurnsPerItem: 12, maxTotalTurns: 60, turnTimeoutMs: 180_000 };

export interface FState {
  status: MeetingStatus;
  itemIds: string[];
  skipped: string[];
  /** Index into itemIds. Equals itemIds.length once the agenda is finished. */
  currentItem: number;
  /** Agents in the order they joined. This is the speaking order. */
  agents: string[];
  speaker: string | null;
  /** Single-use id for the current turn. Signed messages bind to it. */
  turnId: string | null;
  turnDeadline: number | null;
  consecutivePasses: number;
  missedInRow: number;
  itemTurns: number;
  totalTurns: number;
  endedReason: string | null;
  limits: Limits;
}

export type FEvent =
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'end'; reason: string }
  | { type: 'join'; agent: string }
  | { type: 'post'; agent: string; pass: boolean }
  | { type: 'skip_item' }
  | { type: 'human_message' }
  | { type: 'add_item'; id: string }
  | { type: 'tick' };

export type FEffect =
  | { type: 'started' }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'joined'; agent: string }
  | { type: 'item_started'; itemId: string }
  | { type: 'item_finished'; itemId: string; reason: 'everyone_passed' | 'turn_limit' | 'skipped' }
  | { type: 'turn_missed'; agent: string }
  | { type: 'ended'; reason: string };

export interface FContext {
  now: number;
  newTurnId: () => string;
}

export class FacilitatorError extends Error {
  constructor(
    public code: 'not_your_turn' | 'not_live' | 'ended' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export function initialState(itemIds: string[], limits: Partial<Limits> = {}): FState {
  return {
    status: 'draft',
    itemIds: [...itemIds],
    skipped: [],
    currentItem: 0,
    agents: [],
    speaker: null,
    turnId: null,
    turnDeadline: null,
    consecutivePasses: 0,
    missedInRow: 0,
    itemTurns: 0,
    totalTurns: 0,
    endedReason: null,
    limits: { ...DEFAULT_LIMITS, ...limits },
  };
}

export function itemStatus(state: FState, itemId: string): 'pending' | 'active' | 'done' | 'skipped' {
  const index = state.itemIds.indexOf(itemId);
  if (state.skipped.includes(itemId)) return 'skipped';
  if (index < state.currentItem) return 'done';
  if (index === state.currentItem && (state.status === 'live' || state.status === 'paused')) return 'active';
  return 'pending';
}

export function apply(prev: FState, event: FEvent, ctx: FContext): { state: FState; effects: FEffect[] } {
  const s: FState = structuredClone(prev);
  const effects: FEffect[] = [];

  const giveFloor = (agent: string | null) => {
    s.speaker = agent;
    s.turnId = agent ? ctx.newTurnId() : null;
    s.turnDeadline = agent && s.status === 'live' ? ctx.now + s.limits.turnTimeoutMs : null;
  };
  const nextSpeaker = () => {
    if (s.agents.length === 0) return giveFloor(null);
    const at = s.speaker ? s.agents.indexOf(s.speaker) : -1;
    giveFloor(s.agents[(at + 1) % s.agents.length]);
  };
  const end = (reason: string) => {
    s.status = 'ended';
    s.endedReason = reason;
    s.speaker = null;
    s.turnId = null;
    s.turnDeadline = null;
    effects.push({ type: 'ended', reason });
  };
  const advance = (reason: 'everyone_passed' | 'turn_limit' | 'skipped') => {
    const finished = s.itemIds[s.currentItem];
    if (reason === 'skipped') s.skipped.push(finished);
    effects.push({ type: 'item_finished', itemId: finished, reason });
    s.currentItem += 1;
    s.consecutivePasses = 0;
    s.itemTurns = 0;
    if (s.currentItem >= s.itemIds.length) return end('agenda_complete');
    effects.push({ type: 'item_started', itemId: s.itemIds[s.currentItem] });
    nextSpeaker();
  };

  if (s.status === 'ended' && event.type !== 'tick') {
    throw new FacilitatorError('ended', 'This meeting has ended.');
  }

  switch (event.type) {
    case 'start': {
      if (s.status !== 'draft') throw new FacilitatorError('invalid', 'The meeting has already started.');
      if (s.itemIds.length === 0) throw new FacilitatorError('invalid', 'Add at least one agenda item before starting.');
      s.status = 'live';
      effects.push({ type: 'started' }, { type: 'item_started', itemId: s.itemIds[0] });
      nextSpeaker();
      break;
    }
    case 'pause': {
      if (s.status !== 'live') throw new FacilitatorError('not_live', 'Only a live meeting can be paused.');
      s.status = 'paused';
      s.turnDeadline = null;
      effects.push({ type: 'paused' });
      break;
    }
    case 'resume': {
      if (s.status !== 'paused') throw new FacilitatorError('invalid', 'The meeting is not paused.');
      s.status = 'live';
      if (s.speaker) s.turnDeadline = ctx.now + s.limits.turnTimeoutMs;
      else nextSpeaker();
      effects.push({ type: 'resumed' });
      break;
    }
    case 'end': {
      end(event.reason);
      break;
    }
    case 'join': {
      if (s.agents.includes(event.agent)) break;
      s.agents.push(event.agent);
      effects.push({ type: 'joined', agent: event.agent });
      if (s.status === 'live' && !s.speaker) nextSpeaker();
      break;
    }
    case 'post': {
      if (s.status !== 'live') throw new FacilitatorError('not_live', `The meeting is ${s.status}; nobody can speak right now.`);
      if (s.speaker !== event.agent) throw new FacilitatorError('not_your_turn', 'It is not your turn to speak.');
      s.itemTurns += 1;
      s.totalTurns += 1;
      s.missedInRow = 0;
      s.consecutivePasses = event.pass ? s.consecutivePasses + 1 : 0;
      if (s.totalTurns >= s.limits.maxTotalTurns) end('turn_limit');
      else if (s.consecutivePasses >= s.agents.length) advance('everyone_passed');
      else if (s.itemTurns >= s.limits.maxTurnsPerItem) advance('turn_limit');
      else nextSpeaker();
      break;
    }
    case 'skip_item': {
      if (s.status !== 'live' && s.status !== 'paused') throw new FacilitatorError('not_live', 'The meeting has not started.');
      advance('skipped');
      break;
    }
    case 'human_message': {
      // A human spoke, so agents who had passed get a fresh chance to respond.
      s.consecutivePasses = 0;
      break;
    }
    case 'add_item': {
      s.itemIds.push(event.id);
      break;
    }
    case 'tick': {
      // A missed turn only moves the floor on. It never counts as a pass, so a meeting
      // whose agents have all gone quiet waits for them instead of racing through the agenda.
      if (s.status === 'live' && s.speaker && s.turnDeadline !== null && ctx.now > s.turnDeadline) {
        if (s.missedInRow < s.agents.length) effects.push({ type: 'turn_missed', agent: s.speaker });
        s.missedInRow += 1;
        nextSpeaker();
      }
      break;
    }
  }
  return { state: s, effects };
}
