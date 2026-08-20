const express = require('express')
const { value } = require('../config')
const { getActiveSeason, rollover } = require('../seasons')

const router = express.Router()

router.get('/current', async (_req, res) => {
  try {
    const season = await getActiveSeason()
    if (!season) return res.status(404).json({ error: 'No active rank season' })
    res.json({ season })
  } catch (error) { res.status(502).json({ error: error.message }) }
})

router.post('/rollover', async (_req, res) => {
  if (value('ALLOW_MANUAL_SEASON_ROLLOVER', 'false') !== 'true') return res.status(403).json({ error: 'Manual season rollover is disabled in production' })
  try { res.json({ result: await rollover('manual') }) } catch (error) { res.status(502).json({ error: error.message }) }
})

module.exports = router
