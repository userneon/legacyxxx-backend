-- Admin levels (owner request 2026-11-07): an Admin is Admin (3 extra commands), High Admin (5) or +Admin (10). The Owner picks the extra
-- commands per Admin in Staff -> Team; the API checks the count and that each command may be granted (server/legacyX/adminLevels.ts).
ALTER TABLE legacy_x.staff ADD COLUMN IF NOT EXISTS admin_level text NOT NULL DEFAULT 'admin';
ALTER TABLE legacy_x.staff ADD COLUMN IF NOT EXISTS extra_commands text[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  ALTER TABLE legacy_x.staff ADD CONSTRAINT staff_admin_level_check CHECK (admin_level IN ('admin', 'high', 'plus'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
