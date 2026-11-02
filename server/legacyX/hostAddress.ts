import { promises as dns } from "node:dns";

/**
 * Steam's `steam://connect/<address>` is most reliable with a numeric address, so a server that reports a host name
 * (cs.legacyx.cc:27015) is handed to the website as its IPv4 address (owner report 2026-11-02: Connect did not work with the host name).
 * The answer is kept for five minutes; when the name cannot be looked up the reported address is returned unchanged.
 */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const ADDRESS = /^([a-zA-Z0-9.-]+):(\d{1,5})$/;
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { ip: string | null; until: number }>();

type Lookup = (host: string) => Promise<string>;
const systemLookup: Lookup = async (host) => (await dns.lookup(host, { family: 4 })).address;

export async function numericAddress(address: string | null, lookup: Lookup = systemLookup, now = Date.now()): Promise<string | null> {
  const match = address ? ADDRESS.exec(address.trim()) : null;
  if (!address || !match || IPV4.test(match[1])) return address;
  const host = match[1].toLowerCase();
  const hit = cache.get(host);
  let ip: string | null;
  if (hit && hit.until > now) ip = hit.ip;
  else {
    ip = await Promise.race([lookup(host), new Promise<string>((_, reject) => setTimeout(() => reject(new Error("lookup timed out")), 2000))]).catch(() => null);
    cache.set(host, { ip, until: now + (ip ? TTL_MS : 30_000) });
  }
  return ip ? `${ip}:${match[2]}` : address;
}

export const clearHostAddressCacheForTests = () => cache.clear();
