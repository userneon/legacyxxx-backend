/** Owner management: staff & roles, products, announcements, website config and the name filter. */
import { Router } from "express";
import { z } from "zod";
import { apiError, asyncRoute } from "../http";
import { legacyXDb, legacyXError } from "../supabase";
import { adminAnyRoute, adminRoute, enforce, loadPrincipalBySteamId, requireReauth, steamIdPattern, writeAudit } from "./context";
import { invalidateNameFilters } from "./names";
import { checkAssignRole, checkEditRoleImmunity, checkEditRolePermissions, checkRevokeRole, type RoleSummary } from "./permissions";
import { userCards } from "./players";

type DbRow = Record<string, any>;
const db = () => legacyXDb();

const steamId = z.string().regex(steamIdPattern, "SteamID64 is required");
const uuid = z.string().uuid();
const roleId = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
const confirmSchema = z.string().trim().min(1).max(64);

async function loadRole(id: string): Promise<RoleSummary & { permissions: Set<string> }> {
  const { data, error } = await db().from("roles").select("id,name,immunity,is_locked,role_permissions(permission_key)").eq("id", id).maybeSingle();
  legacyXError(error, "Unable to load the role");
  if (!data) apiError(404, "Role was not found");
  return {
    id: data.id, name: data.name, immunity: Number(data.immunity), isLocked: data.is_locked === true,
    permissions: new Set(((data.role_permissions ?? []) as DbRow[]).map(row => String(row.permission_key))),
  };
}

function requireConfirm(typed: string, expected: string, what: string) {
  if (typed.trim().toLowerCase() !== expected.trim().toLowerCase()) apiError(400, `Type the ${what} to confirm`);
}

