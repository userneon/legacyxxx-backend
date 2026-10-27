-- Collectible cards (owner request 2026-10-27): bought with LX, kept, sold back later. Unlimited supply; the price follows how many
-- copies players hold right now (the more are held, the dearer the next one: base x (1 + held / 25)^2). Selling pays 90% of the price
-- of the copy being returned, so a round trip always costs 10% and a gain only comes from other players buying. Rules in
-- server/legacyX/cards.ts (the same formula). Buying and selling run in one transaction with the wallet. Safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.cards (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  map_key text NOT NULL,
  rarity text NOT NULL CHECK (rarity IN ('standard', 'select', 'elite', 'prime', 'apex')),
  base_price integer NOT NULL CHECK (base_price BETWEEN 1 AND 100000),
  held integer NOT NULL DEFAULT 0 CHECK (held >= 0),
  enabled boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS legacy_x.card_owned (
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  card_id text NOT NULL REFERENCES legacy_x.cards(id) ON DELETE CASCADE,
  qty integer NOT NULL CHECK (qty > 0),
  first_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_id)
);
CREATE TABLE IF NOT EXISTS legacy_x.card_trades (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  card_id text NOT NULL REFERENCES legacy_x.cards(id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  price integer NOT NULL,
  held_after integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS card_trades_card_idx ON legacy_x.card_trades (card_id, created_at DESC);
ALTER TABLE legacy_x.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.card_owned ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.card_trades ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION legacy_x.card_price(p_base integer, p_held integer) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT ceil(p_base * power(1 + p_held / 25.0, 2))::integer $$;

-- One buy or sell. `p_limit` is the price the player saw: a buy refuses to cost more, a sell refuses to pay less. Raises price_changed,
-- card_missing, card_off, card_not_held or 'insufficient coins' (from the wallet).
CREATE OR REPLACE FUNCTION legacy_x.card_trade(p_user uuid, p_card text, p_side text, p_limit integer)
RETURNS TABLE (price integer, held integer, qty integer, balance integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = legacy_x, public AS $$
DECLARE
  c legacy_x.cards%ROWTYPE;
  v_price integer;
  v_qty integer;
  v_balance integer;
BEGIN
  SELECT * INTO c FROM legacy_x.cards WHERE id = p_card FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'card_missing' USING ERRCODE = 'P0001'; END IF;
  IF p_side = 'buy' THEN
    IF NOT c.enabled THEN RAISE EXCEPTION 'card_off' USING ERRCODE = 'P0001'; END IF;
    v_price := legacy_x.card_price(c.base_price, c.held);
    IF v_price > p_limit THEN RAISE EXCEPTION 'price_changed' USING ERRCODE = 'P0001'; END IF;
    SELECT w.new_balance INTO v_balance FROM legacy_x.wallet_apply(p_user, -v_price, 'spend', 'Card: ' || c.name, NULL, p_user) w;
    INSERT INTO legacy_x.card_owned (user_id, card_id, qty) VALUES (p_user, c.id, 1)
      ON CONFLICT (user_id, card_id) DO UPDATE SET qty = legacy_x.card_owned.qty + 1;
    UPDATE legacy_x.cards SET held = c.held + 1 WHERE id = c.id;
    c.held := c.held + 1;
  ELSIF p_side = 'sell' THEN
    SELECT o.qty INTO v_qty FROM legacy_x.card_owned o WHERE o.user_id = p_user AND o.card_id = c.id FOR UPDATE;
    IF v_qty IS NULL THEN RAISE EXCEPTION 'card_not_held' USING ERRCODE = 'P0001'; END IF;
    v_price := floor(0.9 * legacy_x.card_price(c.base_price, c.held - 1))::integer;
    IF v_price < p_limit THEN RAISE EXCEPTION 'price_changed' USING ERRCODE = 'P0001'; END IF;
    IF v_price < 1 THEN v_price := 1; END IF;
    SELECT w.new_balance INTO v_balance FROM legacy_x.wallet_apply(p_user, v_price, 'grant', 'Card sold: ' || c.name, NULL, p_user) w;
    IF v_qty = 1 THEN DELETE FROM legacy_x.card_owned WHERE user_id = p_user AND card_id = c.id;
    ELSE UPDATE legacy_x.card_owned SET qty = v_qty - 1 WHERE user_id = p_user AND card_id = c.id; END IF;
    UPDATE legacy_x.cards SET held = c.held - 1 WHERE id = c.id;
    c.held := c.held - 1;
    v_qty := v_qty - 1;
  ELSE
    RAISE EXCEPTION 'bad side' USING ERRCODE = '22023';
  END IF;
  INSERT INTO legacy_x.card_trades (user_id, card_id, side, price, held_after) VALUES (p_user, c.id, p_side, v_price, c.held);
  IF p_side = 'buy' THEN SELECT o.qty INTO v_qty FROM legacy_x.card_owned o WHERE o.user_id = p_user AND o.card_id = c.id; END IF;
  RETURN QUERY SELECT v_price, c.held, COALESCE(v_qty, 0), v_balance;
END $$;
REVOKE ALL ON FUNCTION legacy_x.card_trade(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.card_trade(uuid, text, text, integer) TO service_role;

-- One card per CS2 map (the site draws the map's own artwork). Rarity ladder: standard < select < elite < prime < apex.
INSERT INTO legacy_x.cards (id, name, map_key, rarity, base_price, sort) VALUES
  ('dust2', 'Dust II', 'de_dust2', 'standard', 60, 10),
  ('mirage', 'Mirage', 'de_mirage', 'standard', 60, 20),
  ('inferno', 'Inferno', 'de_inferno', 'select', 120, 30),
  ('cache', 'Cache', 'de_cache', 'select', 120, 40),
  ('train', 'Train', 'de_train', 'select', 120, 50),
  ('overpass', 'Overpass', 'de_overpass', 'elite', 250, 60),
  ('nuke', 'Nuke', 'de_nuke', 'elite', 250, 70),
  ('vertigo', 'Vertigo', 'de_vertigo', 'prime', 500, 80),
  ('ancient', 'Ancient', 'de_ancient', 'prime', 500, 90),
  ('anubis', 'Anubis', 'de_anubis', 'apex', 1000, 100)
ON CONFLICT (id) DO NOTHING;

COMMIT;
NOTIFY pgrst, 'reload schema';
