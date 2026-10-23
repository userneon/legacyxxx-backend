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

export type ChatBodyProblem = "empty" | "too_long" | "link";

/** The cleaned message, or what is wrong with it. */
export function checkChatBody(raw: string, isStaff: boolean): { ok: true; body: string } | { ok: false; problem: ChatBodyProblem } {
  const body = cleanChatBody(raw);
  if (!body) return { ok: false, problem: "empty" };
  if (body.length > CHAT_BODY_MAX) return { ok: false, problem: "too_long" };
  if (!isStaff && hasLink(body)) return { ok: false, problem: "link" };
  return { ok: true, body };
}
