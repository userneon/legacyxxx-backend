const crypto = require('crypto')

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
  return current.count <= Number.parseInt(process.env.ADMINPLUS_RATE_LIMIT || '120', 10)
}

module.exports = function authMiddleware(req, res, next) {
  const requestId = crypto.randomUUID()
  res.setHeader('x-request-id', requestId)
  if (!rateAllowed(req.ip || req.socket.remoteAddress || 'unknown')) {
    return res.status(429).json({ error: 'Too many requests', requestId })
  }

  const secret = req.headers['x-api-secret']
  if (!secret || !safeEqual(secret, process.env.API_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized', requestId })
  }

  req.adminplusRequestId = requestId
  next()
}
