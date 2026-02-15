const QUEUE_KEY = 'scanner-offline-queue';

export interface QueuedScan {
  token: string;
  barcode: string;
  parsed_data: any;
  image_url: string;
  image_public_id: string;
  detected_at: string;
  scan_method: string;
}

export function queueScan(data: QueuedScan) {
  try {
    const queue = getQueue();
    queue.push(data);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {}
}

export function getQueue(): QueuedScan[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

export function clearQueue() {
  try {
    localStorage.removeItem(QUEUE_KEY);
  } catch {}
}

export async function replayQueue(token: string): Promise<{ synced: number; failed: number }> {
  const queue = getQueue();
  if (queue.length === 0) return { synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;

  for (const item of queue) {
    if (item.token !== token) continue;
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      const result = await res.json();
      if (result.success || result.is_duplicate) {
        synced++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  // Remove synced items for this token
  const remaining = queue.filter(q => q.token !== token);
  if (remaining.length > 0) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  } else {
    clearQueue();
  }

  return { synced, failed };
}
