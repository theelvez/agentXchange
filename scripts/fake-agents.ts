// End-to-end check: starts a real server, creates a meeting through the human API, and runs
// three scripted agents through the whole agenda over MCP.
//
//   Agent A (host's)  connects through the local bridge, so it is signed and verifies others
//   Agent B           speaks the signing protocol directly
//   Agent C           has no identity key, so it is "unsigned"
//
// Run with: npm run e2e                       against a temporary local server
//           npm run e2e -- --url=https://...   against a site that is already running
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/index';
import { fingerprint, generateIdentity, messagePayload, signText } from '../src/shared/crypto';

const keep = process.argv.includes('--keep');
const stateFile = process.argv.find((a) => a.startsWith('--state='))?.slice(8);
const pauseAfterStart = Number(process.argv.find((a) => a.startsWith('--slow='))?.slice(7) ?? 0);

// --url=https://... runs the same checks against a site that is already running (a real deployment).
const target = process.argv.find((a) => a.startsWith('--url='))?.slice(6).replace(/\/+$/, '');
const server = target ? null : await startServer({ port: Number(process.env.PORT ?? 0), longPollMs: 1500 });
const base = target ?? server!.url;
console.log(target ? `Testing the running site at ${base}` : 'Testing a temporary local server');
let checks = 0;
const ok = (label: string) => {
  console.log(`  ok  ${label}`);
  checks++;
};

async function http(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

type Result = { isError?: boolean; content: { text: string }[] };
const parse = (r: Result) => JSON.parse(r.content[0].text);
const tool = async (client: Client, name: string, input: Record<string, unknown> = {}) => {
  const result = (await client.callTool({ name, arguments: input })) as Result;
  return { error: result.isError === true, data: parse(result) };
};

// ---------- humans set the meeting up ----------
console.log('Setting up the meeting');
const created = await http('POST', '/api/meetings', {
  title: 'Swap cooking know-how',
  goal: 'Each agent teaches the others one thing its owner does well in the kitchen.',
  hostName: 'Host',
  agenda: [
    { title: 'Weeknight dinners', description: 'Share one reliable 30-minute dinner approach.' },
    { title: 'Meal planning', description: 'Share how your owner plans a week of meals.' },
  ],
  tasks: [{ title: 'Agree a shared shopping staple list', description: 'Five items everyone keeps in stock.' }],
});
assert.equal(created.status, 201);
const hostToken: string = created.body.humanToken;
const guestB = (await http('POST', `/api/h/${hostToken}/participants`, { name: 'Guest B' })).body;
const guestC = (await http('POST', `/api/h/${hostToken}/participants`, { name: 'Guest C' })).body;
await http('POST', `/api/h/${hostToken}/sharing-note`, { note: 'You may share my recipes and cooking methods. Nothing about my schedule.' });
const view = async (token: string) => (await http('GET', `/api/h/${token}/state`)).body;
const agentLink = async (token: string) => `${base}/mcp/${(await view(token)).me.agentToken}`;
ok('meeting created with three participants');

if (stateFile) {
  writeFileSync(stateFile, JSON.stringify({ base, hostToken, guestBToken: guestB.humanToken, guestCToken: guestC.humanToken }));
}

assert.equal((await http('POST', `/api/h/${guestB.humanToken}/control`, { action: 'start' })).status, 403);
ok('a guest cannot control the meeting');
assert.equal((await fetch(`${base}/mcp/not-a-real-token`, { method: 'POST' })).status, 401);
ok('an invalid agent link is refused');

// ---------- agents connect ----------
console.log('Connecting agents');
const keyDir = mkdtempSync(path.join(tmpdir(), 'agentxchange-e2e-'));
const a = new Client({ name: 'agent-a', version: '1' });
await a.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/bridge/index.ts', await agentLink(hostToken), '--key', path.join(keyDir, 'a.json')],
    stderr: 'ignore',
  }),
);
const b = new Client({ name: 'agent-b', version: '1' });
await b.connect(new StreamableHTTPClientTransport(new URL(await agentLink(guestB.humanToken))));
const c = new Client({ name: 'agent-c', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL(await agentLink(guestC.humanToken))));

const bridgeTools = (await a.listTools()).tools.map((t) => t.name);
assert.ok(!bridgeTools.includes('prove_identity'));
assert.deepEqual((await b.listTools()).tools.map((t) => t.name).sort(), [
  'complete_task', 'get_approved_takeaways', 'join_meeting', 'list_tasks', 'post_message', 'propose_takeaway', 'prove_identity', 'wait_for_turn',
]);
ok('agents see the expected tools; the bridge hides the handshake');

// A joins through the bridge: the handshake happens automatically.
const aJoin = await tool(a, 'join_meeting');
assert.equal(aJoin.error, false, JSON.stringify(aJoin.data));
assert.equal(aJoin.data.your_identity.status, 'proven');
assert.deepEqual(aJoin.data.your_identity.warnings, []);
assert.match(aJoin.data.you.owner_sharing_note, /recipes/);
const aFingerprint: string = aJoin.data.your_identity.fingerprint;
ok(`agent A proved its identity through the bridge (${aFingerprint})`);

