import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  generateIdentity,
  isValidPublicKey,
  meetingCode,
  messagePayload,
  signText,
  verifyText,
} from '../src/shared/crypto';

describe('identity', () => {
  it('signs and verifies', () => {
    const id = generateIdentity();
    const sig = signText(id, 'hello');
    expect(verifyText(id.publicKey, 'hello', sig)).toBe(true);
    expect(verifyText(id.publicKey, 'hello!', sig)).toBe(false);
    expect(verifyText(generateIdentity().publicKey, 'hello', sig)).toBe(false);
    expect(verifyText(id.publicKey, 'hello', 'garbage')).toBe(false);
  });

  it('validates public keys', () => {
    expect(isValidPublicKey(generateIdentity().publicKey)).toBe(true);
    expect(isValidPublicKey('nope')).toBe(false);
    expect(isValidPublicKey(undefined)).toBe(false);
  });

  it('formats fingerprints', () => {
    expect(fingerprint(generateIdentity().publicKey)).toMatch(/^([0-9A-F]{4}-){3}[0-9A-F]{4}$/);
  });

  it('binds a message signature to its turn', () => {
    const base = { meetingId: 'm', participantId: 'p', text: 'hi', pass: false };
    expect(messagePayload({ ...base, turnId: 't1' })).not.toBe(messagePayload({ ...base, turnId: 't2' }));
  });

  it('meeting code is order independent and changes when any key changes', () => {
    const a = { id: 'a', publicKey: generateIdentity().publicKey };
    const b = { id: 'b', publicKey: null };
    const code = meetingCode('m', [a, b]);
    expect(code).toMatch(/^\d{3}-\d{3}-\d{3}-\d{3}$/);
    expect(meetingCode('m', [b, a])).toBe(code);
    expect(meetingCode('m', [a, { id: 'b', publicKey: generateIdentity().publicKey }])).not.toBe(code);
    expect(meetingCode('other', [a, b])).not.toBe(code);
  });
});
