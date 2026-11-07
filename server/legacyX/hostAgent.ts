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
export type HostAction = { action: "status" } | { action: "deploy" } | { action: "restart"; port: number };

export const hostActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("deploy") }).strict(),
  z.object({ action: z.literal("restart"), port: z.number().int().min(1024).max(65535) }).strict(),
]);

export type HostConfig = { host: string; user: string; port: number; keyFile: string; knownHosts: string | null };

/** Null while the host is not set up (the Host tab then says how to set it up). */
export function hostConfig(env: NodeJS.ProcessEnv = process.env): HostConfig | null {
  const host = env.HOST_SSH_HOST?.trim();
  const keyFile = env.HOST_SSH_KEY?.trim();
  if (!host || !keyFile) return null;
  if (!/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith("-")) return null;
  const user = env.HOST_SSH_USER?.trim() || "root";
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) return null;
  const port = Number(env.HOST_SSH_PORT?.trim() || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, user, port, keyFile, knownHosts: env.HOST_SSH_KNOWN_HOSTS?.trim() || null };
}

/** The one word (and port) sent as the SSH command. */
export function hostCommand(action: HostAction) {
  if (action.action === "restart") {
    if (!Number.isInteger(action.port) || action.port < 1024 || action.port > 65535) throw new Error("Bad port");
    return `restart ${action.port}`;
  }
  return action.action;
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
  const timeout = action.action === "status" ? 60_000 : action.action === "deploy" ? 10 * 60_000 : 60_000;
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
