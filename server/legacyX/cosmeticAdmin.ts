import { z } from "zod";

/**
 * What staff may change on a cosmetic from the staff site (owner request 2026-10-23): its names, how it is unlocked, its price, whether
 * it is on sale, the line shown for achievements and its place in the list. Art, colours and effects stay in the code and the
 * seed SQL. A price goes with the "coin" unlock and only with it, the same rule the table enforces.
 */
export const COSMETIC_UNLOCKS = ["free", "coin", "achievement"] as const;

export const cosmeticEditSchema = z
  .object({
    nameEn: z.string().trim().min(2).max(40),
    nameMn: z.string().trim().min(2).max(40),
    unlock: z.enum(COSMETIC_UNLOCKS),
    price: z.number().int().min(0).max(1_000_000),
    requirement: z.string().trim().max(80).default(""),
    sort: z.number().int().min(-1000).max(10_000),
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.unlock === "coin" && value.price <= 0) context.addIssue({ code: "custom", path: ["price"], message: "A coin item needs a price above 0" });
    if (value.unlock !== "coin" && value.price !== 0) context.addIssue({ code: "custom", path: ["price"], message: "Only a coin item has a price" });
  });
