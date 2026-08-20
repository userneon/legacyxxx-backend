const express = require('express')
const { normalizeMatchzyResult, ingestMatchzyResult } = require('../rank')
const { getCommunityProfile, ingestCommunityProgression } = require('../community')
const { getActiveSeason } = require('../seasons')

const router = express.Router()

router.post('/events', async (req, res) => {
  // MatchZy can emit other remote-log events. Only final map result events change ranks.
  if (req.body?.event !== 'map_result') {
    return res.status(202).json({ ok: true, accepted: false, ignored: req.body?.event || 'unknown' })
  }

  try {
    const payload = normalizeMatchzyResult(req.body)
    const activeSeason = await getActiveSeason()
    if (!activeSeason) throw new Error('No active rank season is configured')
    payload.season = activeSeason.slug
    const rankResult = await ingestMatchzyResult(req.pluginId, payload)
    const communityResult = await ingestCommunityProgression(req.pluginId, payload)
    const duplicate = rankResult?.status === 'duplicate' && communityResult?.status === 'duplicate'
    res.status(duplicate ? 200 : 202).json({ ok: true, accepted: true, requestId: req.pluginRequestId, rankResult, communityResult })
  } catch (error) {
    console.warn(`[RankIngest] MatchZy event rejected: ${error.message}`)
    res.status(400).json({ error: 'Invalid rank event', detail: error.message, requestId: req.pluginRequestId })
  }
})

router.get('/community/players/:steamId', async (req, res) => {
  const steamId = String(req.params.steamId || '').trim()
  if (!/^\d{15,20}$/.test(steamId)) return res.status(400).json({ error: 'steamId must be a 15-20 digit SteamID64', requestId: req.pluginRequestId })
  try {
    const profile = await getCommunityProfile(steamId)
    if (!profile) return res.status(404).json({ error: 'Player community profile not found', requestId: req.pluginRequestId })
    res.json({ profile, requestId: req.pluginRequestId })
  } catch (error) {
    res.status(502).json({ error: error.message, requestId: req.pluginRequestId })
  }
})

module.exports = router
