import { z } from "zod";

/** The public chat on the website (owner request 2026-10-23): what a message may look like, and the small rules around it. */
export const CHAT_BODY_MAX = 300;
export const CHAT_PAGE = 60;

/** Control characters and zero-width marks are dropped, runs of spaces and line breaks become one space. */
export function cleanChatBody(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A web address (or one typed to dodge the check, like "example dot com"). Players may not post links; staff may. */
const LINK = /(?:https?:\/\/|www\.|\b[a-z0-9-]{2,}\s?(?:\.|\(dot\)|\[dot\]|\sdot\s)\s?(?:com|net|org|gg|mn|cc|ru|io|tv|me|xyz|gl|ly|co)\b|discord\.gg|t\.me)/i;
export const hasLink = (text: string) => LINK.test(text);

export const chatMessageSchema = z.object({ body: z.string().max(2000) }).strict();

export type ChatBodyProblem = "empty" | "too_long" | "link" | "repeated_characters" | "shouting";

/** The cleaned message, or what is wrong with it. */
export function checkChatBody(raw: string, isStaff: boolean): { ok: true; body: string } | { ok: false; problem: ChatBodyProblem } {
  const body = cleanChatBody(raw);
  if (!body) return { ok: false, problem: "empty" };
  if (body.length > CHAT_BODY_MAX) return { ok: false, problem: "too_long" };
  if (!isStaff && hasLink(body)) return { ok: false, problem: "link" };
  if (!isStaff && hasLongRun(body)) return { ok: false, problem: "repeated_characters" };
  if (!isStaff && isShouting(body)) return { ok: false, problem: "shouting" };
  return { ok: true, body };
}

/** The same character ten times in a row ("aaaaaaaaaa", "!!!!!!!!!!"). */
export function hasLongRun(text: string): boolean {
  let run = 0;
  let last = "";
  for (const character of Array.from(text)) {
    run = character === last ? run + 1 : 1;
    last = character;
    if (run >= 10) return true;
  }
  return false;
}

/** A long message that is almost all capitals. Short ones ("GG", "WP") are fine. */
export function isShouting(text: string): boolean {
  const letters = Array.from(text).filter((character) => character.toLowerCase() !== character.toUpperCase());
  if (letters.length < 20) return false;
  const capitals = letters.filter((character) => character === character.toUpperCase()).length;
  return capitals / letters.length > 0.8;
}

/** A message reduced to what it says, so "GG!!" and "gg" count as the same one: lower case, letters and digits only, runs shortened to two. */
export function spamKey(text: string): string {
  let key = "";
  let run = 0;
  let last = "";
  for (const character of Array.from(cleanChatBody(text).toLowerCase())) {
    if (character.toLowerCase() === character.toUpperCase() && !/[0-9]/.test(character)) continue;
    run = character === last ? run + 1 : 1;
    last = character;
    if (run <= 2) key += character;
  }
  return key;
}

export interface RecentMessage {
  userId: string;
  body: string;
  at: number;
}

export type SpamProblem = "duplicate" | "copied" | "too_fast";

/**
 * Flood checks over the recent messages (newest the last 2 minutes): the same player repeating a message, the same message coming from
 * several players at once (a bot or a raid), or a player writing more than `perMinute` messages in a minute.
 */
export function spamProblem(body: string, userId: string, recent: ReadonlyArray<RecentMessage>, now: number, perMinute: number): SpamProblem | null {
  const key = spamKey(body);
  const mine = recent.filter((message) => message.userId === userId);
  if (mine.filter((message) => now - message.at < 60_000).length >= perMinute) return "too_fast";
  if (key.length > 0 && mine.some((message) => now - message.at < 120_000 && spamKey(message.body) === key)) return "duplicate";
  const others = new Set(recent.filter((message) => message.userId !== userId && now - message.at < 120_000 && key.length > 3 && spamKey(message.body) === key).map((message) => message.userId));
  if (others.size >= 2) return "copied";
  return null;
}
