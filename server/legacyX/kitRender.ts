import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The animated Creator kit (owner request 2026-11-07): the creator types a name (and a code) on the website and the API renders the animations with Remotion
 * (backend/remotion): a lower third and a code bar that slide in from the side (transparent WebM), an end card (MP4) and two looping GIFs. One render at a time,
 * a few per creator per day, and the files are removed after a day. Nothing is rendered from anything but the name and the code, which React draws as text.
 */
export const KIT_ITEMS = [
  { id: "lower-third", composition: "LowerThird", ext: "webm", needs: "name", label: "Lower third, slides in from the left (transparent WebM)" },
  { id: "code-bar", composition: "CodeBar", ext: "webm", needs: "code", label: "Creator code bar, slides in from the right (transparent WebM)" },
  { id: "end-card", composition: "EndCard", ext: "mp4", needs: "either", label: "End card, 6 seconds (MP4)" },
  { id: "code-gif", composition: "CodeGif", ext: "gif", needs: "code", label: "Creator code sticker (looping GIF)" },
  { id: "glitch-gif", composition: "GlitchGif", ext: "gif", needs: "name", label: "Glitch logo with your name (looping GIF)" },
] as const;
export type KitItemId = (typeof KIT_ITEMS)[number]["id"];
const ITEM_IDS = KIT_ITEMS.map((item) => item.id) as [KitItemId, ...KitItemId[]];

export const KIT_DAILY_LIMIT = Number(process.env.KIT_RENDER_DAILY_LIMIT) > 0 ? Number(process.env.KIT_RENDER_DAILY_LIMIT) : 6;
export const KIT_KEEP_HOURS = 24;

/** What may be written: no control characters, one space between words, 24 characters at most. */
export const cleanKitName = (raw: string) => raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
export const cleanKitCode = (raw: string) => raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);

export const kitRenderSchema = z
  .object({ name: z.string().max(80).default(""), code: z.string().max(40).default(""), items: z.array(z.enum(ITEM_IDS)).min(1).max(ITEM_IDS.length) })
  .strict()
  .transform((input) => ({ name: cleanKitName(input.name), code: cleanKitCode(input.code), items: Array.from(new Set(input.items)) }))
  .superRefine((input, context) => {
    for (const id of input.items) {
      const item = KIT_ITEMS.find((candidate) => candidate.id === id)!;
      if (item.needs === "name" && !input.name) context.addIssue({ code: "custom", path: ["name"], message: `Type your name for: ${item.label}` });
      if (item.needs === "code" && input.code.length < 4) context.addIssue({ code: "custom", path: ["code"], message: `Type your creator code for: ${item.label}` });
      if (item.needs === "either" && !input.name && input.code.length < 4) context.addIssue({ code: "custom", path: ["name"], message: `Type your name or your creator code for: ${item.label}` });
    }
  });
export type KitRenderInput = z.infer<typeof kitRenderSchema>;

export const kitExt = (id: string) => KIT_ITEMS.find((item) => item.id === id)?.ext ?? "bin";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** backend/remotion, found from this file in the source tree (tsx, tests) or from the cwd when the API is bundled into dist/. */
export function kitRemotionDir() {
  const fromEnv = process.env.KIT_RENDER_REMOTION_DIR?.trim();
  if (fromEnv) return fromEnv;
  for (const base of [path.resolve(HERE, "../../remotion"), path.resolve(process.cwd(), "remotion")]) if (existsSync(path.join(base, "render.mjs"))) return base;
  return path.resolve(process.cwd(), "remotion");
}
export const kitOutputDir = () => process.env.KIT_RENDER_DIR?.trim() || path.join(os.tmpdir(), "legacyx-kit-renders");

/** On by itself once backend/remotion has its packages (ops/deploy.sh installs them); KIT_RENDER_ENABLED=false is the only .env line, to switch it off. */
export function kitRenderEnabled() {
  return process.env.KIT_RENDER_ENABLED !== "false" && existsSync(path.join(kitRemotionDir(), "node_modules", "remotion"));
}

/** Renders one animation into `out`; rejects with a short reason. */
export function renderKitItem(composition: string, out: string, props: { name: string; code: string }, timeoutMs = 5 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["render.mjs", composition, out, JSON.stringify(props)], {
      cwd: kitRemotionDir(),
      env: { ...process.env, REMOTION_BROWSER: process.env.KIT_RENDER_BROWSER ?? "", REMOTION_CONCURRENCY: process.env.KIT_RENDER_CONCURRENCY ?? "2" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("The render took too long")); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (exit) => {
      clearTimeout(timer);
      if (exit === 0) resolve();
      else reject(new Error(`The render failed (${exit})${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`));
    });
  });
}

export type KitJob = { id: string; name: string; code: string; items: KitItemId[] };
export type KitHooks = {
  onStart: (job: KitJob) => Promise<void>;
  onFinish: (job: KitJob, files: Array<{ id: KitItemId; ext: string; bytes: number }>) => Promise<void>;
  onFail: (job: KitJob, reason: string) => Promise<void>;
  /** Renders one item into the file (replaced by a fake in tests). */
  render?: (composition: string, out: string, props: { name: string; code: string }) => Promise<void>;
  dir?: string;
};

/** One render at a time: a job waits for the ones before it. */
export class KitRenderQueue {
  private chain: Promise<void> = Promise.resolve();
  private waiting = 0;
  constructor(private readonly hooks: KitHooks) {}

  get length() { return this.waiting; }

  push(job: KitJob) {
    this.waiting += 1;
    this.chain = this.chain.then(() => this.run(job)).catch(() => undefined).finally(() => { this.waiting -= 1; });
  }

  private async run(job: KitJob) {
    const dir = path.join(this.hooks.dir ?? kitOutputDir(), job.id);
    try {
      await this.hooks.onStart(job);
      await mkdir(dir, { recursive: true });
      const files: Array<{ id: KitItemId; ext: string; bytes: number }> = [];
      for (const id of job.items) {
        const item = KIT_ITEMS.find((candidate) => candidate.id === id)!;
        const out = path.join(dir, `${id}.${item.ext}`);
        await (this.hooks.render ?? renderKitItem)(item.composition, out, { name: job.name, code: job.code });
        files.push({ id, ext: item.ext, bytes: (await stat(out)).size });
      }
      await this.hooks.onFinish(job, files);
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await this.hooks.onFail(job, error instanceof Error ? error.message.slice(0, 300) : "The render failed").catch(() => undefined);
    }
  }
}

/** The path of a finished file, refusing anything that is not a plain id (no way out of the job's folder). */
export function kitFilePath(jobId: string, itemId: string, dir = kitOutputDir()) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || !ITEM_IDS.includes(itemId as KitItemId)) return null;
  return path.join(dir, jobId, `${itemId}.${kitExt(itemId)}`);
}

export async function removeKitJobFiles(jobId: string, dir = kitOutputDir()) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return;
  await rm(path.join(dir, jobId), { recursive: true, force: true });
}
