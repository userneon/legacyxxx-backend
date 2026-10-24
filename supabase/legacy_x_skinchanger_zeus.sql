-- The Zeus x27 is a skinnable weapon (2026-10-24): the catalog page lists base weapons of the Equipment group too.
-- Run after legacy_x_skinchanger_catalog_fast_path.sql. Safe to re-run: it patches the live function in place.
do $$
declare def text;
begin
  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'legacy_x' and p.proname = 'get_skinchanger_catalog_page';
  if def is null then raise exception 'get_skinchanger_catalog_page not found'; end if;
  if position($q$'Rifles', 'Heavy', 'Equipment'$q$ in def) = 0 then
    def := replace(def, $q$'Rifles', 'Heavy')$q$, $q$'Rifles', 'Heavy', 'Equipment')$q$);
    execute def;
  end if;
end $$;

insert into legacy_x.skinchanger_catalog_items (external_key, category, weapon_class, display_name, weapon_defindex, image_key, metadata, is_active)
select 'cs2:weapon:base_weapon-weapon_taser', 'weapon', 'Zeus x27', 'Zeus x27', 31,
  'https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJKz2lu_XuWbwcuyMESA4Fdl-4nnpU7iQA3-kKn0_DFe_bz6PKI4caTCDzHCwrkj57U6FnHik0l04mXVw4yhJCiRaVImW8dzTeRcrFDmxd8qNG47',
  '{"team":null,"rarity":null,"source":"bymykel-csgo-api","maxWear":null,"minWear":null,"sourceId":"base_weapon-weapon_taser","baseModel":false,"weaponGroup":"Equipment"}'::jsonb, true
where not exists (select 1 from legacy_x.skinchanger_catalog_items where external_key = 'cs2:weapon:base_weapon-weapon_taser');
