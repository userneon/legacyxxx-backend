const express = require('express')
const { normalizeMatchzyResult, ingestMatchzyResult } = require('../rank')

const router = express.Router()

router.post('/events', async (req, res) => {
  // MatchZy can emit other remote-log events. Only final map result events change ranks.
  if (req.body?.event !== 'map_result') {
    return res.status(202).json({ ok: true, accepted: false, ignored: req.body?.event || 'unknown' })
  }

  try {
    const payload = normalizeMatchzyResult(req.body)
    const result = await ingestMatchzyResult(req.pluginId, payload)
    res.status(202).json({ ok: true, accepted: true, requestId: req.pluginRequestId, result })
  } catch (error) {
    console.warn(`[RankIngest] MatchZy event rejected: ${error.message}`)
    res.status(400).json({ error: 'Invalid rank event', detail: error.message, requestId: req.pluginRequestId })
  }
})

module.exports = router
