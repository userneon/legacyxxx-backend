const { list, value } = require('./config')
const { rpc, readRows } = require('./rank')

function registry() {
  const entries = list('RECONNECT_SERVER_REGISTRY')
  return new Map(entries.map((entry) => {
    const [id, address] = entry.split('=').map((part) => part?.trim())
    return [id, address]
  }).filter(([id, address]) => id && address && /^[a-z0-9_-]{3,64}$/i.test(id) && /^[a-z0-9.-]+:\d{2,5}$/i.test(address)))
}

function ensureConfiguredServer(serverId, address) {
  const expected = registry().get(serverId)
  if (!expected) throw new Error('Reconnect server is not registered')
  if (expected !== address) throw new Error('Reconnect server address does not match registry')
}

function text(value, max = 128) { return String(value || '').trim().slice(0, max) }
function steamId(value) {
  const id = text(value, 20)
  if (!/^\d{15,20}$/.test(id)) throw new Error('steam_id must be a 15-20 digit SteamID64')
  return id
}
function id(value, label) {
  const output = text(value, 128)
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(output)) throw new Error(`${label} is invalid`)
  return output
}
function sessionId(value) {
  const output = text(value, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(output)) throw new Error('session_id must be a UUID')
  return output
}
function serverId(value) {
  const output = text(value, 64)
  if (!/^[a-z0-9_-]{3,64}$/i.test(output)) throw new Error('server_id is invalid')
  return output
}

function normalizeEvent(body) {
  const event = text(body?.event, 32)
  if (!['player_connected', 'player_disconnected', 'server_heartbeat'].includes(event)) throw new Error('Unsupported reconnect event')
  const normalized = {
    event,
    event_id: id(body?.event_id, 'event_id'),
    server_id: serverId(body?.server_id),
    server_address: text(body?.server_address, 96),
    map_name: text(body?.map_name, 96),
    mode: text(body?.mode, 48),
  }
  ensureConfiguredServer(normalized.server_id, normalized.server_address)
  if (event === 'server_heartbeat') {
    normalized.player_count = Number.parseInt(body?.player_count, 10)
    if (!Number.isInteger(normalized.player_count) || normalized.player_count < 0 || normalized.player_count > 128) throw new Error('player_count is invalid')
    return normalized
  }
  normalized.session_id = sessionId(body?.session_id)
  normalized.steam_id = steamId(body?.steam_id)
  normalized.player_name = text(body?.player_name, 128)
  normalized.disconnect_reason = text(body?.disconnect_reason, 96)
  return normalized
}

async function ingest(pluginId, body) {
  const event = normalizeEvent(body)
  if (event.event === 'server_heartbeat') {
    return rpc('ingest_reconnect_heartbeat', {
      p_event_id: event.event_id, p_plugin_id: pluginId, p_server_id: event.server_id,
      p_server_address: event.server_address, p_map_name: event.map_name, p_mode: event.mode,
      p_player_count: event.player_count,
    })
  }
  return rpc('ingest_reconnect_event', {
    p_event_id: event.event_id, p_plugin_id: pluginId, p_event_type: event.event,
    p_session_id: event.session_id, p_steam_id: event.steam_id, p_player_name: event.player_name,
    p_server_id: event.server_id, p_server_address: event.server_address,
    p_map_name: event.map_name, p_mode: event.mode, p_disconnect_reason: event.disconnect_reason,
    p_reconnect_window_minutes: Number.parseInt(value('RECONNECT_WINDOW_MINUTES', '720'), 10),
  })
}

async function getLastPlayed(steam, excludeServerId = '') {
  const id = steamId(steam)
  const params = {
    select: 'session_id,server_id,connect_address,server_name,map_name,mode,connected_at,disconnected_at,disconnect_reason,reconnectable_until,player_count,last_heartbeat_at,server_online',
    steam_id: `eq.${id}`,
    order: 'connected_at.desc', limit: '3',
  }
  if (excludeServerId) params.server_id = `neq.${serverId(excludeServerId)}`
  const rows = await readRows('reconnect_last_played', params)
  return rows.map((row) => ({
    ...row,
    reconnectable: Boolean(row.server_online) && new Date(row.reconnectable_until).getTime() > Date.now(),
  }))
}

module.exports = { ingest, getLastPlayed, normalizeEvent }
