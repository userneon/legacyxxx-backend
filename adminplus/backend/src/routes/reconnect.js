const express = require('express')
const { ingest, getLastPlayed } = require('../reconnect')

const router = express.Router()

router.post('/events', async (req, res) => {
  if (req.pluginId !== 'legacyx-reconnect') return res.status(403).json({ error: 'Reconnect events require legacyx-reconnect plugin identity', requestId: req.pluginRequestId })
  try {
    const result = await ingest(req.pluginId, req.body)
    res.status(result?.status === 'duplicate' ? 200 : 202).json({ ok: true, result, requestId: req.pluginRequestId })
  } catch (error) { res.status(400).json({ error: error.message, requestId: req.pluginRequestId }) }
})

router.get('/players/:steamId', async (req, res) => {
  if (req.pluginId !== 'legacyx-reconnect' && req.pluginId !== 'operator') return res.status(403).json({ error: 'Reconnect sessions require reconnect plugin identity', requestId: req.pluginRequestId })
  try { res.json({ sessions: await getLastPlayed(req.params.steamId, req.query.exclude_server_id), requestId: req.pluginRequestId }) } catch (error) { res.status(400).json({ error: error.message, requestId: req.pluginRequestId }) }
})

module.exports = router
