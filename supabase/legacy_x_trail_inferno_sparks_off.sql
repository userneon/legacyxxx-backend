-- The Inferno and Sparks trail designs are too big and too obvious (owner request 2026-10-26): off in the Shop. Owners keep what they bought.
-- Safe to re-run.
UPDATE legacy_x.cosmetic_items SET enabled = false WHERE id IN ('trail-inferno', 'trail-sparks');
