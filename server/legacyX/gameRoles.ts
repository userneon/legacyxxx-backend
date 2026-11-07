import { z } from "zod";

/**
 * In-game roles you can shape on the staff site (owner request 2026-11-02): which commands a role may run, on which kinds of server, and its
 * immunity. The Owner role is fixed (everything) and is not here. The list of commands is the one LegacyX-Admin registers
 * (plugins/LegacyX-Admin/AdminPlus.Stamina.cs, AddPermCmd); a command the plugin does not know can never be granted.
 * Commands that change the server itself or the permissions are `locked`: shown, never grantable.
 */
export const GAME_ROLES = ["creator", "main_creator", "staff", "admin", "manager", "perk"] as const;
export type GameRoleKey = (typeof GAME_ROLES)[number];
export const isGameRole = (value: string): value is GameRoleKey => (GAME_ROLES as readonly string[]).includes(value);

export const GAME_ROLE_LABELS: Record<GameRoleKey, string> = { creator: "Content Creator", main_creator: "Main Content Creator", staff: "Staff", admin: "Admin", manager: "Manager", perk: "Shop rank" };

/** The kinds of server a role may work on (the Play modes). An empty list means every kind. */
export const GAME_MODES = ["5x5", "pro", "fun"] as const;
export type GameMode = (typeof GAME_MODES)[number];

export type GameCommand = { name: string; flag: string; group: string; summary: string; locked: boolean; stamina?: number };

