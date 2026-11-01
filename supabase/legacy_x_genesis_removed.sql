-- The Genesis pack is taken out (owner request 2026-11-01: its colour and look are changing, so it is removed).
--   * The product is switched off, so it cannot be bought or ordered any more.
--   * The Genesis frame, Gold Foil banner and Genesis title are taken off everyone (worn or owned) and switched off; the Genesis numbers are cleared.
--   * Nothing is paid back: both Genesis packs were test accounts' (owner, 2026-11-01), and no real player bought one.
-- Safe to re-run.

BEGIN;

UPDATE legacy_x.shop_products SET enabled = false WHERE kind = 'founder';

DELETE FROM legacy_x.cosmetic_equipped WHERE item_id IN ('founder', 'banner-gold-foil', 'title-founder');
DELETE FROM legacy_x.cosmetic_owned WHERE item_id IN ('founder', 'banner-gold-foil', 'title-founder');
UPDATE legacy_x.cosmetic_items SET enabled = false WHERE id IN ('founder', 'banner-gold-foil', 'title-founder');
DELETE FROM legacy_x.founders;

COMMIT;
