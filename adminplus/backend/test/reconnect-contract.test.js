const assert = require('node:assert/strict')

process.env.RECONNECT_SERVER_REGISTRY = 'legacyx-match-1=203.0.113.10:27015'
const { normalizeEvent } = require('../src/reconnect')

const heartbeat = normalizeEvent({
  event: 'server_heartbeat',
  event_id: 'heartbeat-12345678',
  server_id: 'legacyx-match-1',
  server_address: '203.0.113.10:27015',
  map_name: 'de_mirage',
  mode: 'competitive_5v5',
  player_count: 10,
})
assert.equal(heartbeat.event, 'server_heartbeat')
assert.equal(heartbeat.player_count, 10)

const connected = normalizeEvent({
  event: 'player_connected',
  event_id: 'player_connected-legacyx-match-1-0123456789abcdef',
  session_id: '123e4567-e89b-42d3-a456-426614174000',
  steam_id: '76561198000000000',
  player_name: 'LEGACY-X Player',
  server_id: 'legacyx-match-1',
  server_address: '203.0.113.10:27015',
  map_name: 'de_mirage',
  mode: 'competitive_5v5',
})
assert.equal(connected.steam_id, '76561198000000000')
assert.equal(connected.session_id, '123e4567-e89b-42d3-a456-426614174000')

assert.throws(() => normalizeEvent({ ...heartbeat, server_address: '198.51.100.3:27015' }), /does not match registry/)
assert.throws(() => normalizeEvent({ ...connected, steam_id: 'not-steam' }), /SteamID64/)
assert.throws(() => normalizeEvent({ ...connected, session_id: 'not-a-uuid' }), /UUID/)

console.log('Reconnect ingestion contract checks passed')
