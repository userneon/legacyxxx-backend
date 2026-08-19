const path = require('path')
const fs = require('fs')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
const express = require('express')
const cors = require('cors')
const { createRconClient, executeCommand } = require('./rcon')
const playerRoutes = require('./routes/players')
const serverRoutes = require('./routes/server')
const authMiddleware = require('./middleware/auth')
const { value, list, validate } = require('./config')

const app = express()
const frontendDist = path.resolve(__dirname, '../../frontend/dist')
const { port } = validate()
const allowedOrigins = list('FRONTEND_URL')

app.disable('x-powered-by')
app.set('trust proxy', Number.parseInt(value('TRUST_PROXY', '1'), 10))
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true)
    return callback(new Error('CORS origin denied'))
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-secret'],
}))
app.use(express.json({ limit: '32kb' }))

app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'legacy-x-adminplus',
  rcon: Boolean(process.env.RCON_HOST),
  audit: value('LEGACYX_AUDIT_ENABLED', 'true') === 'true',
}))

createRconClient().then(() => {
  console.log(`[AdminPlus] RCON connected to ${value('RCON_HOST')}:${value('RCON_PORT')}`)
}).catch((error) => {
  console.error('[AdminPlus] RCON connection failed:', error.message)
})

app.use('/api', authMiddleware)
app.use('/api/players', playerRoutes)
app.use('/api/server', serverRoutes)

app.post('/api/rcon', async (req, res) => {
  if (value('ALLOW_RAW_RCON', 'false') !== 'true') return res.status(403).json({ error: 'Raw RCON is disabled in production' })
  const command = String(req.body?.command || '').trim()
  if (!command || command.length > 160 || /[\r\n]/.test(command)) return res.status(400).json({ error: 'A single RCON command up to 160 characters is required' })
  try {
    const result = await executeCommand(command)
    res.json({ ok: true, result })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist, { index: false }))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(frontendDist, 'index.html'))
  })
} else {
  console.warn('[AdminPlus] frontend/dist not found; run `npm run build` from adminplus/.')
}

const server = app.listen(port, value('HOST', '127.0.0.1'), () => {
  console.log(`[AdminPlus] listening on ${value('HOST', '127.0.0.1')}:${port}`)
})

function shutdown(signal) {
  console.log(`[AdminPlus] ${signal} received; closing HTTP server`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