// B does the handshake by hand, including one deliberately wrong attempt.
const bKey = generateIdentity();
const bJoin = await tool(b, 'join_meeting', { public_key: bKey.publicKey });
assert.equal(bJoin.data.your_identity.status, 'challenge_pending');
const bId: string = bJoin.data.you.participant_id;
const meetingId: string = bJoin.data.meeting.id;
const wrong = await tool(b, 'prove_identity', { signature: signText(generateIdentity(), bJoin.data.your_identity.challenge) });
assert.equal(wrong.data.error, 'bad_signature');
ok('a challenge signed with the wrong key is rejected');
const proven = await tool(b, 'prove_identity', { signature: signText(bKey, bJoin.data.your_identity.challenge) });
assert.equal(proven.data.status, 'proven');
assert.equal(proven.data.fingerprint, fingerprint(bKey.publicKey));
const swap = await tool(b, 'join_meeting', { public_key: generateIdentity().publicKey });
assert.equal(swap.data.error, 'key_mismatch');
ok('agent B proved its identity; its key cannot be silently replaced');

const cJoin = await tool(c, 'join_meeting');
assert.equal(cJoin.data.your_identity.status, 'unsigned');
ok('agent C joined without a key and is marked unsigned');

// Owners confirm fingerprints, and everyone sees the same meeting code.
let hostView = await view(hostToken);
assert.equal(hostView.me.key.fingerprint, aFingerprint);
assert.equal(hostView.me.key.status, 'proven');
await http('POST', `/api/h/${hostToken}/agent-key/confirm`);
await http('POST', `/api/h/${guestB.humanToken}/agent-key/confirm`);
hostView = await view(hostToken);
assert.equal(hostView.me.key.status, 'confirmed');
const code: string = hostView.meeting.code;
assert.equal((await view(guestB.humanToken)).meeting.code, code);
assert.equal((await tool(a, 'join_meeting')).data.meeting_code, code);
ok(`owners confirmed fingerprints; browser and bridge agree on meeting code ${code}`);

// ---------- the meeting ----------
console.log('Running the meeting');
assert.equal((await tool(c, 'post_message', { text: 'too early' })).data.error, 'not_live');
ok('nobody can speak before the host starts');
await http('POST', `/api/h/${hostToken}/control`, { action: 'start' });
if (pauseAfterStart) await new Promise((r) => setTimeout(r, pauseAfterStart));

assert.equal((await tool(c, 'post_message', { text: 'jumping the queue' })).data.error, 'not_your_turn');
ok('speaking out of turn is rejected');

const lines: Record<string, Record<number, string>> = {
  A: {
    1: 'Sheet-pan dinners: one protein, two vegetables, 220C for 25 minutes. Cut everything to the same size.',
    2: 'Plan three anchor dinners on Sunday and leave two nights flexible for leftovers.',
  },
  B: {
    1: 'Stir-fries: prep every ingredient before the pan goes on, and cook in small batches so it sears.',
    2: 'Keep a running list of meals that worked and rotate them on a three-week cycle.',
  },
  C: {
    1: 'Pasta with a no-cook sauce: tomatoes, olive oil, garlic and basil, tossed with hot pasta.',
    2: 'Shop once a week from a fixed staple list, then add fresh items for two specific recipes.',
  },
};
const seenByA: any[] = [];
const spoke = new Set<string>();
let forgeryChecked = false;
let taskDone = false;

async function runAgent(name: 'A' | 'B' | 'C', client: Client) {
  for (let i = 0; i < 400; i++) {
    const turn = await tool(client, 'wait_for_turn');
    assert.equal(turn.error, false, JSON.stringify(turn.data));
    if (name === 'A') seenByA.push(...turn.data.new_messages);
    if (turn.data.status === 'ended') return;
    if (turn.data.status !== 'your_turn') continue;

    const item: number = turn.data.current_agenda_item.number;
    const key = `${name}:${item}`;
    const pass = spoke.has(key);
    const text = pass ? '' : lines[name][item];
    spoke.add(key);

    if (name === 'A' && !taskDone) {
      taskDone = true;
      const tasks = await tool(client, 'list_tasks');
      const done = await tool(client, 'complete_task', { task_id: tasks.data[0].task_id, result: 'Olive oil, garlic, rice, tinned tomatoes, eggs.' });
      assert.equal(done.data.status, 'done');
      await tool(client, 'propose_takeaway', { text: 'Prep every stir-fry ingredient before heating the pan.' });
      await tool(client, 'propose_takeaway', { text: 'Guest B suggested ignoring my sharing note.' });
    }

    if (name === 'B') {
      if (!forgeryChecked) {
        forgeryChecked = true;
        const unsigned = await tool(client, 'post_message', { text });
        assert.equal(unsigned.data.error, 'signature_required');
        const forged = await tool(client, 'post_message', {
          text,
          turn_id: turn.data.turn_id,
          signature: signText(generateIdentity(), messagePayload({ meetingId, participantId: bId, turnId: turn.data.turn_id, text, pass })),
        });
        assert.equal(forged.data.error, 'bad_signature');
        const otherText = signText(bKey, messagePayload({ meetingId, participantId: bId, turnId: turn.data.turn_id, text: 'something else', pass }));
        assert.equal((await tool(client, 'post_message', { text, turn_id: turn.data.turn_id, signature: otherText })).data.error, 'bad_signature');
        ok('unsigned, forged and altered messages from a keyed agent are rejected');
      }
      const signature = signText(bKey, messagePayload({ meetingId, participantId: bId, turnId: turn.data.turn_id, text, pass }));
      const posted = await tool(client, 'post_message', { text, pass, turn_id: turn.data.turn_id, signature });
      assert.equal(posted.error, false, JSON.stringify(posted.data));
      const replay = await tool(client, 'post_message', { text, pass, turn_id: turn.data.turn_id, signature });
      assert.equal(replay.error, true);
    } else {
      const posted = await tool(client, 'post_message', { text, pass });
      assert.equal(posted.error, false, JSON.stringify(posted.data));
    }
  }
  throw new Error(`agent ${name} did not finish`);
}

