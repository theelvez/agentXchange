import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { FState } from '../facilitator';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const meetings = pgTable('meetings', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  goal: text('goal').notNull().default(''),
  state: jsonb('state').$type<FState>().notNull(),
  seq: integer('seq').notNull().default(0),
  lastHash: text('last_hash').notNull().default(''),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const participants = pgTable('participants', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull(),
  name: text('name').notNull(),
  isHost: boolean('is_host').notNull().default(false),
  humanToken: text('human_token').notNull().unique(),
  agentToken: text('agent_token').notNull().unique(),
  sharingNote: text('sharing_note').notNull().default(''),
  agentPublicKey: text('agent_public_key'),
  /** none: no key. proven: the agent proved it holds the key. confirmed: the owner also confirmed the fingerprint. */
  keyStatus: text('key_status').$type<'none' | 'proven' | 'confirmed'>().notNull().default('none'),
  pendingPublicKey: text('pending_public_key'),
  challengeNonce: text('challenge_nonce'),
  agentCursor: integer('agent_cursor').notNull().default(0),
  joinedAt: ts('joined_at'),
  lastSeenAt: ts('last_seen_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const agendaItems = pgTable('agenda_items', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull(),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
});

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull(),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').$type<'open' | 'done'>().notNull().default('open'),
  result: text('result'),
  completedBy: text('completed_by'),
});

export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull(),
  seq: integer('seq').notNull(),
  kind: text('kind').$type<'agent' | 'human' | 'system'>().notNull(),
  participantId: text('participant_id'),
  agendaItemId: text('agenda_item_id'),
  text: text('text').notNull(),
  pass: boolean('pass').notNull().default(false),
  turnId: text('turn_id'),
  signature: text('signature'),
  publicKey: text('public_key'),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const takeaways = pgTable('takeaways', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull(),
  participantId: text('participant_id').notNull(),
  text: text('text').notNull(),
  status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
  createdAt: ts('created_at').notNull().defaultNow(),
  decidedAt: ts('decided_at'),
});

/** Kept in step with the tables above. Safe to run on every start. */
export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS meetings (
  id text PRIMARY KEY, title text NOT NULL, goal text NOT NULL DEFAULT '', state jsonb NOT NULL,
  seq integer NOT NULL DEFAULT 0, last_hash text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS participants (
  id text PRIMARY KEY, meeting_id text NOT NULL, name text NOT NULL, is_host boolean NOT NULL DEFAULT false,
  human_token text NOT NULL UNIQUE, agent_token text NOT NULL UNIQUE, sharing_note text NOT NULL DEFAULT '',
  agent_public_key text, key_status text NOT NULL DEFAULT 'none', pending_public_key text, challenge_nonce text,
  agent_cursor integer NOT NULL DEFAULT 0, joined_at timestamptz, last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS agenda_items (
  id text PRIMARY KEY, meeting_id text NOT NULL, position integer NOT NULL, title text NOT NULL,
  description text NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY, meeting_id text NOT NULL, position integer NOT NULL, title text NOT NULL,
  description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'open', result text, completed_by text);
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY, meeting_id text NOT NULL, seq integer NOT NULL, kind text NOT NULL, participant_id text,
  agenda_item_id text, text text NOT NULL, pass boolean NOT NULL DEFAULT false, turn_id text, signature text,
  public_key text, prev_hash text NOT NULL, hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS takeaways (
  id text PRIMARY KEY, meeting_id text NOT NULL, participant_id text NOT NULL, text text NOT NULL,
  status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz);
CREATE INDEX IF NOT EXISTS participants_meeting ON participants (meeting_id);
CREATE INDEX IF NOT EXISTS agenda_meeting ON agenda_items (meeting_id);
CREATE INDEX IF NOT EXISTS tasks_meeting ON tasks (meeting_id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_meeting_seq ON messages (meeting_id, seq);
CREATE INDEX IF NOT EXISTS takeaways_meeting ON takeaways (meeting_id);
`;
