import { describe, expect, it } from "vitest";
import { hostActionSchema, hostCommand, hostConfig, runHost, sshArguments } from "./hostAgent";

const base = { HOST_SSH_HOST: "203.0.113.10", HOST_SSH_KEY: "/etc/legacyx/host_key" };

describe("host agent", () => {
  it("is off until a host and a key file are set", () => {
    expect(hostConfig({})).toBeNull();
    expect(hostConfig({ HOST_SSH_HOST: "a.example" })).toBeNull();
    expect(hostConfig(base)).toMatchObject({ host: "203.0.113.10", user: "root", port: 22, knownHosts: null });
  });
  it("refuses a host or user that could be read as an ssh option", () => {
    expect(hostConfig({ ...base, HOST_SSH_HOST: "-oProxyCommand=x" })).toBeNull();
    expect(hostConfig({ ...base, HOST_SSH_USER: "root;id" })).toBeNull();
    expect(hostConfig({ ...base, HOST_SSH_PORT: "99999" })).toBeNull();
  });
  it("sends only a whitelisted word", () => {
    expect(hostCommand({ action: "status" })).toBe("status");
    expect(hostCommand({ action: "deploy" })).toBe("deploy");
    expect(hostCommand({ action: "restart", port: 27015 })).toBe("restart 27015");
    expect(() => hostCommand({ action: "restart", port: 22.5 })).toThrow();
    expect(hostActionSchema.safeParse({ action: "restart", port: "27015; id" }).success).toBe(false);
    expect(hostActionSchema.safeParse({ action: "rm" }).success).toBe(false);
    expect(hostActionSchema.safeParse({ action: "deploy", extra: 1 }).success).toBe(false);
  });
  it("puts the command after -- and checks the host key when a known_hosts file is given", () => {
    const config = hostConfig({ ...base, HOST_SSH_KNOWN_HOSTS: "/etc/legacyx/known_hosts" })!;
    const args = sshArguments(config, "status");
    expect(args.slice(-3)).toEqual(["root@203.0.113.10", "--", "status"]);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("BatchMode=yes");
  });
  it("reads the host's JSON and hides ssh's own error text", async () => {
    const config = hostConfig(base)!;
    const good = await runHost(config, { action: "status" }, ((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, '{"ok":true,"checks":[]}', "")) as never);
    expect(good.ok).toBe(true);
    const refused = await runHost(config, { action: "deploy" }, ((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, '{"ok":false,"error":"another action is running"}', "")) as never);
    expect(refused).toMatchObject({ ok: false, error: "another action is running" });
    const down = await runHost(config, { action: "status" }, ((_c: string, _a: string[], _o: unknown, cb: Function) => cb(new Error("x"), "", "Permission denied (publickey) /root/.ssh")) as never);
    expect(down).toMatchObject({ ok: false, error: "Could not reach the host over SSH" });
  });
});
