import type { CheckerRules } from "./checkerRules";

/** What the checker reports about one program: facts only. */
export type CheckFact = {
  name: string;
  path?: string;
  size: number;
  signed: boolean;
  managed: boolean;
  running?: boolean;
  protector?: string;
  apis: string[];
  game: string[];
  offsets: string[];
  family: string[];
};

export type JudgedFinding = { name: string; kind: "file" | "process"; confidence: "detection" | "suspicion"; path?: string; note: string };

const includesWord = (words: string[], text: string) => words.find((word) => word.length >= 4 && text.toLowerCase().includes(word.toLowerCase())) ?? null;

/** Digits only, a long run of hex, or letters and digits jumbled together: not a name a person would give a program. */
export function looksRandom(stem: string): boolean {
  if (stem.length < 6 || /[^A-Za-z0-9]/.test(stem)) return false;
  const digits = (stem.match(/[0-9]/g) ?? []).length;
  if (digits === stem.length) return true;
  if (stem.length >= 10 && /^[0-9a-fA-F]+$/.test(stem)) return true;
  const letters = (stem.match(/[A-Za-z]/g) ?? []).length;
  return stem.length >= 8 && digits >= 3 && letters >= 3 && Math.floor((digits * 100) / stem.length) >= 30;
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The verdict on one program. Null when it does not reach a suspicion. A name never decides; it lowers the bar a little. */
export function judgeFact(fact: CheckFact, rules: CheckerRules): JudgedFinding | null {
  const kind = fact.running ? "process" : "file";
  const prefix = fact.running ? "Running now. " : "";
  const base = { name: fact.name, kind, ...(fact.path ? { path: fact.path } : {}) } as const;

  // A cheat staff have seen: its marks are inside, whatever the file is called and even when it is signed with a stolen certificate.
  const have = new Set(fact.family);
  for (const family of rules.families) {
    const matched = family.strings.filter((mark) => have.has(mark));
    if (matched.length >= Math.max(1, family.minMatches)) {
      return { ...base, confidence: "detection", note: `${prefix}Matches the ${family.name} cheat (${matched.length} of its marks)` };
    }
  }
  if (fact.signed) return null;

  const apis = new Set(fact.apis.map((api) => api.toLowerCase()));
  const has = (group: string[]) => group.some((api) => apis.has(api));
  const signals: Array<[string, number]> = [];
  if (apis.has("openprocess") && has(rules.apis.memory)) signals.push(["reads or writes another program's memory", rules.points.memory]);
  if (has(rules.apis.injection)) signals.push(["can push code into another program", rules.points.injection]);
  if (has(rules.apis.kernel)) signals.push(["uses kernel routines to reach another program's memory", rules.points.kernel]);
  if (signals.length === 0) return null;
  if (has(rules.apis.findProgram)) signals.push(["looks for another program by name", rules.points.findProgram]);
  if (has(rules.apis.overlay)) signals.push(["can draw a see-through window over the screen", rules.points.overlay]);
  if (has(rules.apis.input)) signals.push(["can send mouse or keyboard input", rules.points.input]);
  if (fact.protector) signals.push([`is packed with a protector (${fact.protector})`, rules.points.protector]);
  if (looksRandom(stemOf(fact.name))) signals.push(["has a random-looking name", rules.points.randomName]);
  if (fact.path && /[\\/](Downloads|Desktop|Temp|AppData)[\\/]/i.test(fact.path)) signals.push(["sits in Downloads, Desktop, Temp or AppData", rules.points.userFolder]);

  if (fact.game.length > 0) signals.push([`names ${fact.game.slice(0, 3).join(", ")}`, rules.points.game]);
  if (fact.offsets.length >= 2) signals.push([`carries CS2 offsets (${fact.offsets.slice(0, 4).join(", ")})`, rules.points.offsets]);

  const pathParts = (fact.path ?? "").split(/[\\/]/).slice(-3);
  const hinted = [fact.name, ...pathParts].some((part) => includesWord(rules.cheatNames, part) || includesWord(rules.nameKeywords, part));
  const score = signals.reduce((sum, [, points]) => sum + points, 0);
  const aimsAtCs2 = fact.game.length > 0 || fact.offsets.length >= 2;
  const t = rules.thresholds;
  const detection = aimsAtCs2 && score >= (hinted ? t.detectionHinted : t.detection);
  const suspicion = score >= (aimsAtCs2 ? t.suspicionWithCs2 : t.suspicionWithoutCs2) - (hinted ? t.hintedBonus : 0);
  if (!detection && !suspicion) return null;
  return { ...base, confidence: detection ? "detection" : "suspicion", note: `${prefix}Unsigned program, ${score} points: ${signals.map(([what]) => what).join("; ")}` };
}

export function judgeFacts(facts: CheckFact[], rules: CheckerRules): JudgedFinding[] {
  return facts.map((fact) => judgeFact(fact, rules)).filter((finding): finding is JudgedFinding => finding !== null);
}
