const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
const express = require('express')
const { createRconClient, executeCommand } = require('./rcon')
const playerRoutes = require('./routes/players')
const serverRoutes = require('./routes/server')
const rankRoutes = require('./routes/rank')
const communityRoutes = require('./routes/community')
const seasonRoutes = require('./routes/seasons')
const reconnectRoutes = require('./routes/reconnect')
const pluginEventRoutes = require('./routes/plugin-events')
const matchCoreRoutes = require('./routes/match-core')
const authMiddleware = require('./middleware/auth')
const pluginAuthMiddleware = require('./middleware/plugin-auth')
const { value, validate } = require('./config')
const { startMonthlySeasonScheduler } = require('./seasons')

const app = express()
const { port } = validate()

app.disable('x-powered-by')
app.set('trust proxy', Number.parseInt(value('TRUST_PROXY', '1'), 10))
app.use(express.json({ limit: '128kb' }))

app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'legacy-x-adminplus-api',
  mode: 'api-only',
  rcon: Boolean(process.env.RCON_HOST),
  rankIngestion: true,
  communityProgression: true,
  matchCore: true,
  monthlySeasonScheduler: value('LEGACYX_SEASON_SCHEDULER_ENABLED', 'true') === 'true',
  audit: value('LEGACYX_AUDIT_ENABLED', 'true') === 'true',
}))

createRconClient().then(() => {
  console.log(`[AdminPlus] RCON connected to ${value('RCON_HOST')}:${value('RCON_PORT')}`)
}).catch((error) => {
  console.error('[AdminPlus] RCON connection failed:', error.message)
})

// Server-to-server ingestion is isolated from the operator secret. A leaked operator token cannot impersonate a game server.
app.use('/api/plugin/matchzy', pluginAuthMiddleware, pluginEventRoutes)
app.use('/api/plugin/reconnect', pluginAuthMiddleware, reconnectRoutes)
app.use('/api/plugin/match-core', pluginAuthMiddleware, matchCoreRoutes)

// Operator API: RCON actions and read models. No static frontend is served by this service.
app.use('/api', authMiddleware)
app.use('/api/players', playerRoutes)
app.use('/api/server', serverRoutes)
app.use('/api/rank', rankRoutes)
app.use('/api/community', communityRoutes)
app.use('/api/seasons', seasonRoutes)
app.use('/api/reconnect', (req, res, next) => { req.pluginId = 'operator'; next() }, reconnectRoutes)
app.use('/api/match-core', matchCoreRoutes)

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

const server = app.listen(port, value('HOST', '127.0.0.1'), () => {
  console.log(`[AdminPlus] API-only service listening on ${value('HOST', '127.0.0.1')}:${port}`)
})
const stopSeasonScheduler = startMonthlySeasonScheduler({
  onSuccess: (result) => console.log(`[AdminPlus] Monthly rank season check: ${result.status} (${result.season || 'unknown'})`),
  onError: (error) => console.error(`[AdminPlus] Monthly rank season check failed: ${error.message}`),
})

function shutdown(signal) {
  console.log(`[AdminPlus] ${signal} received; closing HTTP server`)
  stopSeasonScheduler()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
