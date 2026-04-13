/**
 * Telegram pairing — proves the operator owns the chat they're registering.
 *
 * BotFather hands out tokens with no user binding, so anyone who guesses the
 * bot's username can DM it. Pairing closes that gap: setup creates a one-time
 * 4-digit code and the operator echoes it back from the chat they want to
 * register. The message must be exactly the 4 digits (optionally prefixed by
 * `@botname ` for groups with privacy ON) — arbitrary messages that happen to
 * contain a 4-digit number do NOT match. The inbound interceptor in
 * telegram.ts matches the code and records the chat (with admin_user_id)
 * before it ever reaches the router.
 *
 * Storage is a JSON file at data/telegram-pairings.json — single-process,
 * read-modify-write under an in-process mutex.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';

export type PairingIntent = 'main' | { kind: 'wire-to'; folder: string } | { kind: 'new-agent'; folder: string };
export type PairingStatus = 'pending' | 'consumed' | 'expired' | 'unknown';

export interface ConsumedDetails {
  platformId: string;
  isGroup: boolean;
  name: string | null;
  adminUserId: string | null;
  consumedAt: string;
}

export interface PairingRecord {
  code: string;
  intent: PairingIntent;
  createdAt: string;
  expiresAt: string;
  status: Exclude<PairingStatus, 'unknown'>;
  consumed?: ConsumedDetails;
}

interface Store {
  pairings: PairingRecord[];
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const FILE_NAME = 'telegram-pairings.json';

let storePathOverride: string | null = null;
export function _setStorePathForTest(p: string | null): void {
  storePathOverride = p;
}

function storePath(): string {
  return storePathOverride ?? path.join(DATA_DIR, FILE_NAME);
}

let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = mutex.then(() => fn());
  mutex = next.catch(() => {});
  return next;
}

function readStore(): Store {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Store;
    if (!Array.isArray(parsed.pairings)) return { pairings: [] };
    return parsed;
  } catch {
    return { pairings: [] };
  }
}

function writeStore(store: Store): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, p);
}

function sweep(store: Store, now: number): boolean {
  let changed = false;
  for (const r of store.pairings) {
    if (r.status === 'pending' && Date.parse(r.expiresAt) <= now) {
      r.status = 'expired';
      changed = true;
    }
  }
  return changed;
}

function generateCode(active: Set<string>): string {
  // 4-digit numeric, zero-padded. 10k space, fine for one-at-a-time intents.
  for (let i = 0; i < 50; i++) {
    const code = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, '0');
    if (!active.has(code)) return code;
  }
  throw new Error('Could not allocate a free pairing code (too many active).');
}

export interface CreatePairingOptions {
  ttlMs?: number;
}

export async function createPairing(intent: PairingIntent, opts: CreatePairingOptions = {}): Promise<PairingRecord> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  return withLock(() => {
    const store = readStore();
    sweep(store, Date.now());
    const active = new Set(store.pairings.filter((r) => r.status === 'pending').map((r) => r.code));
    const now = new Date();
    const record: PairingRecord = {
      code: generateCode(active),
      intent,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      status: 'pending',
    };
    store.pairings.push(record);
    writeStore(store);
    log.info('Pairing created', { code: record.code, intent, expiresAt: record.expiresAt });
    return record;
  });
}

export interface ConsumeInput {
  text: string;
  botUsername: string;
  platformId: string;
  isGroup: boolean;
  name?: string | null;
  adminUserId?: string | null;
}

/** Strip leading @botname and return the trimmed remainder, or null if not addressed. */
export function extractAddressedText(text: string, botUsername: string): string | null {
  const trimmed = text.trim();
  const re = new RegExp(`^@${botUsername.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
  const m = trimmed.match(re);
  if (!m) return null;
  return trimmed.slice(m[0].length).trim();
}

/**
 * Extract a pairing code from an inbound message. The message must be exactly
 * 4 digits (optionally prefixed by `@botname `) — loose matches like
 * "my pin is 1234" are rejected to avoid false positives from chatter.
 */
export function extractCode(text: string, botUsername: string): string | null {
  const addressed = extractAddressedText(text, botUsername);
  const candidate = (addressed !== null ? addressed : text).trim();
  const m = candidate.match(/^(\d{4})$/);
  return m ? m[1] : null;
}

/**
 * Try to match an inbound message against a pending pairing. On match,
 * marks the pairing consumed atomically and returns the record. Returns
 * null on no match or expiry (silent drop).
 */
export async function tryConsume(input: ConsumeInput): Promise<PairingRecord | null> {
  const code = extractCode(input.text, input.botUsername);
  if (!code) return null;
  return withLock(() => {
    const store = readStore();
    const now = Date.now();
    sweep(store, now);
    const record = store.pairings.find((r) => r.code === code && r.status === 'pending');
    if (!record) {
      writeStore(store);
      return null;
    }
    record.status = 'consumed';
    record.consumed = {
      platformId: input.platformId,
      isGroup: input.isGroup,
      name: input.name ?? null,
      adminUserId: input.adminUserId ?? null,
      consumedAt: new Date(now).toISOString(),
    };
    writeStore(store);
    log.info('Pairing consumed', { code, platformId: input.platformId, intent: record.intent });
    return record;
  });
}

export function getStatus(code: string): PairingStatus {
  const store = readStore();
  sweep(store, Date.now());
  const r = store.pairings.find((p) => p.code === code);
  if (!r) return 'unknown';
  return r.status;
}

export function getPairing(code: string): PairingRecord | null {
  const store = readStore();
  sweep(store, Date.now());
  return store.pairings.find((p) => p.code === code) ?? null;
}

export interface WaitForPairingOptions {
  /** Total time to wait. Defaults to the pairing's own TTL (read on each tick). */
  timeoutMs?: number;
  /** Polling interval as a fallback when fs.watch misses an event. */
  pollMs?: number;
}

/**
 * Resolve when the pairing is consumed; reject when it expires or the timeout
 * elapses. Uses fs.watch as the primary signal with a slow poll fallback —
 * fs.watch is unreliable across rename-replace on some filesystems.
 */
export async function waitForPairing(code: string, opts: WaitForPairingOptions = {}): Promise<PairingRecord> {
  const pollMs = opts.pollMs ?? 1000;
  const start = Date.now();
  const initial = getPairing(code);
  if (!initial) throw new Error(`Unknown pairing code: ${code}`);
  const deadline = start + (opts.timeoutMs ?? Math.max(0, Date.parse(initial.expiresAt) - start));

  return new Promise<PairingRecord>((resolve, reject) => {
    let watcher: fs.FSWatcher | null = null;
    let interval: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      settled = true;
      if (watcher)
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      if (interval) clearInterval(interval);
    };

    const check = () => {
      if (settled) return;
      const r = getPairing(code);
      if (!r) {
        cleanup();
        reject(new Error(`Pairing ${code} disappeared`));
        return;
      }
      if (r.status === 'consumed') {
        cleanup();
        resolve(r);
        return;
      }
      if (r.status === 'expired' || Date.now() >= deadline) {
        cleanup();
        reject(new Error(`Pairing ${code} expired`));
        return;
      }
    };

    try {
      const dir = path.dirname(storePath());
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, (_event, fname) => {
        if (!fname || fname.toString().startsWith(path.basename(storePath()))) check();
      });
    } catch {
      // fs.watch unsupported — poll-only is fine
    }
    interval = setInterval(check, pollMs);
    check();
  });
}

/** Test helper — wipe the store. */
export function _resetForTest(): void {
  try {
    fs.unlinkSync(storePath());
  } catch {
    // ignore
  }
}
