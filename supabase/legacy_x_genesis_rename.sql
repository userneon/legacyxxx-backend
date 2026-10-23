-- The Founder pack is now called Genesis (owner decision 2026-10-23): Founder is already a staff role, so a player with that role and the pack
-- would carry two different "Founder" marks. Only the names change; the ids (founder, banner-gold-foil, title-founder, founder-pack) stay,
-- so nothing already bought or worn is affected. Run it if legacy_x_founder.sql ran before the rename; on a new database it changes nothing. Safe to re-run.
UPDATE legacy_x.cosmetic_items SET name_en = 'Genesis', name_mn = 'Genesis', requirement = 'Genesis pack' WHERE id IN ('founder', 'title-founder');
UPDATE legacy_x.cosmetic_items SET requirement = 'Genesis pack' WHERE id = 'banner-gold-foil';
UPDATE legacy_x.shop_products SET name = 'LEGACY-X Genesis', description = 'Numbered, limited, never sold again: Genesis frame, Gold Foil banner, Genesis title and badge.' WHERE slug = 'founder-pack';
