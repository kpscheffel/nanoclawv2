import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  createPairing,
  tryConsume,
  getStatus,
  waitForPairing,
  extractCode,
  extractAddressedText,
  _setStorePathForTest,
  _resetForTest,
} from './telegram-pairing.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pair-'));
  _setStorePathForTest(path.join(tmpDir, 'pairings.json'));
});

afterEach(() => {
  _resetForTest();
  _setStorePathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('extractAddressedText', () => {
  it('strips @botname prefix', () => {
    expect(extractAddressedText('@nanobot 1234', 'nanobot')).toBe('1234');
  });
  it('is case-insensitive', () => {
    expect(extractAddressedText('@NanoBot hello', 'nanobot')).toBe('hello');
  });
  it('returns null when not addressed', () => {
    expect(extractAddressedText('hello 1234', 'nanobot')).toBeNull();
  });
  it('returns null when address is mid-text', () => {
    expect(extractAddressedText('hi @nanobot 1234', 'nanobot')).toBeNull();
  });
});

describe('extractCode', () => {
  it('accepts a bare 4-digit code', () => {
    expect(extractCode('0349', 'nanobot')).toBe('0349');
  });
  it('accepts 4-digit code after @botname', () => {
    expect(extractCode('@nanobot 0042', 'nanobot')).toBe('0042');
  });
  it('rejects non-4-digit numbers', () => {
    expect(extractCode('@nanobot 12345', 'nanobot')).toBeNull();
    expect(extractCode('@nanobot 12', 'nanobot')).toBeNull();
    expect(extractCode('12345', 'nanobot')).toBeNull();
  });
  it('rejects loose matches with surrounding text', () => {
    expect(extractCode('my pin is 0349', 'nanobot')).toBeNull();
    expect(extractCode('0349 thanks', 'nanobot')).toBeNull();
  });
});

describe('createPairing', () => {
  it('generates a 4-digit code with TTL', async () => {
    const r = await createPairing('main', { ttlMs: 60_000 });
    expect(r.code).toMatch(/^\d{4}$/);
    expect(r.status).toBe('pending');
    expect(Date.parse(r.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('does not collide with active codes', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const r = await createPairing('main');
      expect(codes.has(r.code)).toBe(false);
      codes.add(r.code);
    }
  });
});

describe('tryConsume', () => {
  it('matches and marks consumed', async () => {
    const r = await createPairing('main');
    const consumed = await tryConsume({
      text: `@nanobot ${r.code}`,
      botUsername: 'nanobot',
      platformId: 'telegram:123',
      isGroup: false,
      adminUserId: 'u1',
    });
    expect(consumed).not.toBeNull();
    expect(consumed!.status).toBe('consumed');
    expect(consumed!.consumed?.platformId).toBe('telegram:123');
    expect(consumed!.consumed?.adminUserId).toBe('u1');
    expect(getStatus(r.code)).toBe('consumed');
  });

  it('returns null on no match (silent drop)', async () => {
    await createPairing('main');
    const out = await tryConsume({
      text: '@nanobot 9999',
      botUsername: 'nanobot',
      platformId: 'x',
      isGroup: false,
    });
    expect(out).toBeNull();
  });

  it('matches a bare code without @botname addressing', async () => {
    const r = await createPairing('main');
    const out = await tryConsume({
      text: r.code,
      botUsername: 'nanobot',
      platformId: 'x',
      isGroup: false,
    });
    expect(out).not.toBeNull();
    expect(out!.status).toBe('consumed');
  });

  it('cannot be consumed twice', async () => {
    const r = await createPairing('main');
    await tryConsume({ text: `@b ${r.code}`, botUsername: 'b', platformId: 'p', isGroup: false });
    const second = await tryConsume({ text: `@b ${r.code}`, botUsername: 'b', platformId: 'p', isGroup: false });
    expect(second).toBeNull();
  });

  it('cannot consume an expired pairing', async () => {
    const r = await createPairing('main', { ttlMs: 1 });
    await new Promise((res) => setTimeout(res, 10));
    const out = await tryConsume({ text: `@b ${r.code}`, botUsername: 'b', platformId: 'p', isGroup: false });
    expect(out).toBeNull();
    expect(getStatus(r.code)).toBe('expired');
  });
});

describe('getStatus', () => {
  it('returns unknown for missing codes', () => {
    expect(getStatus('0000')).toBe('unknown');
  });
});

describe('waitForPairing', () => {
  it('resolves when consumed', async () => {
    const r = await createPairing('main', { ttlMs: 5000 });
    const p = waitForPairing(r.code, { pollMs: 50 });
    setTimeout(() => {
      tryConsume({ text: `@b ${r.code}`, botUsername: 'b', platformId: 'tg:1', isGroup: true, name: 'Group' });
    }, 100);
    const consumed = await p;
    expect(consumed.status).toBe('consumed');
    expect(consumed.consumed?.name).toBe('Group');
  });

  it('rejects on expiry', async () => {
    const r = await createPairing('main', { ttlMs: 100 });
    await expect(waitForPairing(r.code, { pollMs: 30 })).rejects.toThrow(/expired/);
  });
});

describe('intent passthrough', () => {
  it('preserves wire-to and new-agent intents', async () => {
    const a = await createPairing({ kind: 'wire-to', folder: 'work' });
    const b = await createPairing({ kind: 'new-agent', folder: 'side' });
    const ca = await tryConsume({ text: `@b ${a.code}`, botUsername: 'b', platformId: 'p1', isGroup: true });
    const cb = await tryConsume({ text: `@b ${b.code}`, botUsername: 'b', platformId: 'p2', isGroup: true });
    expect(ca!.intent).toEqual({ kind: 'wire-to', folder: 'work' });
    expect(cb!.intent).toEqual({ kind: 'new-agent', folder: 'side' });
  });
});
