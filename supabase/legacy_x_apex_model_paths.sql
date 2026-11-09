-- The two Apex knives keep their own Workshop paths (weapons/bluesen/...). Their rows still pointed at models/abluesen/..., from the time the files were
-- moved into models/, so a game that wore one drew the red ERROR model. Run once; already run on the live database on 2026-11-09.
update legacy_x.weapon_models
set world_model = replace(world_model, 'models/abluesen/apex/', 'weapons/bluesen/apex/'),
    view_model = replace(view_model, 'models/abluesen/apex/', 'weapons/bluesen/apex/')
where item_id in ('apex-balisong', 'apex-karambit')
  and world_model like 'models/abluesen/apex/%';
