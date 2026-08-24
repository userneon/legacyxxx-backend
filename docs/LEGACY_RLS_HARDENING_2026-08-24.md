# LEGACY-X Legacy Table RLS Hardening — 2026-08-24

## Decision

LEGACY-X frontend нь Supabase client ашигладаггүй. Browser нь зөвхөн `api.legacyx.cc` Root API-тай холбогдож, Root API нь server-side `SUPABASE_SERVICE_ROLE_KEY` ашигладаг. Иймээс legacy business table-д `anon` болон `authenticated` role-д шууд read/write policy өгөх шаардлага байхгүй.

Production audit-аар `anon` болон `authenticated` role нь энэ 24 table дээр effective `SELECT`, `INSERT`, `UPDATE` privilege-гүй болох нь батлагдсан. Гэхдээ RLS disabled байсан нь defense-in-depth сулрал байсан тул RLS-г асааж, direct browser role access-ийг explicit revoke хийнэ.

| Access path | RLS hardening-ийн дараах эрх |
|---|---|
| Browser / `anon` | Legacy business table руу шууд access байхгүй |
| Browser / `authenticated` | Legacy business table руу шууд access байхгүй |
| Root API / `service_role` | Existing server-side access хэвээр; production role audit-аар `BYPASSRLS = true` батлагдсан |
| Plugin | Database руу шууд access байхгүй; Root API-ийн scoped token endpoint ашиглана |

## Scope

`legacy_x_legacy_rls_hardening.sql` нь дараах legacy table-ууд дээр data устгахгүйгээр RLS enable хийнэ: users, sessions, links, player stats, maps, game servers, matches, favorites, clans, tournament/store/wallet/moderation/feedback, API tokens, community content, audit logs.

Энэ migration нь **public policy** үүсгэхгүй. Дараа нь frontend-д шууд Supabase query нэмэх шаардлага гарвал тусдаа feature review хийгээд зөвхөн хэрэгтэй table/action-д narrowly scoped policy нэмнэ.

## Validation

1. Root API source болон frontend source-д direct Supabase client байхгүйг шалгасан.
2. Production `anon`/`authenticated` effective privilege-ийг read-only SQL-аар шалгасан.
3. Production `service_role`-ийн `rolbypassrls` нь `true` болохыг read-only SQL-аар шалгасан.
4. Migration apply-ийн дараа 24 table бүгд `rls_enabled = true`, browser role privilege байхгүй, service-role privilege байгаа эсэхийг query-ээр дахин шалгана.

## Applied Production Result

`legacy_x_legacy_rls_hardening` migration нь 2026-08-24-нд Legacy-X production Supabase project (`htfkfkykvrxyrprrlkwq`) дээр амжилттай apply болсон. Read-only post-check-ээр 24/24 table дээр `rls_enabled = true`, `anon_select = false`, `authenticated_select = false`, `service_role_select = true` болохыг баталсан. Data delete, data rewrite, column/table drop хийгээгүй.

Security advisor одоо `RLS Enabled No Policy` гэсэн **INFO** notice харуулж болно. Энэ нь энэ architecture-д expected: browser role-уудад table privilege болон policy байхгүй, Root API-ийн server-side service role л access-тэй. Үүнийг browser-д permissive policy нэмж "арилгах" нь хамгаалалтыг сулруулах тул хийгээгүй.

> Supabase-ийн дагуу exposed schema-д байрлах table бүр дээр RLS идэвхтэй байх ёстой. Service key нь RLS-г bypass хийдэг тул key browser-д хэзээ ч гарч болохгүй. [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
