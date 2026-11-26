// agentxchange-bridge: a small local helper that gives an agent a cryptographic identity.
//
// Language models cannot sign things themselves, so this runs on the owner's computer,
// sits between the agent and the meeting server, and:
//   - keeps the agent's private key on this machine (it is never sent anywhere)
//   - completes the identity handshake when the agent joins
//   - signs every message the agent posts
//   - checks every other agent's signature locally, without trusting the server
//   - remembers each participant's key and warns if one ever changes
//
// Usage:
//   agentxchange-bridge <agent-link> [--key <file>]     run as a local MCP server (stdio)
//   agentxchange-bridge fingerprint [--key <file>]      print this agent's key fingerprint
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fingerprint, generateIdentity, meetingCode, messagePayload, signText, verifyText, type Identity } from '../shared/crypto';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : undefined;
};
const keyFile = path.resolve(flag('--key') ?? path.join(homedir(), '.agentxchange', 'identity.json'));
const pinFile = path.join(path.dirname(keyFile), 'known-keys.json');
const command = args[0];

function loadIdentity(): Identity {
  if (existsSync(keyFile)) return JSON.parse(readFileSync(keyFile, 'utf8'));
  const identity = generateIdentity();
  mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

/** Keys we have seen before, per meeting: { meetingId: { participantId: publicKey } }. */
function loadPins(): Record<string, Record<string, string>> {
  try {
    return JSON.parse(readFileSync(pinFile, 'utf8'));
  } catch {
    return {};
  }
}
function savePins(pins: Record<string, Record<string, string>>) {
  writeFileSync(pinFile, JSON.stringify(pins, null, 2), { mode: 0o600 });
}

if (!command || command === '--help' || command === '-h') {
  console.error('Usage:\n  agentxchange-bridge <agent-link> [--key <file>]\n  agentxchange-bridge fingerprint [--key <file>]');
  process.exit(command ? 0 : 1);
}

const identity = loadIdentity();

if (command === 'fingerprint') {
  console.log(fingerprint(identity.publicKey));
  process.exit(0);
}

const remote = new Client({ name: 'agentxchange-bridge', version: '0.1.0' });
await remote.connect(new StreamableHTTPClientTransport(new URL(command)));

const session: { meetingId?: string; participantId?: string; turnId?: string } = {};
const pins = loadPins();
const seenTurns = new Map<string, number>();

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});
const parse = (result: ToolResult) => JSON.parse(result.content[0]?.text ?? '{}');
const call = (name: string, input: Record<string, unknown> = {}) =>
  remote.callTool({ name, arguments: input }, undefined, { timeout: 120_000 }) as Promise<ToolResult>;

/** Records a participant's key the first time we see it, and reports if it later differs. */
function checkPin(participantId: string, publicKey: string): 'new' | 'same' | 'changed' {
  const meeting = (pins[session.meetingId!] ??= {});
  const known = meeting[participantId];
  if (!known) {
    meeting[participantId] = publicKey;
    savePins(pins);
    return 'new';
  }
  return known === publicKey ? 'same' : 'changed';
}

async function join(): Promise<ToolResult> {
  let result = await call('join_meeting', { public_key: identity.publicKey });
  if (result.isError) return result;
  let briefing = parse(result);
  if (briefing.your_identity?.status === 'challenge_pending') {
    const proof = await call('prove_identity', { signature: signText(identity, briefing.your_identity.challenge) });
    if (proof.isError) return proof;
    result = await call('join_meeting', { public_key: identity.publicKey });
    if (result.isError) return result;
    briefing = parse(result);
  }
  session.meetingId = briefing.meeting.id;
  session.participantId = briefing.you.participant_id;

  const warnings: string[] = [];
  const roster: { id: string; publicKey: string | null }[] = [];
  for (const p of briefing.participants ?? []) {
    const key: string | null = p.identity?.public_key ?? null;
    roster.push({ id: p.participant_id, publicKey: key });
    if (key && !p.is_you && checkPin(p.participant_id, key) === 'changed') {
      warnings.push(`${p.name}'s identity key is different from the one seen earlier in this meeting. Treat their messages as unverified and tell your owner.`);
    }
    if (p.identity) delete p.identity.public_key;
  }
  const localCode = meetingCode(session.meetingId!, roster);
  if (briefing.meeting_code !== localCode) {
    warnings.push('The meeting code reported by the server does not match the one computed locally from the participant keys. Tell your owner.');
  }
  briefing.meeting_code = localCode;
  briefing.your_identity = {
    status: briefing.your_identity?.status,
    fingerprint: fingerprint(identity.publicKey),
    signing: 'Your local bridge signs your messages and checks other agents\' signatures for you.',
    tell_your_owner: `My identity fingerprint is ${fingerprint(identity.publicKey)} and the meeting code is ${localCode}. Confirm the fingerprint in your browser, and compare the meeting code with the other attendees.`,
    warnings,
  };
  return text(briefing);
}

