-- Every clan gets a short number in the order clans were opened (the first clan is 1), so its page address is /clans/1.
-- The long id stays the key everywhere else; both work in the API. Safe to re-run.
ALTER TABLE legacy_x.clans ADD COLUMN IF NOT EXISTS number integer;

UPDATE legacy_x.clans c
   SET number = n.rn
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM legacy_x.clans) n
 WHERE c.id = n.id AND c.number IS NULL;

CREATE SEQUENCE IF NOT EXISTS legacy_x.clans_number_seq OWNED BY legacy_x.clans.number;
SELECT setval('legacy_x.clans_number_seq', COALESCE((SELECT max(number) FROM legacy_x.clans), 0) + 1, false);
ALTER TABLE legacy_x.clans ALTER COLUMN number SET DEFAULT nextval('legacy_x.clans_number_seq');
ALTER TABLE legacy_x.clans ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clans_number_key ON legacy_x.clans (number);
GRANT USAGE, SELECT ON SEQUENCE legacy_x.clans_number_seq TO service_role;
