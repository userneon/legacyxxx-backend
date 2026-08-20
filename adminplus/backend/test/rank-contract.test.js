const assert = require('assert')
const { normalizeMatchzyResult } = require('../src/rank')

function player(index, team) {
  return {
    steamid: `765611980000000${String(index).padStart(2, '0')}`,
    name: `${team}-player-${index}`,
    stats: { kills: 20 + index, deaths: 10, assists: 5, headshot_kills: 8, score: 40, rounds_played: 24 },
  }
}

function payload() {
  return {
    event: 'map_result',
    event_id: 'matchzy:12345:1:map_result',
    matchid: 12345,
    map_number: 1,
    map_name: 'de_mirage',
    season: 'season-1',
    winner: { team: 'team1' },
    team1: { id: 'legacy-blue', name: 'LEGACY Blue', score: 13, players: [1, 2, 3, 4, 5].map((index) => player(index, 'blue')) },
    team2: { id: 'legacy-orange', name: 'LEGACY Orange', score: 8, players: [6, 7, 8, 9, 10].map((index) => player(index, 'orange')) },
  }
}

const accepted = normalizeMatchzyResult(payload())
assert.equal(accepted.team1.players.length, 5)
assert.equal(accepted.team2.players.length, 5)
assert.equal(accepted.winner, 'team1')
assert.equal(accepted.map_name, 'de_mirage')

const duplicateSteamId = payload()
duplicateSteamId.team2.players[4].steamid = duplicateSteamId.team1.players[0].steamid
assert.throws(() => normalizeMatchzyResult(duplicateSteamId), /ten unique Steam players/)

const invalidRoster = payload()
invalidRoster.team1.players.pop()
assert.throws(() => normalizeMatchzyResult(invalidRoster), /exactly five players/)

console.log('Rank ingestion contract checks passed')