export const GAME_COMMANDS: GameCommand[] = [
  { name: "1up", flag: "@css/slay", group: "Fun", summary: "Respawn at last pos", locked: false, stamina: 1000 },
  { name: "addadmin", flag: "@css/root", group: "Server", summary: "Staff are managed on legacyx.cc", locked: true, stamina: 1000 },
  { name: "admin", flag: "@css/generic", group: "Basics and votes", summary: "Open admin menu from console", locked: false, stamina: 250 },
  { name: "admin_reload", flag: "@css/root", group: "Server", summary: "Re-check online staff with the LEGACY-X API", locked: true, stamina: 1000 },
  { name: "adminlist", flag: "@css/root", group: "Server", summary: "List authorized staff online", locked: true, stamina: 750 },
  { name: "adminmenu", flag: "@css/generic", group: "Basics and votes", summary: "Open admin menu from console", locked: false, stamina: 250 },
  { name: "adminreload", flag: "@css/root", group: "Server", summary: "Re-check online staff with the LEGACY-X API", locked: true, stamina: 1000 },
  { name: "aimlock", flag: "@css/root", group: "Server", summary: "View snaps to the nearest enemy while firing", locked: true },
  { name: "armor", flag: "@css/slay", group: "Fun", summary: "Set player armor", locked: false, stamina: 1000 },
  { name: "asay", flag: "@css/chat", group: "Chat and punishments", summary: "Admin say (console)", locked: false, stamina: 250 },
  { name: "ban", flag: "@css/ban", group: "Bans", summary: "Ban a player from console", locked: false, stamina: 500 },
  { name: "baninfo", flag: "@css/ban", group: "Bans", summary: "Show ban info", locked: false, stamina: 250 },
  { name: "banlist", flag: "@css/ban", group: "Bans", summary: "Show ban list menu from console", locked: false, stamina: 750 },
  { name: "beacon", flag: "@css/slay", group: "Fun", summary: "", locked: false, stamina: 1000 },
  { name: "bhop", flag: "@css/root", group: "Server", summary: "Hold jump to bunny hop", locked: true },
  { name: "blind", flag: "@css/slay", group: "Fun", summary: "", locked: false, stamina: 1000 },
  { name: "bring", flag: "@css/slay", group: "Fun", summary: "Bring", locked: false, stamina: 1000 },
  { name: "bury", flag: "@css/slay", group: "Fun", summary: "", locked: false, stamina: 1000 },
  { name: "cancelvote", flag: "@css/generic", group: "Basics and votes", summary: "Cancel vote from console", locked: false, stamina: 500 },
  { name: "cheats", flag: "@css/root", group: "Server", summary: "sv_cheats on or off", locked: true },
  { name: "clean", flag: "@css/slay", group: "Fun", summary: "- Clean weapons on the ground", locked: false, stamina: 1000 },
  { name: "cleanall", flag: "@css/root", group: "Server", summary: "Clean all punishments manually", locked: true, stamina: 1000 },
  { name: "cleanbans", flag: "@css/root", group: "Server", summary: "Clean all bans from console", locked: true, stamina: 1000 },
  { name: "cleangag", flag: "@css/root", group: "Server", summary: "Clean all gag punishments manually", locked: true, stamina: 1000 },
  { name: "cleanipbans", flag: "@css/root", group: "Server", summary: "Clean all IP bans from console", locked: true, stamina: 1000 },
  { name: "cleanmute", flag: "@css/root", group: "Server", summary: "Clean all mute punishments manually", locked: true, stamina: 1000 },
  { name: "cleansteambans", flag: "@css/root", group: "Server", summary: "Clean all SteamID bans from console", locked: true, stamina: 1000 },
  { name: "color", flag: "@css/slay", group: "Fun", summary: "", locked: false, stamina: 1000 },
  { name: "csay", flag: "@css/chat", group: "Chat and punishments", summary: "Center say (console)", locked: false, stamina: 500 },
  { name: "cvar", flag: "@css/cvar", group: "Server", summary: "Get/Set cvar value from console", locked: true, stamina: 1000 },
  { name: "drug", flag: "@css/slay", group: "Fun", summary: "", locked: false, stamina: 1000 },
  { name: "freeze", flag: "@css/slay", group: "Fun", summary: "", locked: false, stamina: 1000 },
  { name: "gag", flag: "@css/chat", group: "Chat and punishments", summary: "Gag a player from console", locked: false, stamina: 250 },
  { name: "gaglist", flag: "@css/chat", group: "Chat and punishments", summary: "List gagged players from console", locked: false, stamina: 250 },
  { name: "glow", flag: "@css/slay", group: "Fun", summary: "", locked: false, stamina: 1000 },
  { name: "god", flag: "@css/cheats", group: "Cheats", summary: "", locked: false, stamina: 1000 },
  { name: "goto", flag: "@css/slay", group: "Fun", summary: "Teleport to player", locked: false, stamina: 1000 },
  { name: "gravity", flag: "@css/slay", group: "Fun", summary: "", locked: false, stamina: 1000 },
  { name: "hideadmin", flag: "@css/generic", group: "Basics and votes", summary: "Toggle hiding all admins from !admins list", locked: false, stamina: 500 },
  { name: "hp", flag: "@css/cheats", group: "Cheats", summary: "", locked: false, stamina: 1000 },
  { name: "hrespawn", flag: "@css/slay", group: "Fun", summary: "Respawn at last pos", locked: false, stamina: 1000 },
  { name: "hsay", flag: "@css/chat", group: "Chat and punishments", summary: "HUD say (console)", locked: false, stamina: 500 },
  { name: "ipban", flag: "@css/ban", group: "Bans", summary: "IP ban a player from console", locked: false, stamina: 750 },
  { name: "kick", flag: "@css/generic", group: "Basics and votes", summary: "Kick a player from console", locked: false, stamina: 500 },
  { name: "lastban", flag: "@css/ban", group: "Bans", summary: "Show last disconnected players", locked: false, stamina: 500 },
  { name: "launch", flag: "@css/slay", group: "Fun", summary: "", locked: false },
  { name: "map", flag: "@css/generic", group: "Basics and votes", summary: "", locked: false, stamina: 750 },
  { name: "money", flag: "@css/slay", group: "Fun", summary: "Set player money", locked: false, stamina: 1000 },
  { name: "mute", flag: "@css/chat", group: "Chat and punishments", summary: "Mute a player from console", locked: false, stamina: 250 },
  { name: "mutelist", flag: "@css/chat", group: "Chat and punishments", summary: "List muted players from console", locked: false, stamina: 250 },
  { name: "noclip", flag: "@css/cheats", group: "Cheats", summary: "", locked: false, stamina: 1000 },
  { name: "psay", flag: "@css/chat", group: "Chat and punishments", summary: "Private say (console)", locked: false, stamina: 250 },
  { name: "rcon", flag: "@css/rcon", group: "Server", summary: "Send RCON command from console", locked: true, stamina: 1000 },
  { name: "removeadmin", flag: "@css/root", group: "Server", summary: "Staff are managed on legacyx.cc", locked: true, stamina: 1000 },
  { name: "rename", flag: "@css/slay", group: "Fun", summary: "Rename a player", locked: false, stamina: 750 },
  { name: "respawn", flag: "@css/cheats", group: "Cheats", summary: "", locked: false, stamina: 1000 },
  { name: "revive", flag: "@css/cheats", group: "Cheats", summary: "", locked: false, stamina: 1000 },
  { name: "rr", flag: "@css/generic", group: "Basics and votes", summary: "Send the server back to warmup", locked: false, stamina: 500 },
  { name: "sethp", flag: "@css/cheats", group: "Cheats", summary: "", locked: false, stamina: 1000 },
  { name: "shake", flag: "@css/slay", group: "Fun", summary: "", locked: false, stamina: 1000 },
  { name: "silence", flag: "@css/chat", group: "Chat and punishments", summary: "Mute+Gag a player from console", locked: false, stamina: 250 },
  { name: "blink", flag: "@css/slay", group: "Fun", summary: "Move a player forward", locked: false, stamina: 1000 },
  { name: "bounce", flag: "@css/slay", group: "Fun", summary: "Make a player spring, again to stop", locked: false, stamina: 1000 },
  { name: "burn", flag: "@css/slay", group: "Fun", summary: "Fire damage on a player, again to put out", locked: false, stamina: 1000 },
  { name: "drop", flag: "@css/slay", group: "Fun", summary: "Make a player drop their weapon", locked: false, stamina: 1000 },
  { name: "jetpack", flag: "@css/slay", group: "Fun", summary: "Hold jump to fly, again to stop", locked: false, stamina: 1000 },
  { name: "doublejump", flag: "@css/slay", group: "Fun", summary: "A second jump in the air, again to stop", locked: false, stamina: 1000 },
  { name: "sky", flag: "@css/slay", group: "Fun", summary: "Send a player up into the sky", locked: false, stamina: 1000 },
  { name: "pull", flag: "@css/slay", group: "Fun", summary: "Pull a player towards you", locked: false, stamina: 1000 },
  { name: "shockwave", flag: "@css/slay", group: "Fun", summary: "Throw everyone near a player away", locked: false, stamina: 1000 },
  { name: "explode", flag: "@css/slay", group: "Fun", summary: "Blow a player up and hurt those near", locked: false, stamina: 1000 },
  { name: "vampire", flag: "@css/slay", group: "Fun", summary: "Heal on every kill, again to stop", locked: false, stamina: 1000 },
  { name: "infammo", flag: "@css/slay", group: "Fun", summary: "Endless magazine, again to stop", locked: false, stamina: 1000 },
  { name: "gift", flag: "@css/slay", group: "Fun", summary: "Give a player a random weapon", locked: false, stamina: 1000 },
  { name: "fov", flag: "@css/slay", group: "Fun", summary: "Wide or narrow view for a player", locked: false, stamina: 1000 },
  { name: "ghost", flag: "@css/slay", group: "Fun", summary: "See-through player, again to restore", locked: false, stamina: 1000 },
  { name: "chicken", flag: "@css/slay", group: "Fun", summary: "Turn a player into a chicken until respawn", locked: false, stamina: 1000 },
  { name: "pop", flag: "@css/slay", group: "Fun", summary: "Burst of the addon's effect and a jump", locked: false, stamina: 1000 },
  { name: "aura", flag: "@css/slay", group: "Fun", summary: "Trail of the addon's effects behind a player", locked: false, stamina: 1000 },
  { name: "roulette", flag: "@css/slay", group: "Fun", summary: "A random player gets a random effect", locked: false, stamina: 1000 },
  { name: "chaos", flag: "@css/slay", group: "Fun", summary: "Roulette every few seconds, again to stop", locked: false, stamina: 1000 },
  { name: "fakeban", flag: "@css/slay", group: "Fun", summary: "Joke card: fake ban on a player's HUD", locked: false, stamina: 1000 },
  { name: "fakevac", flag: "@css/slay", group: "Fun", summary: "Joke card: fake VAC error on a player's HUD", locked: false, stamina: 1000 },
  { name: "fakecrash", flag: "@css/slay", group: "Fun", summary: "Joke card: fake game crash on a player's HUD", locked: false, stamina: 1000 },
  { name: "fakehack", flag: "@css/slay", group: "Fun", summary: "Joke card: fake cheat check on a player's HUD", locked: false, stamina: 1000 },
  { name: "scare", flag: "@css/slay", group: "Fun", summary: "Full-screen jump scare on a player's HUD", locked: false, stamina: 1000 },
  { name: "banner", flag: "@css/slay", group: "Fun", summary: "Show a short message on a player's HUD", locked: false, stamina: 1000 },
  { name: "fling", flag: "@css/slay", group: "Fun", summary: "Throw a player the way you look", locked: false, stamina: 1000 },
  { name: "lowgrav", flag: "@css/slay", group: "Fun", summary: "Slow fall for one player, again to restore", locked: false, stamina: 1000 },
  { name: "tprandom", flag: "@css/slay", group: "Fun", summary: "Send a player to a random player", locked: false, stamina: 1000 },
  { name: "invisible", flag: "@css/slay", group: "Fun", summary: "Hide or show a player", locked: false, stamina: 1000 },
  { name: "rainbow", flag: "@css/slay", group: "Fun", summary: "Colour cycle on a player, again to stop", locked: false, stamina: 1000 },
  { name: "rocket", flag: "@css/slay", group: "Fun", summary: "Send a player up, then blow up", locked: false, stamina: 1000 },
  { name: "size", flag: "@css/slay", group: "Fun", summary: "", locked: false },
  { name: "slap", flag: "@css/slay", group: "Fun", summary: "Slap a player", locked: false, stamina: 500 },
  { name: "slay", flag: "@css/slay", group: "Fun", summary: "Slay a player", locked: false, stamina: 750 },
  { name: "spin", flag: "@css/slay", group: "Fun", summary: "Spin a player round, again to stop", locked: false, stamina: 1000 },
  { name: "speed", flag: "@css/cheats", group: "Cheats", summary: "", locked: false, stamina: 1000 },
  { name: "strip", flag: "@css/cheats", group: "Cheats", summary: "", locked: false, stamina: 1000 },
  { name: "swap", flag: "@css/kick", group: "Teams", summary: "", locked: false, stamina: 750 },
  { name: "team", flag: "@css/kick", group: "Teams", summary: "", locked: false, stamina: 750 },
  { name: "unban", flag: "@css/unban", group: "Bans", summary: "Unban a player from console", locked: false, stamina: 750 },
  { name: "ungag", flag: "@css/chat", group: "Chat and punishments", summary: "Ungag a player from console", locked: false, stamina: 250 },
  { name: "unmute", flag: "@css/chat", group: "Chat and punishments", summary: "Unmute a player from console", locked: false, stamina: 250 },
  { name: "unsilence", flag: "@css/chat", group: "Chat and punishments", summary: "Remove mute+gag from a player (console)", locked: false, stamina: 250 },
  { name: "vote", flag: "@css/generic", group: "Basics and votes", summary: "Create a vote from console", locked: false, stamina: 250 },
  { name: "voteban", flag: "@css/generic", group: "Basics and votes", summary: "Create a ban vote from console", locked: false, stamina: 500 },
  { name: "votegag", flag: "@css/generic", group: "Basics and votes", summary: "Create a gag vote from console", locked: false, stamina: 250 },
  { name: "votekick", flag: "@css/generic", group: "Basics and votes", summary: "Create a kick vote from console", locked: false, stamina: 250 },
  { name: "votemap", flag: "@css/generic", group: "Basics and votes", summary: "Create a map vote from console", locked: false, stamina: 250 },
  { name: "votemute", flag: "@css/generic", group: "Basics and votes", summary: "Create a mute vote from console", locked: false, stamina: 250 },
  { name: "votesilence", flag: "@css/generic", group: "Basics and votes", summary: "Create a silence vote from console", locked: false, stamina: 500 },
  { name: "weapon", flag: "@css/cheats", group: "Cheats", summary: "", locked: false, stamina: 1000 },
  { name: "wh", flag: "@css/root", group: "Server", summary: "See enemies through walls", locked: true },
  { name: "who", flag: "@css/generic", group: "Basics and votes", summary: "Show player info from console", locked: false, stamina: 250 },
  { name: "workshop", flag: "@css/generic", group: "Basics and votes", summary: "Change workshop map from console", locked: false, stamina: 750 },
  { name: "wsmap", flag: "@css/generic", group: "Basics and votes", summary: "Change workshop map from console", locked: false, stamina: 750 },
];

