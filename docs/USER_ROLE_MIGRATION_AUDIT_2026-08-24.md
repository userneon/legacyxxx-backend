# Users Role Migration Audit — 2026-08-24

> Scope: retire the legacy `legacy_x.users.is_staff` boolean only after moving all authorization consumers to the canonical role field. This is a data-preserving migration; no user row is deleted.

## Production evidence

The live role distribution contains one `Owner` with `is_staff = true`, one `Manager` with `is_staff = true`, and five `Player` rows with `is_staff = false`. There are no null or unsupported role values in the observed aggregate.

The production `users.role` column is already `NOT NULL`, defaults to `Player`, and has the `users_role_allowed` constraint. Its exact allowed values are `Owner`, `Founder`, `Manager`, `Admin`, `Player`, `Designer`, and `Developer`.

The only database function/view dependency found for `is_staff` is `legacy_x.sync_users_staff_from_role`, reached through the `users_sync_staff_from_role` trigger. The users table also has an unrelated `trg_users_updated_at` trigger which must remain in place.

## Safe retirement sequence

First remove all Root API reads of `is_staff` and derive staff authorization from the canonical role list. Then drop only the staff-sync trigger/function and the `is_staff` column. The approved role constraint/default and the timestamp trigger remain untouched. This preserves all existing Owner, Manager, and Player assignments exactly as recorded.
