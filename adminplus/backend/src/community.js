const { value } = require('./config')

function headers() {
  const serviceRoleKey = value('SUPABASE_SERVICE_ROLE_KEY')
  const schema = value('LEGACYX_DB_SCHEMA', 'legacy_x')
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json', 'Content-Profile': schema, 'Accept-Profile': schema }
}

function url(pathname) {
  return `${value('SUPABASE_URL').replace(/\/$/, '')}${pathname}`
}

async function rpc(name, payload) {
  const response = await fetch(url(`/rest/v1/rpc/${name}`), { method: 'POST', headers: headers(), body: JSON.stringify(payload) })
  const body = await response.text()
  if (!response.ok) throw new Error(`Supabase RPC ${name} failed (${response.status}): ${body.slice(0, 240)}`)
  return body ? JSON.parse(body) : null
}

async function rows(view, params) {
  const query = new URL(url(`/rest/v1/${view}`))
  Object.entries(params).forEach(([key, item]) => query.searchParams.set(key, item))
  const response = await fetch(query, { headers: headers() })
  const body = await response.text()
  if (!response.ok) throw new Error(`Supabase read ${view} failed (${response.status}): ${body.slice(0, 240)}`)
  return JSON.parse(body)
}

async function ingestCommunityProgression(pluginId, payload) {
  return rpc('ingest_community_map_result', { p_plugin_id: pluginId, p_event_id: payload.event_id, p_payload: payload })
}

async function getExperienceLeaderboard(limit) {
  return rows('community_experience_leaderboard', { select: 'rank,steam_id,username,level,experience,matches_played,last_match_at', order: 'rank.asc', limit: String(limit) })
}

async function getClanLeaderboard(season, limit) {
  return rows('community_clan_leaderboard', { select: 'season_slug,rank,clan_id,name,tag,region,points,experience,matches_played,wins,updated_at', season_slug: `eq.${season}`, order: 'rank.asc', limit: String(limit) })
}

async function getCommunityProfile(steamId) {
  const result = await rows('community_player_profiles', { select: 'steam_id,username,avatar,level,experience,rating,rank_tier,clan_id,clan_name,clan_tag,clan_role', steam_id: `eq.${steamId}`, limit: '1' })
  return result[0] || null
}

module.exports = { ingestCommunityProgression, getExperienceLeaderboard, getClanLeaderboard, getCommunityProfile }
