/**
 * A short memory for the public pages that every visitor loads and that cost several database calls (the ladder, the clan ranking, the
 * server list). Within the time to live everyone gets the same answer; callers that arrive while one is being built wait for it instead
 * of starting their own. A failed rebuild gives the last good answer (up to five minutes old) rather than an error page.
 */
type Entry<T> = { at: number; value?: T; pending?: Promise<T> };

const entries = new Map<string, Entry<unknown>>();
const STALE_OK_MS = 5 * 60_000;

export async function cachedFor<T>(key: string, ttlMs: number, load: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const entry = entries.get(key) as Entry<T> | undefined;
  if (entry?.value !== undefined && now() - entry.at < ttlMs) return entry.value;
  if (entry?.pending) return entry.pending;
  const pending = load().then(
    (value) => {
      entries.set(key, { at: now(), value });
      return value;
    },
    (error) => {
      if (entry?.value !== undefined && now() - entry.at < STALE_OK_MS) {
        entries.set(key, { at: entry.at, value: entry.value });
        return entry.value;
      }
      entries.delete(key);
      throw error;
    },
  );
  entries.set(key, { at: entry?.at ?? 0, value: entry?.value, pending });
  return pending;
}

/** Drop one kept answer so the next caller rebuilds it. */
export function forgetCached(key: string) {
  entries.delete(key);
}

export function clearResponseCache() {
  entries.clear();
}
