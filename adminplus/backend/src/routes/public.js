const crypto = require('crypto')
const express = require('express')
const { value } = require('../config')
const { getLeaderboard, getPlayerRank, readRows } = require('../rank')
const { getExperienceLeaderboard, getClanLeaderboard, getCommunityProfile } = require('../community')

const router = express.Router()
const buckets = new Map()

function boundedInteger(input, fallback = 50, maximum = 100) {
  const parsed = Number.parseInt(input || String(fallback), 10)
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), maximum) : fallback
}

function season(input) {
  const candidate = String(input || value('LEGACYX_DEFAULT_SEASON', 'season-1')).trim()
  if (!/^[a-z0-9-]{1,64}$/i.test(candidate)) throw new Error('season is invalid')
  return candidate
}

function steamId(input) {
  const candidate = String(input || '').trim()
  if (!/^\d{15,20}$/.test(candidate)) throw new Error('steamId must be a 15-20 digit SteamID64')
  return candidate
}

function configuredOrigins() {
  return new Set(String(value('FRONTEND_PUBLIC_ORIGINS', '')).split(',').map((origin) => origin.trim()).filter(Boolean))
}

function rateAllowed(key) {
  const now = Date.now()
  const current = buckets.get(key)
  const maximum = boundedInteger(value('FRONTEND_PUBLIC_RATE_LIMIT', '120'), 120, 600)
  if (!current || now - current.startedAt >= 60_000) {
    buckets.set(key, { startedAt: now, count: 1 })
    return true
  }
  current.count += 1
  return current.count <= maximum
}

function serverIsOnline(lastHeartbeatAt) {
  const receivedAt = new Date(lastHeartbeatAt).getTime()
  return Number.isFinite(receivedAt) && Date.now() - receivedAt <= 90_000
}

async function publicServers() {
  const rows = await readRows('reconnect_servers', {
    select: 'server_id,connect_address,display_name,current_map,current_mode,player_count,last_heartbeat_at',
    order: 'display_name.asc',
    limit: '100',
  })
  return rows.map((row) => ({
    id: row.server_id,
    name: row.display_name || row.server_id,
    map: row.current_map || 'Unknown',
    players: Number(row.player_count || 0),
    maxPlayers: 10,
    mode: row.current_mode || 'Community',
    ping: 0,
    status: serverIsOnline(row.last_heartbeat_at) ? (Number(row.player_count || 0) >= 10 ? 'full' : 'online') : 'offline',
    connectAddress: row.connect_address,
  }))
}

router.use((req, res, next) => {
  const requestId = crypto.randomUUID()
  const origin = req.get('origin')
  const allowed = configuredOrigins()
  if (origin && allowed.size && !allowed.has(origin)) return res.status(403).json({ error: 'Origin is not allowed', requestId })
  if (origin && allowed.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }
  if (req.method === 'OPTIONS') return res.status(204).end()
  const key = req.ip || req.socket.remoteAddress || 'unknown'
  if (!rateAllowed(key)) return res.status(429).json({ error: 'Too many requests', requestId })
  res.setHeader('x-request-id', requestId)
  next()
})

router.get('/rank/leaderboard', async (req, res) => {
  try {
    const selectedSeason = season(req.query.season)
    res.json({ season: selectedSeason, entries: await getLeaderboard(selectedSeason, boundedInteger(req.query.limit)) })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

router.get('/rank/players/:steamId', async (req, res) => {
  try {
    const selectedSeason = season(req.query.season)
    const entry = await getPlayerRank(selectedSeason, steamId(req.params.steamId))
    if (!entry) return res.status(404).json({ error: 'Player rank not found for season' })
    res.json({ season: selectedSeason, entry })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

router.get('/community/experience', async (req, res) => {
  try {
    res.json({ entries: await getExperienceLeaderboard(boundedInteger(req.query.limit)) })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

router.get('/community/clans', async (req, res) => {
  try {
    const selectedSeason = season(req.query.season)
    res.json({ season: selectedSeason, entries: await getClanLeaderboard(selectedSeason, boundedInteger(req.query.limit)) })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

router.get('/community/players/:steamId', async (req, res) => {
  try {
    const selectedSeason = season(req.query.season)
    const selectedSteamId = steamId(req.params.steamId)
    const [profile, rank] = await Promise.all([getCommunityProfile(selectedSteamId), getPlayerRank(selectedSeason, selectedSteamId)])
    if (!profile && !rank) return res.status(404).json({ error: 'Player public profile not found' })
    res.json({ season: selectedSeason, profile, rank })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

router.get('/servers', async (_req, res) => {
  try {
    res.json({ entries: await publicServers() })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

router.get('/servers/:serverId', async (req, res) => {
  try {
    const serverId = String(req.params.serverId || '').trim()
    if (!/^[a-z0-9_-]{3,64}$/i.test(serverId)) return res.status(400).json({ error: 'serverId is invalid' })
    const server = (await publicServers()).find((entry) => entry.id === serverId)
    if (!server) return res.status(404).json({ error: 'Server not found' })
    res.json({ server })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

router.get('/overview', async (_req, res) => {
  try {
    const selectedSeason = season()
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const [servers, clans, matches] = await Promise.all([
      publicServers(),
      getClanLeaderboard(selectedSeason, 100),
      readRows('core_match_history', { select: 'match_id', started_at: `gte.${today.toISOString()}`, limit: '1000' }),
    ])
    res.json({
      playersOnline: servers.filter((server) => server.status !== 'offline').reduce((sum, server) => sum + server.players, 0),
      liveServers: servers.filter((server) => server.status !== 'offline').length,
      matchesToday: matches.length,
      activeClans: clans.length,
    })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

module.exports = router
