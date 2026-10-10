import { promises as fs } from "node:fs";

/**
 * What the checker looks for (the probes, which it is told at the start of a scan) and how what it found is judged (the points and limits,
 * which never leave the server). The program only reports facts: which of the listed functions and words a program holds. The verdict is made here,
 * so a cheat maker who takes the program apart finds a list of things it reports, not the rule that decides.
 *
 * The rules are the built-in ones below, or the JSON file CHECKER_SERVER_RULES_PATH points to (the same shape; any missing part keeps the built-in value).
 */
export type CheckerRules = {
  version: number;
  apis: { memory: string[]; injection: string[]; kernel: string[]; overlay: string[]; input: string[]; findProgram: string[] };
  gameMarkers: string[];
  offsetMarkers: string[];
  protectorSections: string[];
  families: Array<{ name: string; strings: string[]; minMatches: number }>;
  /** Names of known cheats and words like "aimbot": a program whose name or folder holds one is looked at a little more closely, never judged by it. */
  cheatNames: string[];
  nameKeywords: string[];
  /** Exact lists made by staff from verified samples: a name or fingerprint here is a detection. */
  knownFileNames: string[];
  sha256: string[];
  cheatHosts: string[];
  points: { memory: number; injection: number; kernel: number; findProgram: number; overlay: number; input: number; protector: number; randomName: number; userFolder: number; game: number; offsets: number };
  thresholds: { detection: number; detectionHinted: number; suspicionWithCs2: number; suspicionWithoutCs2: number; hintedBonus: number };
};

export const DEFAULT_CHECKER_RULES: CheckerRules = {
  version: 7,
  apis: {
    memory: ["readprocessmemory", "writeprocessmemory", "ntreadvirtualmemory", "ntwritevirtualmemory", "zwreadvirtualmemory", "zwwritevirtualmemory", "virtualallocex", "virtualprotectex"],
    injection: ["createremotethread", "ntcreatethreadex", "rtlcreateuserthread", "queueuserapc", "ntqueueapcthread", "ntmapviewofsection", "setwindowshookexa", "setwindowshookexw"],
    kernel: ["mmcopyvirtualmemory", "kestackattachprocess", "pslookupprocessbyprocessid"],
    overlay: ["setlayeredwindowattributes", "updatelayeredwindow", "dwmextendframeintoclientarea", "d3d11createdeviceandswapchain"],
    input: ["sendinput", "mouse_event", "keybd_event", "setcursorpos"],
    findProgram: ["createtoolhelp32snapshot", "process32first", "process32firstw", "process32next", "process32nextw", "module32first", "module32firstw", "module32next", "module32nextw", "enumprocessmodules", "enumprocessmodulesex"],
  },
  gameMarkers: ["cs2.exe", "client.dll", "engine2.dll", "Counter-Strike 2"],
  offsetMarkers: ["dwEntityList", "dwLocalPlayerPawn", "dwLocalPlayerController", "dwViewMatrix", "dwViewAngles", "m_pGameSceneNode", "m_iTeamNum", "m_vOldOrigin", "m_iszPlayerName"],
  protectorSections: [".vmp0", ".vmp1", ".themida", ".winlice", ".enigma1", ".enigma2", ".aspack", ".petite", ".nsp0", ".nsp1", ".MPRESS1", "UPX0", "UPX1"],
  families: [],
  cheatNames: ["undetek", "neverlose", "gamesense", "onetap", "aimware", "nixware", "osiris", "legendware", "plaguecheat", "spirthack", "interwebz", "iniuria", "skeet"],
  nameKeywords: ["aimbot", "triggerbot", "wallhack", "spinbot", "antiaim", "norecoil", "cheat"],
  knownFileNames: [],
  sha256: [],
  cheatHosts: [],
  points: { memory: 3, injection: 3, kernel: 3, findProgram: 1, overlay: 1, input: 1, protector: 1, randomName: 1, userFolder: 1, game: 2, offsets: 4 },
  thresholds: { detection: 7, detectionHinted: 6, suspicionWithCs2: 5, suspicionWithoutCs2: 6, hintedBonus: 1 },
};

