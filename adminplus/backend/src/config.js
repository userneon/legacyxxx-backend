const REQUIRED = ['RCON_HOST', 'RCON_PORT', 'RCON_PASSWORD', 'API_SECRET', 'FRONTEND_URL']

function value(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim()
}

function list(name) {
  return value(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function validate() {
  const missing = REQUIRED.filter((name) => !value(name))
  if (missing.length) {
    throw new Error(`Missing required AdminPlus environment variables: ${missing.join(', ')}`)
  }

  const port = Number.parseInt(value('PORT', '3001'), 10)
  const rconPort = Number.parseInt(value('RCON_PORT', '27015'), 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535')
  if (!Number.isInteger(rconPort) || rconPort < 1 || rconPort > 65535) throw new Error('RCON_PORT must be an integer between 1 and 65535')
  if (value('NODE_ENV', 'production') === 'production' && value('API_SECRET').length < 32) {
    throw new Error('API_SECRET must contain at least 32 characters in production')
  }
  if (value('LEGACYX_AUDIT_ENABLED', 'true') === 'true') {
    const dbMissing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((name) => !value(name))
    if (dbMissing.length) throw new Error(`LEGACYX_AUDIT_ENABLED=true requires: ${dbMissing.join(', ')}`)
  }
  return { port, rconPort }
}

module.exports = { value, list, validate }
