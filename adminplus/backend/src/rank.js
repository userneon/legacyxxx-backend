const { value } = require('./config')

function serviceHeaders(profile = false) {
  const serviceRoleKey = value('SUPABASE_SERVICE_ROLE_KEY')
  const schema = value('LEGACYX_DB_SCHEMA', 'legacy_x')
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    ...(profile ? { 'Content-Profile': schema, 'Accept-Profile': schema } : {}),
  }
}

function supabaseUrl(pathname) {
  return `${value('SUPABASE_URL').replace(/\/$/, '')}${pathname}`
}

function integer(value, name, maximum = 100_000) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${name} must be an integer between 0 and ${maximum}`)
  return parsed
}

function text(value, name, maximum = 120, pattern = null) {
  const parsed = String(value || '').trim()
  if (!parsed || parsed.length > maximum || (pattern && !pattern.test(parsed))) throw new Error(`${name} is invalid`)
  return parsed
}

/**
 * MatchZy PlayerStats fields kept for the profile match scoreboard (ADR, KAST, MVPs, multi-kills, clutches,
 * opening duels). Only the first six feed the rank formula; the rest are stored in rank_match_results.stats.
 */
const DETAIL_STAT_FIELDS = [
  'damage', 'utility_damage', 'enemies_flashed', 'flash_assists', 'mvp', 'kast', 'trade_kills',
  'first_kills_t', 'first_kills_ct', 'first_deaths_t', 'first_deaths_ct',
  '2k', '3k', '4k', '5k', '1v1', '1v2', '1v3', '1v4', '1v5', 'bomb_plants', 'bomb_defuses',
]

function normalizePlayer(player, teamKey) {
  const stats = player?.stats || {}
  const detail = Object.fromEntries(DETAIL_STAT_FIELDS.map((field) => [field, integer(stats[field] || 0, `stats.${field}`, 1_000_000)]))
  return {
    steamid: text(player?.steamid, 'player.steamid', 20, /^\d{15,20}$/),
    name: text(player?.name, 'player.name', 64),
    team: teamKey,
    stats: {
      kills: integer(stats.kills || 0, 'stats.kills'),
      deaths: integer(stats.deaths || 0, 'stats.deaths'),
      assists: integer(stats.assists || 0, 'stats.assists'),
      headshot_kills: integer(stats.headshot_kills || 0, 'stats.headshot_kills'),
      score: integer(stats.score || 0, 'stats.score'),
      rounds_played: integer(stats.rounds_played || 0, 'stats.rounds_played'),
      ...detail,
    },
  }
}

/** MatchZy sends winner.side as the CS team number: "2" = Terrorists, "3" = Counter-Terrorists. */
function roundWinnerSide(value) {
  const side = String(value ?? '').trim().toLowerCase()
  if (side === '2' || side === 't' || side === 'terrorist') return 't'
  if (side === '3' || side === 'ct') return 'ct'
  return null
}

function normalizeMatchzyRound(body) {
  if (body?.event !== 'round_end') throw new Error('Only MatchZy round_end events are accepted')
  return {
    match_external_id: text(body?.matchid, 'matchid', 64, /^\d+$/),
    map_number: integer(body?.map_number, 'map_number', 99),
    round_number: integer(body?.round_number, 'round_number', 200),
    winner_side: roundWinnerSide(body?.winner?.side),
    reason: Number.isInteger(Number(body?.reason)) ? Number(body.reason) : null,
    team1_score: integer(body?.team1?.score, 'team1.score', 99),
    team2_score: integer(body?.team2?.score, 'team2.score', 99),
  }
}

/** Upserts on (match, map, round), so MatchZy retries or a server restart re-sending a round are harmless. */
async function storeMatchzyRound(round) {
  const url = new URL(supabaseUrl('/rest/v1/match_rounds'))
  url.searchParams.set('on_conflict', 'match_external_id,map_number,round_number')
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...serviceHeaders(true), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(round),
  })
  if (!response.ok) throw new Error(`Supabase match_rounds upsert failed (${response.status}): ${(await response.text()).slice(0, 240)}`)
  return { status: 'stored', round: round.round_number }
}

function normalizeTeam(team, key) {
  if (!team || !Array.isArray(team.players) || team.players.length !== 5) throw new Error(`${key} must contain exactly five players`)
  return {
    id: text(team.id || key, `${key}.id`, 80),
    name: text(team.name || key, `${key}.name`, 80),
    score: integer(team.score, `${key}.score`, 99),
    players: team.players.map((player) => normalizePlayer(player, key)),
  }
}

function normalizeMatchzyResult(body) {
  if (body?.event !== 'map_result') throw new Error('Only MatchZy map_result events are accepted')
  const team1 = normalizeTeam(body.team1, 'team1')
  const team2 = normalizeTeam(body.team2, 'team2')
  const steamIds = new Set([...team1.players, ...team2.players].map((player) => player.steamid))
  if (steamIds.size !== 10) throw new Error('Map result must contain ten unique Steam players')

  const winner = String(body?.winner?.team || '')
  if (!['team1', 'team2'].includes(winner)) throw new Error('winner.team must be team1 or team2')
  const mapName = text(body?.map_name, 'map_name', 128, /^(de_|cs_|workshop\/)/)

  return {
    event: 'map_result',
    event_id: text(body?.event_id, 'event_id', 160, /^[a-z0-9:_-]+$/i),
    match_id: text(body?.matchid, 'matchid', 64, /^\d+$/),
    map_number: integer(body?.map_number, 'map_number', 99),
    map_name: mapName,
    season: text(body?.season || value('LEGACYX_DEFAULT_SEASON', 'season-1'), 'season', 64, /^[a-z0-9-]+$/),
    winner,
    team1,
    team2,
  }
}

async function rpc(name, payload) {
  const response = await fetch(supabaseUrl(`/rest/v1/rpc/${name}`), {
    method: 'POST',
    headers: serviceHeaders(true),
    body: JSON.stringify(payload),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Supabase RPC ${name} failed (${response.status}): ${body.slice(0, 240)}`)
  return body ? JSON.parse(body) : null
}

