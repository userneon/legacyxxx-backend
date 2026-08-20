const assert = require('node:assert/strict')
const { normalizeEvent } = require('../src/match-core')

const matchId = '8ec5a1be-3c90-4b61-8a62-3fcaaac3a8c0'
const team1 = [0, 1, 2, 3, 4].map((index) => ({
  steam_id: `7656119800000000${index}`,
  name: `CT-${index + 1}`,
  team_key: 'team1',
  slot_index: index + 1,
}))
const team2 = [5, 6, 7, 8, 9].map((index) => ({
  steam_id: `7656119800000000${index}`,
  name: `T-${index - 4}`,
  team_key: 'team2',
  slot_index: index - 4,
}))

const created = normalizeEvent({
  event_id: 'core-created-001',
  event_type: 'match_created',
  match_id: matchId,
  server_id: 'legacyx-match-1',
  matchzy_local_id: '12345',
  map_name: 'de_mirage',
  map_number: 0,
  participants: [...team1, ...team2],
})
assert.equal(created.participants.length, 10)
assert.equal(created.participants.filter((player) => player.team_key === 'team1').length, 5)
assert.equal(created.participants.filter((player) => player.team_key === 'team2').length, 5)

const state = normalizeEvent({
  event_id: 'core-live-001',
  event_type: 'state_transition',
  match_id: matchId,
  expected_revision: 1,
  state: 'LIVE',
})
assert.equal(state.state, 'LIVE')
assert.equal(state.expected_revision, 1)

const snapshot = normalizeEvent({
  event_id: 'core-snapshot-001',
  event_type: 'snapshot_saved',
  match_id: matchId,
  expected_revision: 2,
  steam_id: team1[0].steam_id,
  snapshot: { health: 78, armor: 42, weapons: ['weapon_ak47'], position: { x: 1, y: 2, z: 3 } },
})
assert.equal(snapshot.snapshot.health, 78)

const fillRemoved = normalizeEvent({ event_id: 'core-fill-removed-001', event_type: 'fill_removed', match_id: matchId, expected_revision: 3, steam_id: '76561198009999999' })
assert.equal(fillRemoved.event_type, 'fill_removed')

assert.throws(() => normalizeEvent({ ...created, event_id: 'core-invalid-001', participants: [...created.participants, { ...team1[0], steam_id: '76561198009999999', slot_index: 5 }] }), /exactly ten unique original players/)
assert.throws(() => normalizeEvent({ event_id: 'core-invalid-002', event_type: 'player_disconnected', match_id: matchId, expected_revision: 2, steam_id: 'not-a-steamid' }), /steam_id is invalid/)
assert.throws(() => normalizeEvent({ event_id: 'core-invalid-003', event_type: 'state_transition', match_id: matchId, expected_revision: 2, state: 'RESUMED' }), /state is invalid/)

console.log('Match Core contract tests passed')
