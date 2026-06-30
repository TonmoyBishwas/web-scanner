/**
 * Session storage + distributed locks, backed by Supabase/Postgres.
 *
 * This file keeps the SAME filename and the SAME exports as the previous
 * Upstash-Redis implementation (`sessionStorage`, `getRedisClient`,
 * `palletKey`, `sessionKey`) so the API routes barely change — they keep
 * importing from `@/lib/redis`.
 *
 * Storage model:
 *   - `scan_sessions` (token PK, `kind` enum, `data` jsonb, `expires_at`).
 *       carton sessions      -> kind = 'carton'        (old `session:` namespace)
 *       pallet sessions      -> kind = 'pallet'        (old `pallet:` namespace)
 *       multi-pallet sessions-> kind = 'multi_pallet'  (old `pallet:multi:` namespace)
 *   - `locks` (token PK, locker_id, expires_at) via `acquire_lock`/`release_lock`
 *     RPCs, reproducing Redis `SET NX EX 10` + value-checked release.
 *
 * TTL is enforced lazily on read (`expires_at > now()`), mirroring Redis EX.
 */
import { supabase } from '@/lib/supabase';

const CARTON_TTL = 3600; // 1h default for carton sessions
const PALLET_TTL = 7200; // 2h default for pallet / multi-pallet sessions

type SessionKind = 'carton' | 'pallet' | 'multi_pallet';

/** Legacy key helpers (kept exported for parity; routes also define locals). */
export function palletKey(token: string): string {
  return `pallet:${token}`;
}
export function sessionKey(token: string): string {
  return `session:${token}`;
}

/**
 * Parse a legacy Redis-style key into a scan_sessions {kind, token}. Order
 * matters: `pallet:multi:` must be tested before `pallet:`.
 */
function parseKey(key: string): { kind: SessionKind; token: string } {
  if (key.startsWith('pallet:multi:')) {
    return { kind: 'multi_pallet', token: key.slice('pallet:multi:'.length) };
  }
  if (key.startsWith('pallet:')) {
    return { kind: 'pallet', token: key.slice('pallet:'.length) };
  }
  if (key.startsWith('session:')) {
    return { kind: 'carton', token: key.slice('session:'.length) };
  }
  // Fallback: treat the whole string as a carton token.
  return { kind: 'carton', token: key };
}

function defaultTtlForKind(kind: SessionKind): number {
  return kind === 'carton' ? CARTON_TTL : PALLET_TTL;
}

function nowISO(): string {
  return new Date().toISOString();
}

function expiresAtISO(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

async function readSession(kind: SessionKind, token: string): Promise<unknown | null> {
  const { data, error } = await supabase
    .from('scan_sessions')
    .select('data')
    .eq('token', token)
    .eq('kind', kind)
    .gt('expires_at', nowISO())
    .maybeSingle();

  if (error) {
    throw new Error(`scan_sessions read failed (${kind}:${token}): ${error.message}`);
  }
  return data ? (data.data as unknown) : null;
}

async function writeSession(
  kind: SessionKind,
  token: string,
  payload: unknown,
  ttlSeconds: number
): Promise<void> {
  const { error } = await supabase
    .from('scan_sessions')
    .upsert(
      {
        token,
        kind,
        data: payload as object,
        expires_at: expiresAtISO(ttlSeconds),
        updated_at: nowISO(),
      },
      { onConflict: 'token' }
    );

  if (error) {
    throw new Error(`scan_sessions write failed (${kind}:${token}): ${error.message}`);
  }
}

/**
 * Returns a small Redis-compatible shim. The pallet routes call
 * `.get(key)` / `.set(key, val, {ex})` / `.del(key)` with the legacy key
 * strings and JSON-(de)serialize the values themselves; this shim mirrors that
 * contract on top of Postgres.
 */
export function getRedisClient() {
  return {
    async get(key: string): Promise<unknown | null> {
      const { kind, token } = parseKey(key);
      // Returns the deserialized jsonb object. Callers do
      // `typeof raw === 'string' ? JSON.parse(raw) : raw`, so an object is fine.
      return readSession(kind, token);
    },

    async set(key: string, value: unknown, options?: { ex?: number }): Promise<void> {
      const { kind, token } = parseKey(key);
      const ttl = options?.ex ?? defaultTtlForKind(kind);
      // Routes pass a JSON string (JSON.stringify(session)); store the parsed
      // object in the jsonb column. Accept raw objects too for safety.
      const payload = typeof value === 'string' ? JSON.parse(value) : value;
      await writeSession(kind, token, payload, ttl);
    },

    async del(key: string): Promise<void> {
      const { token } = parseKey(key);
      // token is the PK, so deleting by token removes the single matching row.
      const { error } = await supabase.from('scan_sessions').delete().eq('token', token);
      if (error) {
        throw new Error(`scan_sessions delete failed (${token}): ${error.message}`);
      }
    },
  };
}

/**
 * Carton session storage (kind = 'carton'). Same surface as before.
 */
export const sessionStorage = {
  async get(token: string): Promise<any> {
    return readSession('carton', token);
  },

  async set(token: string, data: any, options?: { ex?: number }): Promise<void> {
    await writeSession('carton', token, data, options?.ex ?? CARTON_TTL);
  },

  async delete(token: string): Promise<void> {
    const { error } = await supabase
      .from('scan_sessions')
      .delete()
      .eq('token', token)
      .eq('kind', 'carton');
    if (error) {
      throw new Error(`scan_sessions delete failed (carton:${token}): ${error.message}`);
    }
  },

  async exists(token: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('scan_sessions')
      .select('token')
      .eq('token', token)
      .eq('kind', 'carton')
      .gt('expires_at', nowISO())
      .maybeSingle();
    if (error) {
      throw new Error(`scan_sessions exists failed (carton:${token}): ${error.message}`);
    }
    return !!data;
  },

  /**
   * Execute an operation while holding an exclusive Postgres-backed lock on the
   * session. Reproduces the previous Redis `SET NX EX 10` + 20×250ms retry +
   * value-checked release, via the `acquire_lock` / `release_lock` RPCs.
   */
  async withLock(
    token: string,
    operation: () => Promise<void>,
    retries = 20,
    delay = 250
  ): Promise<void> {
    const lockToken = `lock:${token}`;
    const lockerId = crypto.randomUUID();

    for (let i = 0; i < retries; i++) {
      const { data: acquired, error } = await supabase.rpc('acquire_lock', {
        p_token: lockToken,
        p_locker: lockerId,
        p_ttl_seconds: 10,
      });

      if (error) {
        throw new Error(`Lock acquisition error for session ${token}: ${error.message}`);
      }

      if (acquired === true) {
        try {
          await operation();
        } finally {
          const { error: releaseError } = await supabase.rpc('release_lock', {
            p_token: lockToken,
            p_locker: lockerId,
          });
          if (releaseError) {
            // Non-fatal: the lock's 10s TTL guarantees eventual release.
            console.error(`[withLock] release failed for ${token}:`, releaseError.message);
          }
        }
        return;
      }

      await new Promise((r) => setTimeout(r, delay));
    }

    throw new Error(`Could not acquire lock for session ${token} after ${retries} attempts`);
  },
};
