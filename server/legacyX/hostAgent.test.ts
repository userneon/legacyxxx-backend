import { describe, expect, it } from "vitest";
import { hostActionSchema, hostCommand, hostConfigs, runHost, sshArguments } from "./hostAgent";

const base = { HOST_SSH_HOST: "203.0.113.10", HOST_SSH_KEY: "/etc/legacyx/host_key" };
const call = (reply: [unknown, string, string]) => ((_c: string, _a: string[], _o: unknown, cb: Function) => cb(...reply)) as never;

describe("host agent", () => {
  it("is off until a host and a key file are set", () => {
    expect(hostConfigs({})).toEqual([]);
    expect(hostConfigs({ HOST_SSH_HOST: "a.example" })).toEqual([]);
    expect(hostConfigs(base)).toMatchObject([{ id: "game", kind: "game", host: "203.0.113.10", user: "root", port: 22, knownHosts: null }]);
  });
  it("reads a list of hosts that share the default key", () => {
    const list = JSON.stringify([{ id: "web", kind: "web", label: "Web", host: "127.0.0.1" }, { id: "game1", host: "203.0.113.20", port: 2222 }, { id: "web", host: "x.example" }]);
    const hosts = hostConfigs({ HOST_SSH_KEY: "/k", HOST_SSH_HOSTS: list });
    expect(hosts.map((h) => [h.id, h.kind, h.port])).toEqual([["web", "web", 22], ["game1", "game", 2222]]);
    expect(hostConfigs({ HOST_SSH_KEY: "/k", HOST_SSH_HOSTS: "not json" })).toEqual([]);
  });
  it("refuses a host or user that could be read as an ssh option", () => {
    expect(hostConfigs({ ...base, HOST_SSH_HOST: "-oProxyCommand=x" })).toEqual([]);
    expect(hostConfigs({ ...base, HOST_SSH_USER: "root;id" })).toEqual([]);
    expect(hostConfigs({ ...base, HOST_SSH_PORT: "99999" })).toEqual([]);
  });
  it("sends only a whitelisted word and a plain target", () => {
    expect(hostCommand({ action: "status" })).toBe("status");
    expect(hostCommand({ action: "deploy" })).toBe("deploy");
    expect(hostCommand({ action: "deploy", target: "api" })).toBe("deploy api");
    expect(hostCommand({ action: "restart", target: "27015" })).toBe("restart 27015");
    expect(() => hostCommand({ action: "restart", target: "27015; id" })).toThrow();
    expect(hostActionSchema.safeParse({ hostId: "web", action: "restart", target: "api; id" }).success).toBe(false);
    expect(hostActionSchema.safeParse({ hostId: "web", action: "rm" }).success).toBe(false);
    expect(hostActionSchema.safeParse({ hostId: "web", action: "deploy", extra: 1 }).success).toBe(false);
    expect(hostActionSchema.safeParse({ hostId: "web", action: "restart" }).success).toBe(false);
  });
  it("puts the command after -- and checks the host key when a known_hosts file is given", () => {
    const [config] = hostConfigs({ ...base, HOST_SSH_KNOWN_HOSTS: "/etc/legacyx/known_hosts" });
    const args = sshArguments(config, "status");
    expect(args.slice(-3)).toEqual(["root@203.0.113.10", "--", "status"]);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("BatchMode=yes");
  });
  it("reads the host's JSON and hides ssh's own error text", async () => {
    const [config] = hostConfigs(base);
    expect((await runHost(config, { action: "status" }, call([null, '{"ok":true,"checks":[]}', ""]))).ok).toBe(true);
    expect(await runHost(config, { action: "deploy" }, call([null, '{"ok":false,"error":"another action is running"}', ""]))).toMatchObject({ ok: false, error: "another action is running" });
    expect(await runHost(config, { action: "status" }, call([new Error("x"), "", "Permission denied (publickey) /root/.ssh"]))).toMatchObject({ ok: false, error: "Could not reach the host over SSH" });
  });
  it("builds the add and remove commands from checked words only", () => {
    const server = { port: 27020, gslt: "0123456789abcdef0123456789abcdef", mode: "competitive" as const, map: "de_mirage", maxPlayers: 10, siteMode: "fun" };
    expect(hostCommand({ action: "add", server })).toBe("add 27020 0123456789abcdef0123456789abcdef competitive de_mirage 10 fun");
    expect(hostCommand({ action: "add", server: { ...server, siteMode: "" } })).toBe("add 27020 0123456789abcdef0123456789abcdef competitive de_mirage 10");
    expect(() => hostCommand({ action: "add", server: { ...server, map: "de_mirage; rm -rf /" } })).toThrow();
    expect(() => hostCommand({ action: "add", server: { ...server, gslt: "short" } })).toThrow();
    expect(hostCommand({ action: "remove", target: "27020" })).toBe("remove 27020");
    expect(hostActionSchema.safeParse({ hostId: "game1", action: "add", server }).success).toBe(true);
    expect(hostActionSchema.safeParse({ hostId: "game1", action: "add", server: { ...server, port: 80 } }).success).toBe(false);
    expect(hostActionSchema.safeParse({ hostId: "game1", action: "remove", target: "abc" }).success).toBe(false);
  });
});
