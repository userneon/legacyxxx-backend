-- The old square avatar frames are deleted (owner request 2026-11-07, "delete all the old square frames").
-- Kept: the round frog frames, the Crystal Orb, and the inert earned rows (rank-*, server-booster, booster-*, founder) that the rank
-- trigger and the booster code still write to; they stay switched off, so nothing shows them. Owned rows of deleted items go with them (cascade).
DELETE FROM legacy_x.cosmetic_items
 WHERE kind = 'frame' AND id NOT LIKE 'frog-%' AND id <> 'crystal-orb'
   AND id NOT LIKE 'rank-%' AND id NOT LIKE 'booster-%' AND id NOT IN ('server-booster', 'founder');