async function ingestMatchzyResult(pluginId, payload) {
  return rpc('ingest_rank_map_result', {
    p_plugin_id: pluginId,
    p_event_id: payload.event_id,
    p_payload: payload,
  })
}

async function readRows(view, params) {
  const url = new URL(supabaseUrl(`/rest/v1/${view}`))
  Object.entries(params).forEach(([key, row]) => url.searchParams.set(key, row))
  const response = await fetch(url, { headers: serviceHeaders(true) })
  const body = await response.text()
  if (!response.ok) throw new Error(`Supabase read ${view} failed (${response.status}): ${body.slice(0, 240)}`)
  return JSON.parse(body)
}

async function getLeaderboard(season, limit) {
  return readRows('rank_leaderboard', {
    select: 'season_slug,season_name,rank,steam_id,username,rating,tier,matches_played,wins,losses,kills,deaths,assists,kd_ratio,last_match_at',
    season_slug: `eq.${season}`,
    order: 'rank.asc',
    limit: String(limit),
  })
}

async function getPlayerRank(season, steamId) {
  const rows = await readRows('rank_leaderboard', {
    select: 'season_slug,season_name,rank,steam_id,username,rating,tier,matches_played,wins,losses,kills,deaths,assists,kd_ratio,last_match_at',
    season_slug: `eq.${season}`,
    steam_id: `eq.${steamId}`,
    limit: '1',
  })
  return rows[0] || null
}

module.exports = { normalizeMatchzyResult, normalizeMatchzyRound, storeMatchzyRound, ingestMatchzyResult, getLeaderboard, getPlayerRank, rpc, readRows }