const COMMAND_NAMES = new Set(GAME_COMMANDS.map((command) => command.name));
const GRANTABLE = new Set(GAME_COMMANDS.filter((command) => !command.locked).map((command) => command.name));
const FLAG_OF = new Map(GAME_COMMANDS.map((command) => [command.name, command.flag]));

/** Permissions other plugins read (MatchZy and the match start), which are not commands of the admin plugin. */
export const EXTRA_FLAGS = [
  { flag: "@css/changemap", label: "Change the map from other plugins" },
  { flag: "@css/config", label: "MatchZy admin commands" },
  { flag: "@legacyx/match", label: "Force-start a match" },
] as const;
const EXTRA_FLAG_NAMES = new Set<string>(EXTRA_FLAGS.map((entry) => entry.flag));

/** A limit on one command for a role: seconds to wait between two uses (0 = none) and uses per map (0 = no cap). */
export type CommandLimit = { cooldown: number; perMap: number };
export type GameRoleConfig = { commands: string[]; extraFlags: string[]; modes: GameMode[]; immunity: number; limits: Record<string, CommandLimit> };

/**
 * Commands that used to have an "un" twin (owner request 2026-11-06): the one command now switches the effect on and off, so the twin is no
 * longer a separate entry. A role saved while the twins existed keeps working: a twin in its list becomes the command it undid.
 */
