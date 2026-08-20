const express = require('express')
const { value } = require('../config')
const { getExperienceLeaderboard, getClanLeaderboard, getCommunityProfile } = require('../community')

const router = express.Router()

function limit(input) { return Math.min(Math.max(Number.parseInt(input || '100', 10) || 100, 1), 100) }
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

router.get('/experience', async (req, res) => {
  try { res.json({ entries: await getExperienceLeaderboard(limit(req.query.limit)) }) } catch (error) { res.status(502).json({ error: error.message }) }
})
router.get('/clans', async (req, res) => {
  try { const selected = season(req.query.season); res.json({ season: selected, entries: await getClanLeaderboard(selected, limit(req.query.limit)) }) } catch (error) { res.status(502).json({ error: error.message }) }
})
router.get('/players/:steamId', async (req, res) => {
  try { const profile = await getCommunityProfile(steamId(req.params.steamId)); if (!profile) return res.status(404).json({ error: 'Player community profile not found' }); res.json({ profile }) } catch (error) { res.status(400).json({ error: error.message }) }
})

module.exports = router
