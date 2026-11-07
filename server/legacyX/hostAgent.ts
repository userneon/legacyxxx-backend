import { execFile } from "node:child_process";
import { z } from "zod";

/**
 * The website's way to look at, and act on, the game host (owner request 2026-11-07).
 *
 * The API opens one SSH connection with a key whose authorized_keys line forces a single script
 * (legacyxxx-plugins/scripts/legacyx-host.sh, `restrict,command="…"`), so this key can run nothing else even if it leaks.
 * Only the three words below are ever sent, the port is a number checked here and again on the host, and ssh is started
 * with execFile (no shell). The key is a FILE named in the environment, never a value in a table or in the repo.
 */
/** `target` names what to act on (a game server's port, or api / bot / site / admin / nginx on the web VPS); the host script checks it again. */
export type NewServer = { port: number; gslt: string; mode: "competitive" | "wingman" | "casual" | "deathmatch"; map: string; maxPlayers: number; siteMode: string };
export type HostAction =
  | { action: "status" }
  | { action: "deploy"; target?: string }
  | { action: "restart"; target: string }
  | { action: "add"; server: NewServer }
  | { action: "remove"; target: string };

const targetSchema = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/);
export const hostActionSchema = z.discriminatedUnion("action", [
  z.object({ hostId: z.string().regex(/^[a-z0-9-]{1,24}$/), action: z.literal("deploy"), target: targetSchema.optional() }).strict(),
  z.object({ hostId: z.string().regex(/^[a-z0-9-]{1,24}$/), action: z.literal("restart"), target: targetSchema }).strict(),
  z.object({ hostId: z.string().regex(/^[a-z0-9-]{1,24}$/), action: z.literal("remove"), target: z.string().regex(/^\d{4,5}$/) }).strict(),
  // A new game server on a port (owner request 2026-11-07: "add a new port from the Host tab"). The GSLT is a secret: it goes to the host and nowhere else.
  z.object({
    hostId: z.string().regex(/^[a-z0-9-]{1,24}$/),
    action: z.literal("add"),
    server: z.object({
      port: z.number().int().min(1024).max(65535),
      gslt: z.string().regex(/^[A-Fa-f0-9]{32}$/),
      mode: z.enum(["competitive", "wingman", "casual", "deathmatch"]),
      map: z.string().regex(/^[a-z0-9_]{2,64}$/),
      maxPlayers: z.number().int().min(2).max(64),
      siteMode: z.string().regex(/^[a-z0-9_]{0,40}$/),
    }).strict(),
  }).strict(),
]);

export type HostConfig = { id: string; label: string; kind: "game" | "web"; host: string; user: string; port: number; keyFile: string; knownHosts: string | null };

function oneHost(raw: { id?: unknown; label?: unknown; kind?: unknown; host?: unknown; user?: unknown; port?: unknown; key?: unknown; knownHosts?: unknown }, env: NodeJS.ProcessEnv): HostConfig | null {
  const host = String(raw.host ?? "").trim();
  const keyFile = String(raw.key ?? env.HOST_SSH_KEY ?? "").trim();
  if (!host || !keyFile || !/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith("-")) return null;
  const user = String(raw.user ?? env.HOST_SSH_USER ?? "root").trim() || "root";
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) return null;
  const port = Number(raw.port ?? env.HOST_SSH_PORT ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const id = String(raw.id ?? "").trim();
  if (!/^[a-z0-9-]{1,24}$/.test(id)) return null;
  const kind = raw.kind === "web" ? "web" : "game";
  const knownHosts = String(raw.knownHosts ?? env.HOST_SSH_KNOWN_HOSTS ?? "").trim() || null;
  return { id, label: String(raw.label ?? "").trim().slice(0, 40) || (kind === "web" ? "Web" : id), kind, host, user, port, keyFile, knownHosts };
}

/**
 * The hosts the site manages. HOST_SSH_HOSTS is a JSON list, e.g.
 * [{"id":"web","kind":"web","label":"Web","host":"127.0.0.1"},{"id":"game1","kind":"game","label":"Game 1","host":"203.0.113.20"}]
 * (each may carry its own user, port, key, knownHosts; HOST_SSH_KEY / _USER / _PORT / _KNOWN_HOSTS are the shared defaults).
 * The older HOST_SSH_HOST alone is one game host. Empty while nothing is set up.
 */
export function hostConfigs(env: NodeJS.ProcessEnv = process.env): HostConfig[] {
  const list = env.HOST_SSH_HOSTS?.trim();
  let raws: Array<Record<string, unknown>> = [];
  if (list) {
    try { const parsed: unknown = JSON.parse(list); if (Array.isArray(parsed)) raws = parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").slice(0, 20); } catch { raws = []; }
  } else if (env.HOST_SSH_HOST?.trim()) {
    raws = [{ id: "game", kind: "game", label: "Game host", host: env.HOST_SSH_HOST }];
  }
  const seen = new Set<string>();
  return raws.map((raw) => oneHost(raw, env)).filter((config): config is HostConfig => config !== null && !seen.has(config.id) && Boolean(seen.add(config.id)));
}

/** The one word (and port) sent as the SSH command. */
export function hostCommand(action: HostAction) {
  if (action.action === "status") return "status";
  if (action.action === "add") {
    const { port, gslt, mode, map, maxPlayers, siteMode } = action.server;
    if (![port, maxPlayers].every(Number.isInteger) || !/^[A-Fa-f0-9]{32}$/.test(gslt) || !/^[a-z0-9_]{2,64}$/.test(map) || !/^[a-z0-9_]{0,40}$/.test(siteMode) || !["competitive", "wingman", "casual", "deathmatch"].includes(mode)) throw new Error("Bad server");
    return `add ${port} ${gslt} ${mode} ${map} ${maxPlayers}${siteMode ? ` ${siteMode}` : ""}`;
  }
  const target = action.target;
  if (target !== undefined && !/^[A-Za-z0-9_-]{1,24}$/.test(target)) throw new Error("Bad target");
  return target ? `${action.action} ${target}` : action.action;
}

export function sshArguments(config: HostConfig, command: string) {
  return [
    "-i", config.keyFile,
    "-p", String(config.port),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=10",
    "-o", config.knownHosts ? "StrictHostKeyChecking=yes" : "StrictHostKeyChecking=accept-new",
    ...(config.knownHosts ? ["-o", `UserKnownHostsFile=${config.knownHosts}`] : []),
    "-o", "ForwardAgent=no",
    `${config.user}@${config.host}`,
    "--",
    command,
  ];
}

export type HostRun = { ok: boolean; body: Record<string, unknown> | null; error: string | null };

export function runHost(config: HostConfig, action: HostAction, run: typeof execFile = execFile): Promise<HostRun> {
  const timeout = action.action === "status" ? 60_000 : action.action === "deploy" ? 10 * 60_000 : action.action === "add" ? 120_000 : 60_000;
  return new Promise((resolve) => {
    run("ssh", sshArguments(config, hostCommand(action)), { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const text = String(stdout ?? "").trim();
      let body: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = text ? JSON.parse(text) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = null;
      }
      if (body) return resolve({ ok: body.ok === true, body, error: body.ok === true ? null : String(body.error ?? body.log ?? "The host refused").slice(0, 500) });
      const reason = error ? (error.killed ? "The host did not answer in time" : "Could not reach the host over SSH") : "The host sent an answer the site could not read";
      // stderr is not sent on: it can name paths and users.
      void stderr;
      resolve({ ok: false, body: null, error: reason });
    });
  });
}
