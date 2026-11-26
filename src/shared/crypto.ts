// Identity primitives shared by the server and the local bridge.
// Keys are Ed25519. Public and private keys travel as base64url strings (the JWK "x" and "d" values).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

export interface Identity {
  publicKey: string;
  privateKey: string;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  void publicKey;
  return { publicKey: jwk.x as string, privateKey: jwk.d as string };
}

export function isValidPublicKey(publicKey: unknown): publicKey is string {
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(publicKey)) return false;
  try {
    createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

export function signText(identity: Identity, text: string): string {
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKey, d: identity.privateKey },
    format: 'jwk',
  });
  return sign(null, Buffer.from(text, 'utf8'), key).toString('base64url');
}

export function verifyText(publicKey: string, text: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** Short human-comparable form of a public key, e.g. "A1B2-C3D4-E5F6-0718". */
export function fingerprint(publicKey: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}

/** What an agent signs once, on joining, to prove it holds the private key. */
export function joinChallengePayload(p: { meetingId: string; participantId: string; nonce: string }): string {
  return ['agentxchange/v1/join', `meeting:${p.meetingId}`, `participant:${p.participantId}`, `nonce:${p.nonce}`].join('\n');
}

/** What an agent signs for each message. The turn id is single-use, which prevents replay. */
export function messagePayload(p: {
  meetingId: string;
  participantId: string;
  turnId: string;
  text: string;
  pass: boolean;
}): string {
  return [
    'agentxchange/v1/message',
    `meeting:${p.meetingId}`,
    `participant:${p.participantId}`,
    `turn:${p.turnId}`,
    `pass:${p.pass ? 1 : 0}`,
    `text-sha256:${sha256Hex(p.text)}`,
  ].join('\n');
}

/**
 * A short code derived from the meeting and every participant's key.
 * Two people who see the same code are looking at the same set of identities.
 */
export function meetingCode(meetingId: string, roster: { id: string; publicKey: string | null }[]): string {
  const lines = roster.map((r) => `${r.id}:${r.publicKey ?? 'none'}`).sort();
  const digest = createHash('sha256').update(['agentxchange/v1/code', meetingId, ...lines].join('\n'), 'utf8').digest();
  const n = digest.readUIntBE(0, 6) % 1_000_000_000_000;
  return n.toString().padStart(12, '0').match(/.{3}/g)!.join('-');
}

/** Tamper-evident chain: each transcript entry commits to the one before it. */
export function chainHash(p: {
  prevHash: string;
  seq: number;
  kind: string;
  participantId: string | null;
  text: string;
  signature: string | null;
}): string {
  return sha256Hex([p.prevHash, p.seq, p.kind, p.participantId ?? '', sha256Hex(p.text), p.signature ?? ''].join('\n'));
}
