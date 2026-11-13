import { GAME_COMMANDS } from "./gameRoles";

/**
 * Paid in-game ranks (owner request 2026-11-07): tiers sold in the Shop for 14, 30 or 90 days (three at first, five since 2026-11-13), paid straight through Wire (QPay and the bank apps).
 * A tier gives a few commands the buyer picks from a pool of harmless ones: 1, 3, 5, 10 or 15. Names and prices live in `perk_tiers` (the Owner decides them,
 * a tier is not for sale until it is enabled and has a price). The picks live on the player's grant (`perk_grants`).
 *
 * Picking: nothing has to be picked at once (closing the window leaves the picks open); the picks can be changed while they are not full; once all of the
 * tier's commands are picked they are locked until the rank is renewed, and a renewal opens them again.
 */
// tier1 Prestige, tier2 Imperial, tier3 Eternal (2026-11-07); tier4 Prime (below Prestige) and tier5 Sovereign (above Eternal) were added 2026-11-13. `perk_tiers.sort` orders them in the Shop.
export const PERK_TIER_KEYS = ["tier1", "tier2", "tier3", "tier4", "tier5"] as const;
export type PerkTier = (typeof PERK_TIER_KEYS)[number];
export const PERK_DAYS = [14, 30, 90] as const;
export type PerkDays = (typeof PERK_DAYS)[number];
export const PERK_QUOTAS: Record<PerkTier, number> = { tier1: 3, tier2: 5, tier3: 10, tier4: 1, tier5: 15 };
export const isPerkTier = (value: unknown): value is PerkTier => typeof value === "string" && (PERK_TIER_KEYS as readonly string[]).includes(value);
export const isPerkDays = (value: unknown): value is PerkDays => typeof value === "number" && (PERK_DAYS as readonly number[]).includes(value);

/** What may be picked: the fun and cheat commands. Nothing that punishes (ban, kick, mute, gag), runs a vote or the server, or opens the admin menu. */
const POOL_GROUPS = new Set(["Fun", "Cheats"]);
/** Fun or cheat commands that still do not belong to a buyer: they change the whole server (gravity, clean), a player's name (rename) or take what others hold (strip). Staff only (owner request 2026-11-07). */
export const PERK_BLOCKED = new Set(["gravity", "rename", "clean", "strip"]);
/**
 * Limits every paid rank carries on the commands that can spoil a match when they are used again and again (seconds between two uses, uses per map).
 * They hold whether or not the Owner saved the rank's role; a limit the Owner sets on a command wins.
 */
export const PERK_DEFAULT_LIMITS: Record<string, { cooldown: number; perMap: number }> = {
  explode: { cooldown: 30, perMap: 5 }, rocket: { cooldown: 30, perMap: 5 }, shockwave: { cooldown: 30, perMap: 5 }, chaos: { cooldown: 60, perMap: 2 },
  roulette: { cooldown: 20, perMap: 6 }, scare: { cooldown: 60, perMap: 3 }, fakeban: { cooldown: 60, perMap: 3 }, fakevac: { cooldown: 60, perMap: 3 },
  fakecrash: { cooldown: 60, perMap: 3 }, fakehack: { cooldown: 60, perMap: 3 }, launch: { cooldown: 10, perMap: 10 }, sky: { cooldown: 15, perMap: 8 }, fling: { cooldown: 10, perMap: 10 },
};
const POOL = GAME_COMMANDS.filter((command) => !command.locked && POOL_GROUPS.has(command.group) && !PERK_BLOCKED.has(command.name));
const POOL_NAMES = new Set(POOL.map((command) => command.name));
export const perkPool = () => POOL.map(({ name, group, summary }) => ({ name, group, summary }));

export function perkCommandsProblem(quota: number, commands: string[]): string | null {
  if (new Set(commands).size !== commands.length) return "A command is listed twice";
  const unknown = commands.find((name) => !POOL_NAMES.has(name));
  if (unknown) return `${unknown} cannot be picked`;
  if (commands.length > quota) return `This rank has ${quota} commands at most`;
  return null;
}

export type PerkGrant = { tier: PerkTier; endsAt: string; commands: string[]; locked: boolean };

export const perkActive = (grant: { endsAt: string } | null | undefined, now = new Date()) => Boolean(grant) && Date.parse(grant!.endsAt) > now.getTime();

/** Why a purchase is refused for this player (null = fine): one rank at a time, so another tier waits until the current one ends. */
export function perkCheckoutProblem(current: PerkGrant | null, tier: PerkTier, now = new Date()): string | null {
  if (current && perkActive(current, now) && current.tier !== tier) return "You already have another rank running. Renew that one, or wait until it ends.";
  return null;
}

/** The grant after a paid purchase: a new one (nothing picked), or the running one extended and opened for new picks. */
export function grantAfterPurchase(current: PerkGrant | null, tier: PerkTier, days: number, now = new Date()): PerkGrant {
  const running = current && perkActive(current, now) && current.tier === tier ? current : null;
  const from = running ? Date.parse(running.endsAt) : now.getTime();
  return { tier, endsAt: new Date(from + days * 86_400_000).toISOString(), commands: running ? running.commands.slice(0, PERK_QUOTAS[tier]) : [], locked: false };
}

/** Saving the picks: refused while locked; locked once they are all picked. */
export function savePicks(grant: PerkGrant, commands: string[], now = new Date()): { grant: PerkGrant } | { error: string; status: number } {
  if (!perkActive(grant, now)) return { error: "Your rank is not running", status: 409 };
  if (grant.locked) return { error: "Your commands are locked until you renew the rank", status: 409 };
  const quota = PERK_QUOTAS[grant.tier];
  const problem = perkCommandsProblem(quota, commands);
  if (problem) return { error: problem, status: 400 };
  return { grant: { ...grant, commands, locked: commands.length === quota } };
}

/** What the game server is given beyond the role's own commands: the picks, still valid and within the tier's number, while the rank runs. */
export function effectivePerkCommands(grant: { tier: unknown; endsAt: string; commands: unknown } | null | undefined, now = new Date()): string[] {
  if (!grant || !isPerkTier(grant.tier) || !perkActive(grant, now) || !Array.isArray(grant.commands)) return [];
  return Array.from(new Set(grant.commands.filter((name): name is string => typeof name === "string" && POOL_NAMES.has(name)))).slice(0, PERK_QUOTAS[grant.tier]);
}