export function createManagementRouter() {
  const router = Router();

  /* -------------------------------------------------------------------------
   * Staff & roles (re-authentication required for every change)
   * ---------------------------------------------------------------------- */

  router.get("/admin/roles", adminAnyRoute(["roles.assign", "roles.revoke", "roles.permissions.edit", "roles.immunity.edit"], async (_req, res) => {
    const [roles, permissions, members] = await Promise.all([
      db().from("roles").select("id,name,immunity,is_locked,role_permissions(permission_key)").order("immunity", { ascending: false }),
      db().from("permissions").select("key,description,owner_only").order("key"),
      db().from("user_roles").select("user_id,role_id,granted_at,granted_by"),
    ]);
    legacyXError(roles.error || permissions.error || members.error, "Unable to load roles");
    const memberRows = (members.data ?? []) as DbRow[];
    const people = await userCards(memberRows.flatMap(row => [row.user_id, row.granted_by]));
    res.json({
      roles: ((roles.data ?? []) as DbRow[]).map(role => ({
        id: role.id, name: role.name, immunity: role.immunity, isLocked: role.is_locked,
        permissions: ((role.role_permissions ?? []) as DbRow[]).map(row => row.permission_key).sort(),
        members: memberRows.filter(row => row.role_id === role.id).map(row => ({ ...people.get(row.user_id), grantedAt: row.granted_at, grantedBy: people.get(row.granted_by) ?? null })),
      })),
      permissions: (permissions.data ?? []).map((row: DbRow) => ({ key: row.key, description: row.description, ownerOnly: row.owner_only })),
    });
  }));

  router.post("/admin/roles/:roleId/members", adminRoute("roles.assign", async (req, res, actor) => {
    await requireReauth(req, actor);
    const role = await loadRole(roleId.parse(req.params.roleId));
    const input = z.object({ steamId, confirm: confirmSchema }).strict().parse(req.body);
    requireConfirm(input.confirm, role.name, "role name");
    const target = await loadPrincipalBySteamId(input.steamId);
    if (!target.userId) apiError(404, "That player has not signed in on the website yet");
    enforce(checkAssignRole(actor, role, target.immunity));
    const before = target.roles.map(held => held.id);
    const { error } = await db().from("user_roles").insert({ user_id: target.userId, role_id: role.id, granted_by: actor.userId });
    if (error?.code === "23505") apiError(409, "The player already has this role");
    legacyXError(error, "Unable to assign the role");
    await writeAudit(actor, { action: "roles.assign", targetType: "user", targetId: target.userId, targetSteamId: input.steamId, before: { roles: before }, after: { roles: [...before, role.id] }, metadata: { role: role.id } });
    res.status(201).json({ ok: true });
  }));

  router.post("/admin/roles/:roleId/members/:steamId/remove", adminRoute("roles.revoke", async (req, res, actor) => {
    await requireReauth(req, actor);
    const role = await loadRole(roleId.parse(req.params.roleId));
    const { confirm } = z.object({ confirm: confirmSchema }).strict().parse(req.body);
    requireConfirm(confirm, role.name, "role name");
    const target = await loadPrincipalBySteamId(steamId.parse(req.params.steamId));
    if (!target.roles.some(held => held.id === role.id)) apiError(404, "The player does not have this role");
    enforce(checkRevokeRole(actor, role, { userId: target.userId, immunity: target.immunity }));
    const { error } = await db().from("user_roles").delete().eq("user_id", target.userId).eq("role_id", role.id);
    legacyXError(error, "Unable to remove the role");
    const before = target.roles.map(held => held.id);
    await writeAudit(actor, { action: "roles.revoke", targetType: "user", targetId: target.userId, targetSteamId: target.steamId, before: { roles: before }, after: { roles: before.filter(id => id !== role.id) }, metadata: { role: role.id } });
    res.json({ ok: true });
  }));

  router.put("/admin/roles/:roleId/permissions", adminRoute("roles.permissions.edit", async (req, res, actor) => {
    await requireReauth(req, actor);
    const role = await loadRole(roleId.parse(req.params.roleId));
    const input = z.object({ permissions: z.array(z.string().max(64)).max(100), confirm: confirmSchema }).strict().parse(req.body);
    requireConfirm(input.confirm, role.name, "role name");
    const { data: catalogue, error: catalogueError } = await db().from("permissions").select("key,owner_only");
    legacyXError(catalogueError, "Unable to load permissions");
    const known = new Set(((catalogue ?? []) as DbRow[]).map(row => row.key));
    const ownerOnly = new Set(((catalogue ?? []) as DbRow[]).filter(row => row.owner_only).map(row => row.key));
    const next = new Set(input.permissions);
    for (const key of next) if (!known.has(key)) apiError(400, `Unknown permission ${key}`);
    enforce(checkEditRolePermissions(actor, role, role.permissions, next, ownerOnly));
    const added = [...next].filter(key => !role.permissions.has(key));
    const removed = [...role.permissions].filter(key => !next.has(key));
    if (added.length) {
      const { error } = await db().from("role_permissions").insert(added.map(key => ({ role_id: role.id, permission_key: key })));
      legacyXError(error, "Unable to add permissions");
    }
    if (removed.length) {
      const { error } = await db().from("role_permissions").delete().eq("role_id", role.id).in("permission_key", removed);
      legacyXError(error, "Unable to remove permissions");
    }
    await writeAudit(actor, { action: "roles.permissions.edit", targetType: "role", targetId: role.id, before: { permissions: [...role.permissions].sort() }, after: { permissions: [...next].sort() }, metadata: { added, removed } });
    res.json({ ok: true, added, removed });
  }));

  router.put("/admin/roles/:roleId/immunity", adminRoute("roles.immunity.edit", async (req, res, actor) => {
    await requireReauth(req, actor);
    const role = await loadRole(roleId.parse(req.params.roleId));
    const input = z.object({ immunity: z.number().int(), confirm: confirmSchema }).strict().parse(req.body);
    requireConfirm(input.confirm, role.name, "role name");
    enforce(checkEditRoleImmunity(actor, role, input.immunity));
    const { error } = await db().from("roles").update({ immunity: input.immunity }).eq("id", role.id);
    legacyXError(error, "Unable to change immunity");
    await writeAudit(actor, { action: "roles.immunity.edit", targetType: "role", targetId: role.id, before: { immunity: role.immunity }, after: { immunity: input.immunity } });
    res.json({ ok: true });
  }));

  /* -------------------------------------------------------------------------
   * Products (catalogue only: no purchase flow exists)
   * ---------------------------------------------------------------------- */

  const productInput = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    priceMnt: z.number().int().min(0).max(100_000_000),
    isActive: z.boolean().default(false),
    sortOrder: z.number().int().min(-1000).max(1000).default(0),
  }).strict();
  const mapProduct = (row: DbRow) => ({ id: row.id, name: row.name, description: row.description, priceMnt: row.price_mnt, isActive: row.is_active, sortOrder: row.sort_order, updatedAt: row.updated_at });
  const productRow = (input: Partial<z.infer<typeof productInput>>) => {
    const row: Record<string, unknown> = {};
    if (input.name !== undefined) row.name = input.name;
    if (input.description !== undefined) row.description = input.description;
    if (input.priceMnt !== undefined) row.price_mnt = input.priceMnt;
    if (input.isActive !== undefined) row.is_active = input.isActive;
    if (input.sortOrder !== undefined) row.sort_order = input.sortOrder;
    return row;
  };

  router.get("/admin/products", adminRoute("products.view", async (_req, res) => {
    const { data, error } = await db().from("products").select("*").order("sort_order").order("name");
    legacyXError(error, "Unable to load products");
    res.json({ items: ((data ?? []) as DbRow[]).map(mapProduct) });
  }));
  router.post("/admin/products", adminRoute("products.create", async (req, res, actor) => {
    const input = productInput.parse(req.body);
    const { data, error } = await db().from("products").insert({ ...productRow(input), created_by: actor.userId }).select("*").single();
    legacyXError(error, "Unable to create the product");
    await writeAudit(actor, { action: "products.create", targetType: "product", targetId: data.id, after: mapProduct(data) });
    res.status(201).json(mapProduct(data));
  }));
  router.patch("/admin/products/:id", adminRoute("products.update", async (req, res, actor) => {
    const id = uuid.parse(req.params.id);
    const input = productInput.partial().parse(req.body);
    const { data: before } = await db().from("products").select("*").eq("id", id).maybeSingle();
    if (!before) apiError(404, "Product was not found");
    const { data, error } = await db().from("products").update(productRow(input)).eq("id", id).select("*").single();
    legacyXError(error, "Unable to update the product");
    await writeAudit(actor, { action: "products.update", targetType: "product", targetId: id, before: mapProduct(before), after: mapProduct(data) });
    res.json(mapProduct(data));
  }));
  router.delete("/admin/products/:id", adminRoute("products.delete", async (req, res, actor) => {
    const id = uuid.parse(req.params.id);
    const { data, error } = await db().from("products").delete().eq("id", id).select("*").maybeSingle();
    legacyXError(error, "Unable to delete the product");
    if (!data) apiError(404, "Product was not found");
    await writeAudit(actor, { action: "products.delete", targetType: "product", targetId: id, before: mapProduct(data) });
    res.json({ ok: true });
  }));

  /* -------------------------------------------------------------------------
   * Announcements (web and in-game)
   * ---------------------------------------------------------------------- */

  const announcementInput = z.object({
    channel: z.enum(["web", "ingame"]),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(1000),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    isActive: z.boolean().default(true),
  }).strict();
  const channelPermission = (channel: string) => (channel === "web" ? "announce.web" : "announce.ingame");
  const mapAnnouncement = (row: DbRow) => ({ id: row.id, channel: row.channel, title: row.title, body: row.body, startsAt: row.starts_at, endsAt: row.ends_at, isActive: row.is_active, createdAt: row.created_at });

  router.get("/admin/announcements", adminAnyRoute(["announce.web", "announce.ingame"], async (_req, res) => {
    const { data, error } = await db().from("announcements").select("*").order("created_at", { ascending: false }).limit(100);
    legacyXError(error, "Unable to load announcements");
    res.json({ items: ((data ?? []) as DbRow[]).map(mapAnnouncement) });
  }));
  router.post("/admin/announcements", adminAnyRoute(["announce.web", "announce.ingame"], async (req, res, actor) => {
    const input = announcementInput.parse(req.body);
    if (!actor.permissions.has(channelPermission(input.channel))) apiError(403, `Missing permission ${channelPermission(input.channel)}`);
    const { data, error } = await db().from("announcements").insert({
      channel: input.channel, title: input.title, body: input.body, starts_at: input.startsAt ?? new Date().toISOString(), ends_at: input.endsAt ?? null, is_active: input.isActive, created_by: actor.userId,
    }).select("*").single();
    legacyXError(error, "Unable to publish the announcement");
    await writeAudit(actor, { action: channelPermission(input.channel), targetType: "announcement", targetId: data.id, after: mapAnnouncement(data) });
    res.status(201).json(mapAnnouncement(data));
  }));
  router.patch("/admin/announcements/:id", adminAnyRoute(["announce.web", "announce.ingame"], async (req, res, actor) => {
    const id = uuid.parse(req.params.id);
    const input = announcementInput.omit({ channel: true }).partial().parse(req.body);
    const { data: before } = await db().from("announcements").select("*").eq("id", id).maybeSingle();
    if (!before) apiError(404, "Announcement was not found");
    if (!actor.permissions.has(channelPermission(before.channel))) apiError(403, `Missing permission ${channelPermission(before.channel)}`);
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.body !== undefined) patch.body = input.body;
    if (input.startsAt !== undefined) patch.starts_at = input.startsAt;
    if (input.endsAt !== undefined) patch.ends_at = input.endsAt;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    const { data, error } = await db().from("announcements").update(patch).eq("id", id).select("*").single();
    legacyXError(error, "Unable to update the announcement");
    await writeAudit(actor, { action: `${channelPermission(before.channel)}.update`, targetType: "announcement", targetId: id, before: mapAnnouncement(before), after: mapAnnouncement(data) });
    res.json(mapAnnouncement(data));
  }));
  router.delete("/admin/announcements/:id", adminAnyRoute(["announce.web", "announce.ingame"], async (req, res, actor) => {
    const id = uuid.parse(req.params.id);
    const { data: before } = await db().from("announcements").select("*").eq("id", id).maybeSingle();
    if (!before) apiError(404, "Announcement was not found");
    if (!actor.permissions.has(channelPermission(before.channel))) apiError(403, `Missing permission ${channelPermission(before.channel)}`);
    const { error } = await db().from("announcements").delete().eq("id", id);
    legacyXError(error, "Unable to delete the announcement");
    await writeAudit(actor, { action: `${channelPermission(before.channel)}.delete`, targetType: "announcement", targetId: id, before: mapAnnouncement(before) });
    res.json({ ok: true });
  }));

  /** Public: active website announcements. */
  router.get("/announcements", asyncRoute(async (_req, res) => {
    const now = new Date().toISOString();
    const { data, error } = await db().from("announcements").select("id,title,body,starts_at,ends_at")
      .eq("channel", "web").eq("is_active", true).lte("starts_at", now).or(`ends_at.is.null,ends_at.gt.${now}`).order("starts_at", { ascending: false }).limit(5);
    legacyXError(error, "Unable to load announcements");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ items: ((data ?? []) as DbRow[]).map(row => ({ id: row.id, title: row.title, body: row.body, startsAt: row.starts_at, endsAt: row.ends_at })) });
  }));

  /* -------------------------------------------------------------------------
   * Website config: append-only versions with rollback
   * ---------------------------------------------------------------------- */

  const siteConfigSchema = z.record(z.string().max(64), z.unknown()).refine(value => JSON.stringify(value).length <= 50_000, "Config is too large");

  async function latestVersion() {
    const { data, error } = await db().from("site_config").select("*").order("version", { ascending: false }).limit(1).maybeSingle();
    legacyXError(error, "Unable to load site config");
    return data as DbRow | null;
  }

  router.get("/site-config", asyncRoute(async (_req, res) => {
    const current = await latestVersion();
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ version: current?.version ?? 0, config: current?.config ?? {} });
  }));

  router.get("/admin/site-config", adminRoute("site.customize", async (_req, res) => {
    const { data, error } = await db().from("site_config").select("version,config,note,rolled_back_from,created_by,created_at").order("version", { ascending: false }).limit(50);
    legacyXError(error, "Unable to load site config history");
    const rows = (data ?? []) as DbRow[];
    const people = await userCards(rows.map(row => row.created_by));
    res.json({
      current: rows[0] ? { version: rows[0].version, config: rows[0].config } : { version: 0, config: {} },
      versions: rows.map(row => ({ version: row.version, note: row.note, rolledBackFrom: row.rolled_back_from, createdBy: people.get(row.created_by) ?? null, createdAt: row.created_at })),
    });
  }));

  router.post("/admin/site-config", adminRoute("site.customize", async (req, res, actor) => {
    const input = z.object({ config: siteConfigSchema, note: z.string().trim().max(240).optional(), baseVersion: z.number().int().min(0) }).strict().parse(req.body);
    const current = await latestVersion();
    const currentVersion = current?.version ?? 0;
    if (input.baseVersion !== currentVersion) apiError(409, "The configuration changed since you loaded it; reload and try again");
    const { data, error } = await db().from("site_config").insert({ version: currentVersion + 1, config: input.config, note: input.note ?? null, created_by: actor.userId }).select("version").single();
    legacyXError(error, "Unable to save the configuration");
    await writeAudit(actor, { action: "site.customize", targetType: "site_config", targetId: String(data!.version), before: current?.config ?? null, after: input.config, metadata: { note: input.note ?? null } });
    res.status(201).json({ version: data!.version });
  }));

  router.post("/admin/site-config/:version/rollback", adminRoute("site.customize", async (req, res, actor) => {
    const version = z.coerce.number().int().min(1).parse(req.params.version);
    const { data: target, error } = await db().from("site_config").select("version,config").eq("version", version).maybeSingle();
    legacyXError(error, "Unable to load that version");
    if (!target) apiError(404, "Version was not found");
    const current = await latestVersion();
    const next = (current?.version ?? 0) + 1;
    const { error: insertError } = await db().from("site_config").insert({ version: next, config: target.config, note: `Rollback to v${version}`, rolled_back_from: version, created_by: actor.userId });
    legacyXError(insertError, "Unable to roll back");
    await writeAudit(actor, { action: "site.rollback", targetType: "site_config", targetId: String(next), before: current?.config ?? null, after: target.config, metadata: { rolledBackFrom: version } });
    res.status(201).json({ version: next });
  }));

  /* -------------------------------------------------------------------------
   * Name filter
   * ---------------------------------------------------------------------- */

  const filterInput = z.object({
    pattern: z.string().trim().min(1).max(120),
    matchType: z.enum(["exact", "contains", "regex"]).default("contains"),
    action: z.enum(["flag", "block"]).default("flag"),
    note: z.string().trim().max(240).nullable().optional(),
    isActive: z.boolean().default(true),
  }).strict().superRefine((value, ctx) => {
    if (value.matchType !== "regex") return;
    try { new RegExp(value.pattern); } catch { ctx.addIssue({ code: "custom", message: "Invalid regular expression" }); }
  });
  const mapFilter = (row: DbRow) => ({ id: row.id, pattern: row.pattern, matchType: row.match_type, action: row.action, note: row.note, isActive: row.is_active, updatedAt: row.updated_at });

  router.get("/admin/name-filters", adminRoute("name_filter.manage", async (_req, res) => {
    const { data, error } = await db().from("name_filters").select("*").order("created_at", { ascending: false });
    legacyXError(error, "Unable to load the name filter");
    res.json({ items: ((data ?? []) as DbRow[]).map(mapFilter) });
  }));
  router.post("/admin/name-filters", adminRoute("name_filter.manage", async (req, res, actor) => {
    const input = filterInput.parse(req.body);
    const { data, error } = await db().from("name_filters").insert({ pattern: input.pattern, match_type: input.matchType, action: input.action, note: input.note ?? null, is_active: input.isActive, created_by: actor.userId }).select("*").single();
    legacyXError(error, "Unable to add the filter");
    invalidateNameFilters();
    await writeAudit(actor, { action: "name_filter.create", targetType: "name_filter", targetId: data.id, after: mapFilter(data) });
    res.status(201).json(mapFilter(data));
  }));
  router.patch("/admin/name-filters/:id", adminRoute("name_filter.manage", async (req, res, actor) => {
    const id = uuid.parse(req.params.id);
    const input = z.object({ isActive: z.boolean().optional(), action: z.enum(["flag", "block"]).optional(), note: z.string().trim().max(240).nullable().optional() }).strict().parse(req.body);
    const { data: before } = await db().from("name_filters").select("*").eq("id", id).maybeSingle();
    if (!before) apiError(404, "Filter was not found");
    const patch: Record<string, unknown> = {};
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    if (input.action !== undefined) patch.action = input.action;
    if (input.note !== undefined) patch.note = input.note;
    const { data, error } = await db().from("name_filters").update(patch).eq("id", id).select("*").single();
    legacyXError(error, "Unable to update the filter");
    invalidateNameFilters();
    await writeAudit(actor, { action: "name_filter.update", targetType: "name_filter", targetId: id, before: mapFilter(before), after: mapFilter(data) });
    res.json(mapFilter(data));
  }));
  router.delete("/admin/name-filters/:id", adminRoute("name_filter.manage", async (req, res, actor) => {
    const id = uuid.parse(req.params.id);
    const { data, error } = await db().from("name_filters").delete().eq("id", id).select("*").maybeSingle();
    legacyXError(error, "Unable to delete the filter");
    if (!data) apiError(404, "Filter was not found");
    invalidateNameFilters();
    await writeAudit(actor, { action: "name_filter.delete", targetType: "name_filter", targetId: id, before: mapFilter(data) });
    res.json({ ok: true });
  }));

  return router;
}