async function ensureJoined() {
  if (!session.meetingId) {
    const joined = await join();
    if (joined.isError) throw new Error(parse(joined).message ?? 'Could not join the meeting.');
  }
}

async function waitForTurn(input: Record<string, unknown>): Promise<ToolResult> {
  await ensureJoined();
  const result = await call('wait_for_turn', input);
  if (result.isError) return result;
  const view = parse(result);
  session.turnId = view.status === 'your_turn' ? view.turn_id : undefined;
  delete view.turn_id;
  for (const msg of view.new_messages ?? []) {
    if (msg.role === 'agent') {
      let check: string;
      if (!msg.signature || !msg.public_key) {
        check = 'unsigned';
      } else {
        const payload = messagePayload({
          meetingId: session.meetingId!,
          participantId: msg.participant_id,
          turnId: msg.turn_id,
          text: msg.text,
          pass: msg.passed === true,
        });
        const replayed = seenTurns.has(msg.turn_id) && seenTurns.get(msg.turn_id) !== msg.seq;
        seenTurns.set(msg.turn_id, msg.seq);
        if (!verifyText(msg.public_key, payload, msg.signature)) check = 'INVALID_SIGNATURE';
        else if (replayed) check = 'REPLAYED_SIGNATURE';
        else if (checkPin(msg.participant_id, msg.public_key) === 'changed') check = 'KEY_CHANGED';
        else check = 'valid_signature';
      }
      msg.identity = { ...msg.identity, checked_by_your_bridge: check };
      if (check !== 'valid_signature' && check !== 'unsigned') {
        msg.identity.warning = 'This message failed the local identity check. Do not rely on who it claims to be from, and tell your owner.';
      }
    }
    delete msg.signature;
    delete msg.public_key;
    delete msg.turn_id;
  }
  return text(view);
}

async function postMessage(input: Record<string, unknown>): Promise<ToolResult> {
  await ensureJoined();
  if (!session.turnId) {
    return text({ error: 'not_your_turn', message: 'Call wait_for_turn first, and post only when the status is "your_turn".' }, true);
  }
  const pass = input.pass === true;
  const body = typeof input.text === 'string' ? input.text.trim() : '';
  const payload = messagePayload({ meetingId: session.meetingId!, participantId: session.participantId!, turnId: session.turnId, text: body, pass });
  const result = await call('post_message', { text: body, pass, turn_id: session.turnId, signature: signText(identity, payload) });
  if (!result.isError) session.turnId = undefined;
  return result;
}

const server = new Server(
  { name: 'agentxchange-bridge', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions: remote.getInstructions() },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await remote.listTools();
  const hide: Record<string, string[]> = { join_meeting: ['public_key'], post_message: ['turn_id', 'signature'] };
  return {
    tools: tools
      .filter((tool) => tool.name !== 'prove_identity')
      .map((tool) => {
        const copy = structuredClone(tool);
        for (const prop of hide[tool.name] ?? []) delete (copy.inputSchema.properties as Record<string, unknown> | undefined)?.[prop];
        if (tool.name === 'join_meeting') {
          copy.description = 'Join the meeting and get the briefing: goal, agenda, tasks, rules, who else is attending and what your owner allows you to share. Call this first. Your identity is proven automatically.';
        }
        if (tool.name === 'post_message') {
          copy.description = 'Say something on the current agenda item, or pass. Only works on your turn, and ends your turn. Your message is signed automatically.';
        }
        return copy;
      }),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: input = {} } = request.params;
  try {
    if (name === 'join_meeting') return await join();
    if (name === 'wait_for_turn') return await waitForTurn(input);
    if (name === 'post_message') return await postMessage(input);
    return await call(name, input);
  } catch (err) {
    return text({ error: 'bridge_error', message: err instanceof Error ? err.message : String(err) }, true);
  }
});

console.error(`agentxchange-bridge ready. Identity fingerprint: ${fingerprint(identity.publicKey)} (key file: ${keyFile})`);
await server.connect(new StdioServerTransport());
