-- Emotes are gone from the game servers and the website (2026-10-23): remove their cosmetic rows.
-- Run after legacy_x_cosmetics_emotes.sql. Safe to re-run. The API already ignores the 'emote' kind (it is no longer in the
-- catalog), so this only tidies the tables; the 'emote' value stays allowed in the kind checks and `game_key` stays as an unused column.
--
-- Wallet history is not touched: a player who paid for an emote keeps the "spend" line in their ledger. Refund by hand if you want to:
--   select user_id, amount, reason, created_at from legacy_x.wallet_transactions where reason like 'Emote:%' and kind = 'spend';
begin;
set local lock_timeout = '5s';
delete from legacy_x.cosmetic_equipped where kind = 'emote';
delete from legacy_x.cosmetic_owned where item_id in (select id from legacy_x.cosmetic_items where kind = 'emote');
delete from legacy_x.cosmetic_items where kind = 'emote';
commit;