const list = (value: unknown, fallback: string[]): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200).slice(0, 2000) : fallback);
const numbers = <T extends Record<string, number>>(value: unknown, fallback: T): T => {
  const out = { ...fallback };
  if (value && typeof value === "object") {
    for (const key of Object.keys(fallback)) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= 100) (out as Record<string, number>)[key] = candidate;
    }
  }
  return out;
};

/** Reads a rules file on top of the built-in rules. Anything that is missing or of the wrong kind keeps the built-in value. */
export function mergeCheckerRules(input: unknown): CheckerRules {
  const base = DEFAULT_CHECKER_RULES;
  if (!input || typeof input !== "object") return base;
  const source = input as Record<string, unknown>;
  const apis = (source.apis ?? {}) as Record<string, unknown>;
  const families = Array.isArray(source.families)
    ? source.families
        .map((family) => {
          const entry = family as Record<string, unknown>;
          const strings = list(entry?.strings, []);
          const name = typeof entry?.name === "string" ? entry.name.slice(0, 80) : "";
          const minMatches = typeof entry?.minMatches === "number" && entry.minMatches >= 1 ? Math.min(20, Math.floor(entry.minMatches)) : 2;
          return { name, strings, minMatches };
        })
        .filter((family) => family.name && family.strings.length > 0)
        .slice(0, 200)
    : base.families;
  return {
    version: typeof source.version === "number" ? source.version : base.version,
    apis: {
      memory: list(apis.memory, base.apis.memory),
      injection: list(apis.injection, base.apis.injection),
      kernel: list(apis.kernel, base.apis.kernel),
      overlay: list(apis.overlay, base.apis.overlay),
      input: list(apis.input, base.apis.input),
      findProgram: list(apis.findProgram, base.apis.findProgram),
    },
    gameMarkers: list(source.gameMarkers, base.gameMarkers),
    offsetMarkers: list(source.offsetMarkers, base.offsetMarkers),
    protectorSections: list(source.protectorSections, base.protectorSections),
    families,
    cheatNames: list(source.cheatNames, base.cheatNames),
    nameKeywords: list(source.nameKeywords, base.nameKeywords),
    knownFileNames: list(source.knownFileNames, base.knownFileNames),
    sha256: list(source.sha256, base.sha256),
    cheatHosts: list(source.cheatHosts, base.cheatHosts),
    points: numbers(source.points, base.points),
    thresholds: numbers(source.thresholds, base.thresholds),
  };
}

let cached: { path: string; mtimeMs: number; rules: CheckerRules } | null = null;

/** The rules in force: the file named by CHECKER_SERVER_RULES_PATH when there is one (re-read when it changes), else the built-in rules. */
export async function loadCheckerRules(): Promise<CheckerRules> {
  const path = process.env.CHECKER_SERVER_RULES_PATH?.trim();
  if (!path) return DEFAULT_CHECKER_RULES;
  try {
    const stat = await fs.stat(path);
    if (cached && cached.path === path && cached.mtimeMs === stat.mtimeMs) return cached.rules;
    const rules = mergeCheckerRules(JSON.parse(await fs.readFile(path, "utf8")));
    cached = { path, mtimeMs: stat.mtimeMs, rules };
    return rules;
  } catch (failure) {
    console.error("Unable to read the checker rules file; using the built-in rules", failure instanceof Error ? failure.message : failure);
    return DEFAULT_CHECKER_RULES;
  }
}

/** What the program is told to look for: the lists, never the points or the limits. */
export function probesOf(rules: CheckerRules) {
  const apis = Array.from(new Set(["openprocess", ...Object.values(rules.apis).flat()]));
  return {
    version: rules.version,
    apis,
    gameMarkers: rules.gameMarkers,
    offsetMarkers: rules.offsetMarkers,
    familyStrings: Array.from(new Set(rules.families.flatMap((family) => family.strings))),
    protectorSections: rules.protectorSections,
    knownFileNames: rules.knownFileNames,
    sha256: rules.sha256,
    cheatHosts: rules.cheatHosts,
  };
}
