const crypto = require('crypto')
const { value } = require('../config')

const buckets = new Map()
const windowMs = 60_000

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function rateAllowed(ip) {
  const now = Date.now()
  const current = buckets.get(ip)
  if (!current || now - current.startedAt >= windowMs) {
    buckets.set(ip, { startedAt: now, count: 1 })
    return true
  }
  current.count += 1
  return current.count <= Number.parseInt(value('PLUGIN_RATE_LIMIT', '60'), 10)
}

module.exports = function pluginAuthMiddleware(req, res, next) {
  const requestId = crypto.randomUUID()
  res.setHeader('x-request-id', requestId)
  if (!rateAllowed(req.ip || req.socket.remoteAddress || 'unknown')) return res.status(429).json({ error: 'Too many plugin requests', requestId })

  const pluginId = String(req.headers['x-plugin-id'] || 'matchzy').trim().toLowerCase()
  const secret = req.headers['x-plugin-secret']
  const allowedPluginIds = new Set(['matchzy', 'legacyx-community', 'legacyx-reconnect'])
  if (!allowedPluginIds.has(pluginId) || !safeEqual(secret, value('PLUGIN_INGEST_SECRET'))) {
    return res.status(401).json({ error: 'Unauthorized plugin', requestId })
  }

  req.pluginId = pluginId
  req.pluginRequestId = requestId
  next()
}
