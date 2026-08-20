const express = require('express')
const { ingestCoreMatchEvent, getMatchState, getMatchParticipants, getMatchHistory } = require('../match-core')
const { normalizeMatchzyResult, ingestMatchzyResult } = require('../rank')
const { ingestCommunityProgression } = require('../community')

const router = express.Router()

async function processFinalRewards(body) {
  const candidate = body?.result?.rank_result
  if (!candidate || candidate.match_core_final !== true) return { status: 'skipped', reason: 'No eligible final reward payload was supplied' }
  try {
    const payload = normalizeMatchzyResult(candidate)
    const [rank, progression] = await Promise.all([
      ingestMatchzyResult('matchzy', payload),
      ingestCommunityProgression('legacyx-community', payload),
    ])
    return { status: 'processed', rank, progression }
  } catch (error) {
    // The authoritative final result is already committed. A later idempotent final-event retry can repair rewards.
    return { status: 'deferred', reason: error.message }
  }
}

router.post('/events', async (req, res) => {
  const requestId = req.pluginRequestId || req.adminplusRequestId
  if (req.pluginId !== 'legacyx-match-core') return res.status(403).json({ error: 'This endpoint only accepts the legacyx-match-core plugin', requestId })
  try {
    const result = await ingestCoreMatchEvent(req.pluginId, req.body)
    const rewards = req.body?.event_type === 'result_final' ? await processFinalRewards(req.body) : null
    const duplicate = result?.status === 'duplicate'
    res.status(duplicate ? 200 : 202).json({ ok: true, requestId, result, ...(rewards ? { rewards } : {}) })
  } catch (error) {
    res.status(400).json({ error: error.message, requestId })
  }
})

router.get('/matches/:id', async (req, res) => {
  try {
    const match = await getMatchState(req.params.id)
    if (!match) return res.status(404).json({ error: 'Match not found', requestId: req.adminplusRequestId })
    res.json({ ok: true, match, requestId: req.adminplusRequestId })
  } catch (error) {
    res.status(400).json({ error: error.message, requestId: req.adminplusRequestId })
  }
})

router.get('/matches/:id/participants', async (req, res) => {
  try {
    const match = await getMatchState(req.params.id)
    if (!match) return res.status(404).json({ error: 'Match not found', requestId: req.adminplusRequestId })
    const roster = await getMatchParticipants(req.params.id)
    res.json({ ok: true, match_id: match.id, ...roster, requestId: req.adminplusRequestId })
  } catch (error) {
    res.status(400).json({ error: error.message, requestId: req.adminplusRequestId })
  }
})

router.get('/players/:steamId/match-history', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '3', 10) || 3, 1), 20)
    const matches = await getMatchHistory(req.params.steamId, limit)
    res.json({ ok: true, matches, requestId: req.adminplusRequestId })
  } catch (error) {
    res.status(400).json({ error: error.message, requestId: req.adminplusRequestId })
  }
})

module.exports = router
