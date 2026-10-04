import { z } from "zod";

/**
 * The Owner's profile page: links and a short message the Owner writes, plus the team and update lists built from
 * existing tables. Only https links are accepted, so a profile can never carry a javascript: or data: link.
 */

type Row = Record<string, any>;

export const OWNER_LINK_MAX = 8;

const httpsUrl = z.string().trim().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.includes(".") && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Links must be https addresses");

export const ownerProfileSchema = z.object({
  links: z.array(z.object({ url: httpsUrl, label: z.string().trim().min(1).max(32).optional() }).strict()).max(OWNER_LINK_MAX).optional(),
  message: z.string().trim().max(280).nullable().optional(),
}).strict().refine((value) => value.links !== undefined || value.message !== undefined, "Send links or a message");

/** Links as stored; anything that is not a plain https address is dropped on the way out too. */
export function ownerLinks(value: unknown): { url: string; label?: string }[] {
  if (!Array.isArray(value)) return [];
  const links: { url: string; label?: string }[] = [];
  for (const raw of value.slice(0, OWNER_LINK_MAX)) {
    const parsed = z.object({ url: httpsUrl, label: z.string().trim().min(1).max(32).optional() }).safeParse(raw);
    if (parsed.success) links.push(parsed.data);
  }
  return links;
}

/** Staff shown as the team: active members except the Owner, in rank order. */
const TEAM_ORDER = ["MANAGER", "ADMIN", "DEVELOPER", "DESIGNER"];
const TEAM_LABEL: Record<string, string> = { MANAGER: "Manager", ADMIN: "Admin", DEVELOPER: "Developer", DESIGNER: "Designer" };

export function ownerTeam(rows: Row[]) {
  return rows
    .filter((row) => TEAM_ORDER.includes(String(row.role)))
    .map((row) => {
      const user = (Array.isArray(row.users) ? row.users[0] : row.users) ?? {};
      const order = TEAM_ORDER.indexOf(String(row.role));
      return { order, member: { steamId: String(user.steam_id ?? ""), username: String(user.username ?? ""), avatar: String(user.avatar ?? ""), role: TEAM_LABEL[String(row.role)] } };
    })
    .filter(({ member }) => member.steamId && member.username)
    .sort((a, b) => a.order - b.order || a.member.username.localeCompare(b.member.username))
    .map(({ member }) => member);
}

export function ownerUpdates(rows: Row[]) {
  return rows.map((row) => ({ id: String(row.id), title: String(row.title ?? ""), at: String(row.created_at ?? "") })).filter((update) => update.title && update.at);
}

/** Postgres "undefined table" or PostgREST "not in schema cache": the migration has not been applied yet. */
export function isMissingTableError(error: unknown) {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "42P01" || code === "PGRST205";
}
