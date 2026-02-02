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
  }
};
