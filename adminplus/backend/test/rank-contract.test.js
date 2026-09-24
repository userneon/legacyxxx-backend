const assert = require('assert')
const { normalizeMatchzyResult, normalizeMatchzyRound } = require('../src/rank')

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

// Detail stats survive normalisation so the profile scoreboard can show ADR, MVPs and multi-kills.
const detailed = payload()
detailed.team1.players[0].stats = { ...detailed.team1.players[0].stats, damage: 2140, mvp: 4, kast: 78, '3k': 2 }
const detailedPlayer = normalizeMatchzyResult(detailed).team1.players[0]
assert.equal(detailedPlayer.stats.damage, 2140)
assert.equal(detailedPlayer.stats.mvp, 4)
assert.equal(detailedPlayer.stats.kast, 78)
assert.equal(detailedPlayer.stats['3k'], 2)
assert.equal(detailedPlayer.stats['5k'], 0)

// round_end: MatchZy reports winner.side as the CS team number and winner.team as the map leader.
const round = normalizeMatchzyRound({
  event: 'round_end', matchid: 12345, map_number: 1, round_number: 7, reason: 9,
  winner: { side: '2', team: 'team1' },
  team1: { score: 4 }, team2: { score: 3 },
})
assert.deepEqual(round, { match_external_id: '12345', map_number: 1, round_number: 7, winner_side: 't', reason: 9, team1_score: 4, team2_score: 3 })
assert.equal(normalizeMatchzyRound({ event: 'round_end', matchid: 1, map_number: 0, round_number: 1, winner: { side: '3' }, team1: { score: 0 }, team2: { score: 1 } }).winner_side, 'ct')
assert.throws(() => normalizeMatchzyRound({ event: 'map_result' }), /Only MatchZy round_end/)
assert.throws(() => normalizeMatchzyRound({ event: 'round_end', matchid: 'abc', map_number: 1, round_number: 1, team1: { score: 0 }, team2: { score: 0 } }), /matchid is invalid/)

console.log('Rank ingestion contract checks passed')