export const RETIRED_COMMANDS: Record<string, string> = { unblind: "blind", unbury: "bury", undrug: "drug", unfreeze: "freeze", unshake: "shake", unsize: "size", unspeed: "speed" };
function migrateRole(value: unknown): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as { commands?: unknown }).commands)) return value;
  const commands = (value as { commands: unknown[] }).commands.map((name) => (typeof name === "string" && RETIRED_COMMANDS[name]) || name);
  return { ...(value as object), commands };
}

/** What each role gets until it is edited: the same as the plugin's built-in roles (kept in step with StaffPermissions.cs). */
const BUILT_IN: Record<GameRoleKey, { flags: string[]; stamina: number; extraFlags: string[]; modes: GameMode[]; immunity: number; without?: string[] }> = {
  creator: { flags: ["@css/slay", "@css/cheats"], stamina: 1000, extraFlags: [], modes: ["fun"], immunity: 100, without: ["rename"] },
  main_creator: { flags: ["@css/slay", "@css/cheats"], stamina: 1000, extraFlags: [], modes: ["fun"], immunity: 200, without: ["rename"] },
  staff: { flags: ["@css/generic", "@css/chat", "@css/vote"], stamina: 250, extraFlags: [], modes: [], immunity: 250 },
  admin: { flags: ["@css/generic", "@css/kick", "@css/ban", "@css/slay", "@css/chat", "@css/vote"], stamina: 500, extraFlags: ["@css/changemap", "@legacyx/match"], modes: [], immunity: 500 },
  manager: { flags: ["@css/generic", "@css/kick", "@css/ban", "@css/unban", "@css/slay", "@css/chat", "@css/vote"], stamina: 750, extraFlags: ["@css/changemap", "@css/config", "@legacyx/match"], modes: [], immunity: 750 },
  // The ranks sold in the Shop (perks.ts): no commands of their own, the buyer picks them; fun servers only until the Owner widens it here.
  perk: { flags: [], stamina: 1000, extraFlags: [], modes: ["fun"], immunity: 50 },
};

