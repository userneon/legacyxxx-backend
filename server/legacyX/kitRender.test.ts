import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { KIT_ITEMS, KitRenderQueue, cleanKitCode, cleanKitName, kitExt, kitFilePath, kitRenderSchema, type KitJob } from "./kitRender";

describe("kit render input", () => {
  it("cleans the name and the code", () => {
    expect(cleanKitName("  Mongol \u200b  Pro\u0007 ")).toBe("Mongol Pro");
    expect(cleanKitName("x".repeat(40))).toHaveLength(24);
    expect(cleanKitCode("k7m-2qx!")).toBe("K7M2QX");
  });
  it("needs what each animation writes", () => {
    expect(kitRenderSchema.safeParse({ items: ["lower-third"] }).success).toBe(false);
    expect(kitRenderSchema.safeParse({ items: ["code-bar"], name: "A" }).success).toBe(false);
    expect(kitRenderSchema.safeParse({ items: ["end-card"] }).success).toBe(false);
    const ok = kitRenderSchema.safeParse({ items: ["lower-third", "lower-third", "code-gif"], name: " A  B ", code: "k7m2qx" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toEqual({ name: "A B", code: "K7M2QX", items: ["lower-third", "code-gif"] });
  });
  it("refuses unknown fields and unknown animations", () => {
    expect(kitRenderSchema.safeParse({ items: ["nope"], name: "A" }).success).toBe(false);
    expect(kitRenderSchema.safeParse({ items: ["lower-third"], name: "A", extra: 1 }).success).toBe(false);
  });
  it("gives a file path only for a plain job and item id", () => {
    const id = "6b6da1e7-4298-4367-a1ec-bfecc179cb8a";
    expect(kitFilePath(id, "lower-third", "/tmp/k")).toBe(`/tmp/k/${id}/lower-third.webm`);
    expect(kitFilePath("../x", "lower-third", "/tmp/k")).toBeNull();
    expect(kitFilePath(id, "../../etc/passwd", "/tmp/k")).toBeNull();
  });
});

describe("kit render queue", () => {
  it("renders the items of a job one after another and reports the files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-test-"));
    const events: string[] = [];
    const queue = new KitRenderQueue({
      dir,
      onStart: async (job) => { events.push(`start ${job.id}`); },
      onFinish: async (job, files) => { events.push(`finish ${job.id} ${files.map((file) => `${file.id}:${file.bytes}`).join(",")}`); },
      onFail: async (job, reason) => { events.push(`fail ${job.id} ${reason}`); },
      render: async (composition, out) => { await writeFile(out, composition); },
    });
    const a: KitJob = { id: "6b6da1e7-4298-4367-a1ec-bfecc179cb8a", name: "A", code: "", items: ["lower-third", "glitch-gif"] };
    const b: KitJob = { id: "39a2d304-d02c-4519-9dab-c60c6454338b", name: "B", code: "", items: ["lower-third"] };
    queue.push(a);
    queue.push(b);
    expect(queue.length).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toEqual([`start ${a.id}`, `finish ${a.id} lower-third:10,glitch-gif:9`, `start ${b.id}`, `finish ${b.id} lower-third:10`]);
    expect(queue.length).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
  it("reports a failed render and carries on with the next job", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-test-"));
    const events: string[] = [];
    const queue = new KitRenderQueue({
      dir,
      onStart: async () => undefined,
      onFinish: async (job) => { events.push(`finish ${job.name}`); },
      onFail: async (job, reason) => { events.push(`fail ${job.name} ${reason}`); },
      render: async (_composition, out, props) => { if (props.name === "bad") throw new Error("boom"); await writeFile(out, "x"); },
    });
    queue.push({ id: "6b6da1e7-4298-4367-a1ec-bfecc179cb8a", name: "bad", code: "", items: ["lower-third"] });
    queue.push({ id: "39a2d304-d02c-4519-9dab-c60c6454338b", name: "good", code: "", items: ["lower-third"] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toEqual(["fail bad boom", "finish good"]);
    await rm(dir, { recursive: true, force: true });
  });
  it("offers MOV (ProRes alpha) copies for editors: heavy ones need no name or code when they are the same for everyone", () => {
    const mov = KIT_ITEMS.filter((item) => item.ext === "mov");
    expect(mov.map((item) => item.id)).toEqual(["lower-third-mov", "code-bar-mov", "intro-mov", "sting-mov", "wipe-mov", "badge-mov"]);
    expect(kitRenderSchema.safeParse({ items: ["intro-mov", "badge-mov"] }).success).toBe(true);
    expect(kitRenderSchema.safeParse({ items: ["lower-third-mov"] }).success).toBe(false);
    expect(kitExt("intro-mov")).toBe("mov");
  });
});