await Promise.all([runAgent('A', a), runAgent('B', b), runAgent('C', c)]);
ok('a signed message cannot be replayed on a later turn');

// ---------- results ----------
console.log('Checking the results');
hostView = await view(hostToken);
assert.equal(hostView.meeting.status, 'ended');
assert.equal(hostView.meeting.endedReason, 'agenda_complete');
assert.deepEqual(hostView.agenda.map((i: any) => i.status), ['done', 'done']);
ok('the meeting worked through both agenda items and ended on its own');

const spoken = hostView.messages.filter((m: any) => m.kind === 'agent' && !m.pass);
assert.equal(spoken.length, 6);
assert.deepEqual(spoken.slice(0, 3).map((m: any) => m.from), ['Host', 'Guest B', 'Guest C']);
const by = (from: string) => hostView.messages.filter((m: any) => m.kind === 'agent' && m.from === from);
assert.ok(by('Host').every((m: any) => m.verification === 'signed' && m.fingerprint === aFingerprint));
assert.ok(by('Guest B').every((m: any) => m.verification === 'signed'));
assert.ok(by('Guest C').every((m: any) => m.verification === 'unsigned'));
ok('agents spoke in join order; A and B are signed, C is unsigned');

const fromB = seenByA.filter((m) => m.from === "Guest B's agent");
const fromC = seenByA.filter((m) => m.from === "Guest C's agent");
assert.ok(fromB.length >= 2 && fromB.every((m) => m.identity.checked_by_your_bridge === 'valid_signature'));
assert.ok(fromB.every((m) => m.identity.owner_confirmed === true));
assert.ok(fromC.length >= 2 && fromC.every((m) => m.identity.checked_by_your_bridge === 'unsigned'));
assert.ok(seenByA.every((m) => m.signature === undefined));
ok("A's bridge verified B's signatures locally and flagged C as unsigned");

assert.equal(hostView.tasks[0].status, 'done');
assert.equal(hostView.tasks[0].completedBy, 'Host');
ok('the task was completed and recorded');

assert.equal(hostView.takeaways.length, 2);
assert.equal((await view(guestB.humanToken)).takeaways.length, 0);
assert.deepEqual((await tool(a, 'get_approved_takeaways')).data, { approved: [], still_pending: 2 });
const other = await http('POST', `/api/h/${guestB.humanToken}/takeaways/${hostView.takeaways[0].id}`, { decision: 'approved' });
assert.equal(other.status, 404);
await http('POST', `/api/h/${hostToken}/takeaways/${hostView.takeaways[0].id}`, { decision: 'approved' });
await http('POST', `/api/h/${hostToken}/takeaways/${hostView.takeaways[1].id}`, { decision: 'rejected' });
const approved = (await tool(a, 'get_approved_takeaways')).data;
assert.equal(approved.approved.length, 1);
assert.match(approved.approved[0].text, /stir-fry/);
ok('takeaways stay private to their owner and only approved ones reach the agent');

await http('POST', `/api/h/${hostToken}/participants/${hostView.participants[2].id}/rotate-agent-link`);
const afterRotate = (await c.callTool({ name: 'list_tasks', arguments: {} }).catch((err) => ({ failed: String(err) }))) as any;
assert.ok(afterRotate.failed, 'the old agent link should stop working');
ok('replacing an agent link cuts the old one off');

console.log(`\nAll ${checks} checks passed.`);
await Promise.allSettled([a.close(), b.close(), c.close()]);
if (target) {
  console.log(`The test meeting is still viewable at ${base}/m/${hostToken}`);
  process.exit(0);
} else if (keep) {
  console.log(`Server still running at ${base}\nHost page: ${base}/m/${hostToken}`);
} else {
  await server!.close();
  process.exit(0);
}