export function defaultGameRole(role: GameRoleKey): GameRoleConfig {
  const base = BUILT_IN[role];
  const commands = GAME_COMMANDS
    .filter((command) => !command.locked && base.flags.includes(command.flag) && (command.stamina ?? 0) <= base.stamina && !(base.without ?? []).includes(command.name))
    .map((command) => command.name);
  return { commands, extraFlags: [...base.extraFlags], modes: [...base.modes], immunity: base.immunity, limits: {} };
}

/** What an Owner may save. Unknown or locked commands, unknown flags and modes are refused, not dropped. */
export const gameRoleConfigSchema = z.preprocess(migrateRole, z.object({
  commands: z.array(z.string()).max(200).refine((list) => list.every((name) => GRANTABLE.has(name)), "A command is unknown or cannot be granted"),
  extraFlags: z.array(z.string()).max(10).refine((list) => list.every((flag) => EXTRA_FLAG_NAMES.has(flag)), "A permission is unknown"),
  modes: z.array(z.enum(GAME_MODES)).max(3),
  immunity: z.number().int().min(0).max(900),
  limits: z.record(z.string(), z.object({ cooldown: z.number().int().min(0).max(3600), perMap: z.number().int().min(0).max(999) }).strict()).default({}).refine((limits) => Object.keys(limits).every((name) => GRANTABLE.has(name)), "A limit is on an unknown command"),
}).strict().transform((value) => {
  const commands = Array.from(new Set(value.commands)).sort();
  // A limit counts only on a command the role has, and one with nothing set is no limit.
  const limits = Object.fromEntries(Object.entries(value.limits).filter(([name, limit]) => commands.includes(name) && (limit.cooldown > 0 || limit.perMap > 0)).sort(([a], [b]) => a.localeCompare(b)));
  return { ...value, commands, extraFlags: Array.from(new Set(value.extraFlags)).sort(), modes: Array.from(new Set(value.modes)) as GameMode[], limits };
}));

