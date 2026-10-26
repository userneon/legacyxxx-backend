-- The plain gradient clan page backgrounds were taken out (owner request 2026-10-26): every page background now moves. The one bought
-- (Dusk Sky, 1,200 LX) was refunded first (ref `refund:clan-look-plain-removed:page-dusk`). The items live in server/legacyX/clanLooks.ts;
-- this only clears the rows that still point at them. Safe to re-run.
DELETE FROM legacy_x.clan_look_equipped WHERE item_id IN ('page-custom-plain', 'page-ember', 'page-ocean', 'page-forest', 'page-violet', 'page-crimson', 'page-steel', 'page-dusk', 'page-sunset', 'page-aurora', 'page-inferno', 'page-nebula', 'page-royal');
DELETE FROM legacy_x.clan_look_owned_player WHERE item_id IN ('page-custom-plain', 'page-ember', 'page-ocean', 'page-forest', 'page-violet', 'page-crimson', 'page-steel', 'page-dusk', 'page-sunset', 'page-aurora', 'page-inferno', 'page-nebula', 'page-royal');
DELETE FROM legacy_x.clan_look_custom WHERE item_id = 'page-custom-plain';
