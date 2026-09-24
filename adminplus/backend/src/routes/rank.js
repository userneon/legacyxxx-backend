const express = require('express')
const { value } = require('../config')
const { getLeaderboard, getPlayerRank } = require('../rank')

const router = express.Router()

function season(valueFromRequest) {
  const candidate = String(valueFromRequest || value('LEGACYX_DEFAULT_SEASON', 'season-1')).trim()
  if (!/^[a-z0-9-]{1,64}$/i.test(candidate)) throw new Error('season is invalid')
  return candidate
}

router.get('/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 100)
    const rows = await getLeaderboard(season(req.query.season), limit)
    res.json({ season: season(req.query.season), entries: rows })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

router.get('/players/:steamId', async (req, res) => {
  try {
    const steamId = String(req.params.steamId || '').trim()
    if (!/^\d{15,20}$/.test(steamId)) return res.status(400).json({ error: 'steamId must be a 15-20 digit SteamID64' })
    const entry = await getPlayerRank(season(req.query.season), steamId)
    if (!entry) return res.status(404).json({ error: 'Player rank not found for season' })
    res.json({ season: season(req.query.season), entry })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

module.exports = router
