-- Every shared skin collection gets a short number in the order they were shared (the first is 1), so its page is /skinchanger/collections/1.
-- The long id stays the key everywhere else; both work in the API. Safe to re-run.
ALTER TABLE legacy_x.skin_collections ADD COLUMN IF NOT EXISTS number integer;

UPDATE legacy_x.skin_collections c
   SET number = n.rn
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM legacy_x.skin_collections) n
 WHERE c.id = n.id AND c.number IS NULL;

CREATE SEQUENCE IF NOT EXISTS legacy_x.skin_collections_number_seq OWNED BY legacy_x.skin_collections.number;
SELECT setval('legacy_x.skin_collections_number_seq', COALESCE((SELECT max(number) FROM legacy_x.skin_collections), 0) + 1, false);
ALTER TABLE legacy_x.skin_collections ALTER COLUMN number SET DEFAULT nextval('legacy_x.skin_collections_number_seq');
ALTER TABLE legacy_x.skin_collections ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS skin_collections_number_key ON legacy_x.skin_collections (number);
GRANT USAGE, SELECT ON SEQUENCE legacy_x.skin_collections_number_seq TO service_role;
