import { describe, expect, it } from 'vitest';
import { claimSession, lostSession, ownerKey, sessionOwner, type OwnerStore } from './session-owner';

function memStore(): OwnerStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => { map.set(k, v); },
  };
}

describe('session owner', () => {
  it('the tab that opens last owns the session (the 18/10 case)', () => {
    const s = memStore();
    expect(claimSession(s, 'tok', 'A')).toBe(true);
    expect(lostSession(s, 'tok', 'A', true)).toBe(false);
    expect(claimSession(s, 'tok', 'B')).toBe(true);
    expect(lostSession(s, 'tok', 'A', true)).toBe(true);
    expect(lostSession(s, 'tok', 'B', true)).toBe(false);
  });

  it('a session cleared elsewhere (work finished) counts as lost', () => {
    const s = memStore();
    claimSession(s, 'tok', 'A');
    s.map.delete(ownerKey('tok'));
    expect(lostSession(s, 'tok', 'A', true)).toBe(true);
  });

  it('a tab that could not claim (store full/disabled) never thinks it lost', () => {
    const full: OwnerStore = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    expect(claimSession(full, 'tok', 'A')).toBe(false);
    expect(lostSession(full, 'tok', 'A', false)).toBe(false);
    expect(claimSession(null, 'tok', 'A')).toBe(false);
  });

  it('sessions are per token', () => {
    const s = memStore();
    claimSession(s, 'one', 'A');
    claimSession(s, 'two', 'B');
    expect(sessionOwner(s, 'one')).toBe('A');
    expect(lostSession(s, 'one', 'A', true)).toBe(false);
  });

  it('the owner key sits under the snapshot prefix (clearAllScans removes it)', () => {
    expect(ownerKey('tok').startsWith('pv:tok:')).toBe(true);
  });
});