/** A role as stored, or null when it does not fit the rules (then the built-in role applies). */
export function parseGameRole(value: unknown): GameRoleConfig | null {
  const parsed = gameRoleConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A stored row read back: anything that no longer fits the rules is ignored, so a bad row falls back to the built-in role. */
export function readGameRole(role: GameRoleKey, value: unknown): GameRoleConfig {
  const parsed = gameRoleConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultGameRole(role);
}

/**
 * One player holding two game roles at once (a Content Creator who is also staff, a paid rank on top of either; owner request 2026-11-07):
 * they get everything both give. Commands, extra flags and limits come together; the immunity is the higher one. A command both roles give is
 * limited only if both limit it, and then by the looser of the two limits.
 */
export function mergeGameRoles(a: GameRoleConfig, b: GameRoleConfig): GameRoleConfig {
  const commands = Array.from(new Set([...a.commands, ...b.commands])).sort();
  const limits: Record<string, CommandLimit> = {};
  for (const name of commands) {
    const inA = a.commands.includes(name), inB = b.commands.includes(name);
    const la = a.limits[name], lb = b.limits[name];
    if (inA && inB) {
      if (!la || !lb) continue; // one of them gives it without a limit
      limits[name] = { cooldown: Math.min(la.cooldown, lb.cooldown), perMap: la.perMap === 0 || lb.perMap === 0 ? 0 : Math.max(la.perMap, lb.perMap) };
    } else if (inA ? la : lb) limits[name] = (inA ? la : lb) as CommandLimit;
  }
  return { commands, extraFlags: Array.from(new Set([...a.extraFlags, ...b.extraFlags])).sort(), modes: Array.from(new Set([...a.modes, ...b.modes])) as GameRoleConfig["modes"], immunity: Math.max(a.immunity, b.immunity), limits };
}

/** The CounterStrikeSharp flags a set of commands needs, plus the extra ones: what the plugin adds to the player. */
export function flagsFor(config: GameRoleConfig): string[] {
  const flags = new Set<string>(config.extraFlags);
  for (const name of config.commands) { const flag = FLAG_OF.get(name); if (flag) flags.add(flag); }
  return Array.from(flags).sort();
}

export const isKnownGameCommand = (name: string) => COMMAND_NAMES.has(name);
