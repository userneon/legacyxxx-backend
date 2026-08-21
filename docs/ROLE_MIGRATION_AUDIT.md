# LEGACY-X Role Migration and Security Audit

**Production project:** `htfkfkykvrxyrprrlkwq`  
**Audit date:** 2026-08-21

## Confirmed Role Migration State

The production `legacy_x.users` table now has a non-null `role` field constrained to `Owner`, `Founder`, `Manager`, `Admin`, `Player`, `Designer`, and `Developer`. Every Steam-authenticated user defaults to `Player`; elevated roles are assigned only through an explicit manual update. A database trigger derives legacy `is_staff` from `role <> 'Player'` during the compatibility period.

| Role | Legacy `is_staff` | Current users |
|---|---:|---:|
| Player | false | All current Steam-authenticated users after the Player-default migration |

The application source now treats `role` as canonical and preserves `is_staff` only for compatibility with existing consumers and access tokens.

## Security Findings Requiring a Separate Controlled Migration

> **Do not blindly enable RLS.** Enabling RLS without service-role access confirmation and policies would break Root API, AdminPlus, plugin ingestion, and existing public reads.

The Supabase table audit reported that direct `legacy_x` business tables, including `users`, `wallet_transactions`, `penalties`, `feedback`, `api_tokens`, and other core tables, currently have RLS disabled. If an anon/publishable key is exposed to a client with direct schema access, this can expose tables outside the Root API boundary.

The security advisor also reported RLS-enabled internal tables with no policies, mutable `search_path` warnings on legacy functions, and anon-executable `SECURITY DEFINER` RPCs including wallet, clan, link, rank, and plugin ingestion procedures. These need an explicit, staged hardening plan: inventory public RPCs, revoke anon execution for non-public functions, set function search paths, then enable RLS with service-role-safe policies.

| Finding | Status | Recommended next action |
|---|---|---|
| `users.role` migration | Applied | Deploy Root API and frontend changes, then assign staff roles intentionally. |
| Direct business tables lack RLS | Open / high priority | Design and apply table-specific RLS policies without interrupting Root API service-role calls. |
| RLS-enabled internal tables have no policies | Open | Confirm they are intended service-role-only tables; add narrow policies only when client access is required. |
| Anonymous `SECURITY DEFINER` RPCs | Open / high priority | Revoke anon execution from non-public mutation and ingestion functions. |
| Mutable function `search_path` warnings | Open | Recreate flagged functions with explicit `SET search_path`. |

## Sources

1. [Supabase Row Level Security documentation](https://supabase.com/docs/guides/database/postgres/row-level-security)
2. [Supabase database linter: RLS enabled with no policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
3. [Supabase database linter: mutable function search path](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)
4. [Supabase database linter: public SECURITY DEFINER function](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)
