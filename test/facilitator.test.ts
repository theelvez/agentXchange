import { describe, expect, it } from 'vitest';
import { apply, FacilitatorError, initialState, itemStatus, type FEvent, type FState } from '../src/server/facilitator';

let turn = 0;
let now = 1_000;
const ctx = () => ({ now, newTurnId: () => `t${++turn}` });

function run(state: FState, ...events: FEvent[]) {
  const effects = [];
  for (const event of events) {
    const out = apply(state, event, ctx());
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

const live = (items = ['i1', 'i2'], limits = {}) =>
  run(initialState(items, limits), { type: 'join', agent: 'a' }, { type: 'join', agent: 'b' }, { type: 'start' }).state;

describe('facilitator', () => {
  it('starts on the first item and gives the floor to the first agent who joined', () => {
    const s = live();
    expect(s.status).toBe('live');
    expect(s.speaker).toBe('a');
    expect(itemStatus(s, 'i1')).toBe('active');
    expect(itemStatus(s, 'i2')).toBe('pending');
  });

  it('refuses to start with an empty agenda', () => {
    expect(() => apply(initialState([]), { type: 'start' }, ctx())).toThrow(FacilitatorError);
  });

  it('alternates turns and issues a fresh turn id each time', () => {
    const s0 = live();
    const s1 = run(s0, { type: 'post', agent: 'a', pass: false }).state;
    expect(s1.speaker).toBe('b');
    expect(s1.turnId).not.toBe(s0.turnId);
    expect(run(s1, { type: 'post', agent: 'b', pass: false }).state.speaker).toBe('a');
  });

  it('rejects an agent speaking out of turn', () => {
    expect(() => apply(live(), { type: 'post', agent: 'b', pass: false }, ctx())).toThrow(/not your turn/i);
  });

  it('moves to the next item only when every agent passes in a row', () => {
    let s = run(live(), { type: 'post', agent: 'a', pass: true }, { type: 'post', agent: 'b', pass: false }).state;
    expect(s.currentItem).toBe(0);
    const out = run(s, { type: 'post', agent: 'a', pass: true }, { type: 'post', agent: 'b', pass: true });
    s = out.state;
    expect(s.currentItem).toBe(1);
    expect(itemStatus(s, 'i1')).toBe('done');
    expect(out.effects).toContainEqual({ type: 'item_finished', itemId: 'i1', reason: 'everyone_passed' });
    expect(out.effects).toContainEqual({ type: 'item_started', itemId: 'i2' });
  });

  it('ends the meeting when the last item finishes', () => {
    const s = run(
      live(['only']),
      { type: 'post', agent: 'a', pass: true },
      { type: 'post', agent: 'b', pass: true },
    ).state;
    expect(s.status).toBe('ended');
    expect(s.endedReason).toBe('agenda_complete');
    expect(s.speaker).toBeNull();
  });

  it('enforces the per-item turn limit', () => {
    const s = run(
      live(['i1', 'i2'], { maxTurnsPerItem: 2 }),
      { type: 'post', agent: 'a', pass: false },
      { type: 'post', agent: 'b', pass: false },
    ).state;
    expect(s.currentItem).toBe(1);
    expect(s.itemTurns).toBe(0);
  });

  it('enforces the whole-meeting turn limit', () => {
    const s = run(
      live(['i1', 'i2'], { maxTotalTurns: 3 }),
      { type: 'post', agent: 'a', pass: false },
      { type: 'post', agent: 'b', pass: false },
      { type: 'post', agent: 'a', pass: false },
    ).state;
    expect(s.status).toBe('ended');
    expect(s.endedReason).toBe('turn_limit');
  });

  it('blocks speaking while paused and resumes with the same speaker', () => {
    const paused = run(live(), { type: 'pause' }).state;
    expect(paused.turnDeadline).toBeNull();
    expect(() => apply(paused, { type: 'post', agent: 'a', pass: false }, ctx())).toThrow(/paused/);
    const resumed = run(paused, { type: 'resume' }).state;
    expect(resumed.status).toBe('live');
    expect(resumed.speaker).toBe('a');
    expect(resumed.turnDeadline).not.toBeNull();
  });

  it('lets the host skip an item', () => {
    const s = run(live(), { type: 'skip_item' }).state;
    expect(itemStatus(s, 'i1')).toBe('skipped');
    expect(itemStatus(s, 'i2')).toBe('active');
  });

  it('a human message resets the pass count so agents can respond', () => {
    const s = run(
      live(),
      { type: 'post', agent: 'a', pass: true },
      { type: 'human_message' },
      { type: 'post', agent: 'b', pass: true },
    ).state;
    expect(s.currentItem).toBe(0);
  });

  it('a missed turn moves the floor on but never advances the agenda', () => {
    let s = live(['i1', 'i2'], { turnTimeoutMs: 100 });
    for (let i = 0; i < 10; i++) {
      now += 500;
      s = run(s, { type: 'tick' }).state;
    }
    expect(s.status).toBe('live');
    expect(s.currentItem).toBe(0);
    expect(s.totalTurns).toBe(0);
    now = 1_000;
  });

  it('announces missed turns once per agent, then stays quiet', () => {
    let s = live(['i1'], { turnTimeoutMs: 100 });
    let missed = 0;
    for (let i = 0; i < 6; i++) {
      now += 500;
      const out = run(s, { type: 'tick' });
      s = out.state;
      missed += out.effects.filter((e) => e.type === 'turn_missed').length;
    }
    expect(missed).toBe(2);
    now = 1_000;
  });

  it('gives the floor to an agent who joins a live meeting with nobody in it', () => {
    const s = run(initialState(['i1']), { type: 'start' }, { type: 'join', agent: 'a' }).state;
    expect(s.speaker).toBe('a');
  });

  it('rejects everything after the meeting ends', () => {
    const ended = run(live(), { type: 'end', reason: 'host_ended' }).state;
    expect(() => apply(ended, { type: 'join', agent: 'c' }, ctx())).toThrow(/ended/);
  });
});
