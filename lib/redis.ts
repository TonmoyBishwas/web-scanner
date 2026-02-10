import { Redis } from '@upstash/redis';

/**
 * Upstash Redis client for session storage
 */

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (redisClient) {
    return redisClient;
  }

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error('Missing Redis configuration. Please set KV_REST_API_URL and KV_REST_API_TOKEN.');
  }

  redisClient = new Redis({
    url,
    token,
  });

  return redisClient;
}

/**
 * Session storage utilities
 */
export const sessionStorage = {
  async get(token: string): Promise<any> {
    const redis = getRedisClient();
    const data = await redis.get(`session:${token}`);
    return data;
  },

  async set(token: string, data: any, options?: { ex?: number }): Promise<void> {
    const redis = getRedisClient();
    const key = `session:${token}`;
    if (options?.ex) {
      await redis.setex(key, options.ex, JSON.stringify(data));
    } else {
      await redis.set(key, JSON.stringify(data));
    }
  },

  async delete(token: string): Promise<void> {
    const redis = getRedisClient();
    await redis.del(`session:${token}`);
  },

  async exists(token: string): Promise<boolean> {
    const redis = getRedisClient();
    const result = await redis.exists(`session:${token}`);
    return result === 1;
  },

  /**
   * Execute an operation with an exclusive lock on the session.
   * Prevents race conditions between concurrent requests (e.g. scan vs ocr).
   */
  async withLock(token: string, operation: () => Promise<void>, retries = 20, delay = 250): Promise<void> {
    const redis = getRedisClient();
    const lockKey = `lock:${token}`;
    const lockerId = Math.random().toString(36).substring(7);

    for (let i = 0; i < retries; i++) {
      // SET NX EX 10 (10 second lock auto-expiry)
      const acquired = await redis.set(lockKey, lockerId, { nx: true, ex: 10 });

      if (acquired === 'OK') {
        try {
          await operation();
        } finally {
          // Release lock safely
          const currentLock = await redis.get(lockKey);
          if (currentLock === lockerId) {
            await redis.del(lockKey);
          }
        }
        return;
      }

      // Wait before retry
      await new Promise(r => setTimeout(r, delay));
    }

    throw new Error(`Could not acquire lock for session ${token} after ${retries} attempts`);
  }
};
