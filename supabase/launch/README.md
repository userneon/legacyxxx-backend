# Launch database checklist

Checked on 2026-10-10 against the production project.

**Production is up to date.** Every table the migrations in `supabase/` create exists in production, with one exception: `products` (created by
`legacy_x_admin_system.sql`). Nothing needs to be run on production before the launch for the migrations' sake.

## Files

- `all_migrations_in_order.sql`: all 80 migrations in the order they were first added, in one file. **Not for production** (some files retire or drop
  things). Use it only to build a new, empty database.
- The migrations are incremental. The first tables of the platform (`users`, `penalties`, `matches`, `clans`, `tournaments`, `feedback`, `player_stats`,
  `user_sessions`, `game_servers`, `maps` ... 29 tables) are created by no file in this repo. To build a new database, first restore a **schema-only dump of
  production** (`supabase db dump --schema legacy_x` or `pg_dump --schema-only --schema=legacy_x`), then run `all_migrations_in_order.sql` on top.
  Better still: commit that dump as `supabase/launch/00_base_schema.sql`, so the repo can rebuild the database by itself.

## Before the launch

1. Take a backup (Supabase dashboard, Database, Backups), and **try restoring it** into a scratch project once.
2. Commit the schema-only dump (see above).
3. Remove the test accounts (8 users at the last count) and their rows: checks, wallets, clans, cosmetics.
4. `products` is missing: if the Owner products feature is meant to exist, run the `products` part of `legacy_x_admin_system.sql`; if not, ignore it.
