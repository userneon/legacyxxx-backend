/**
 * Live kill feed for the top bar. Kills are never stored in the database: the last 50 live in memory,
 * de-duplicated by event id, and the website polls for anything newer than its cursor.
 */
import { z } from "zod";

export const KILLFEED_CAPACITY = 50;

export const killEventSchema = z.object({
  event_id: z.string().trim().min(8).max(160),
  server_id: z.string().trim().min(1).max(120),
  attacker_steam_id: z.string().regex(/^\d{15,20}$/).nullable().optional(),
  attacker_name: z.string().trim().min(1).max(64),
  victim_steam_id: z.string().regex(/^\d{15,20}$/).nullable().optional(),
  victim_name: z.string().trim().min(1).max(64),
  weapon: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_ -]+$/),
  headshot: z.boolean().default(false),
  timestamp: z.string().datetime({ offset: true }),
}).strict();
export type KillEvent = z.infer<typeof killEventSchema>;

export interface KillFeedEntry {
  cursor: number;
  eventId: string;
  serverId: string;
  attackerName: string;
  attackerSteamId: string | null;
  victimName: string;
  victimSteamId: string | null;
  weapon: string;
  headshot: boolean;
  at: string;
}

export class KillFeed {
  private entries: KillFeedEntry[] = [];
  private seen = new Set<string>();
  private nextCursor = 1;

  constructor(private readonly capacity = KILLFEED_CAPACITY) {}

  /** Returns false for an event id already in the buffer (plugin retries are harmless). */
  add(event: KillEvent): boolean {
    if (this.seen.has(event.event_id)) return false;
    const entry: KillFeedEntry = {
      cursor: this.nextCursor++,
      eventId: event.event_id,
      serverId: event.server_id,
      attackerName: event.attacker_name,
      attackerSteamId: event.attacker_steam_id ?? null,
      victimName: event.victim_name,
      victimSteamId: event.victim_steam_id ?? null,
      weapon: event.weapon.replace(/^weapon_/, ""),
      headshot: event.headshot,
      at: event.timestamp,
    };
    this.entries.push(entry);
    this.seen.add(entry.eventId);
    while (this.entries.length > this.capacity) {
      const dropped = this.entries.shift()!;
      this.seen.delete(dropped.eventId);
    }
    return true;
  }

  /** Entries newer than `after`, oldest first, plus the cursor to send next time. */
  since(after = 0): { entries: KillFeedEntry[]; cursor: number } {
    const entries = this.entries.filter(entry => entry.cursor > after);
    return { entries, cursor: this.entries.at(-1)?.cursor ?? after };
  }
}

export const killFeed = new KillFeed();
