const { value } = require('./config')
const { rpc, readRows } = require('./rank')

const STEAM_ID = /^\d{15,20}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EVENT_ID = /^[a-z0-9:_-]{8,160}$/i
const CORE_STATES = new Set(['WAITING', 'LIVE', 'PAUSED', 'FINISHED', 'CANCELLED'])
const EVENT_TYPES = new Set(['match_created', 'state_transition', 'player_disconnected', 'player_returned', 'fill_assigned', 'fill_removed', 'snapshot_saved', 'result_final', 'match_cancelled'])

function text(input, name, maximum = 160, pattern = null) {
  const parsed = String(input || '').trim()
  if (!parsed || parsed.length > maximum || (pattern && !pattern.test(parsed))) throw new Error(`${name} is invalid`)
  return parsed
}

function integer(input, name, minimum = 0, maximum = 100_000) {
  const parsed = Number.parseInt(input, 10)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  return parsed
}

function steamId(input, name = 'steam_id') {
  return text(input, name, 20, STEAM_ID)
}

function matchId(input) {
  return text(input, 'match_id', 36, UUID).toLowerCase()
}

function eventId(input) {
  return text(input, 'event_id', 160, EVENT_ID)
}

function teamKey(input, name = 'team_key') {
  const parsed = text(input, name, 8)
  if (!['team1', 'team2'].includes(parsed)) throw new Error(`${name} is invalid`)
  return parsed
}

function object(input, name, maximumBytes = 48_000) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${name} must be an object`)
  const encoded = JSON.stringify(input)
  if (Buffer.byteLength(encoded, 'utf8') > maximumBytes) throw new Error(`${name} exceeds ${maximumBytes} bytes`)
  return input
}

function normalizeParticipant(input) {
  const participant = object(input, 'participant', 2_000)
  return {
    steam_id: steamId(participant.steam_id),
    name: text(participant.name, 'participant.name', 64),
    team_key: teamKey(participant.team_key, 'participant.team_key'),
    slot_index: integer(participant.slot_index, 'participant.slot_index', 1, 5),
  }
}

function normalizeEvent(input) {
  const body = object(input, 'event', 128_000)
  const event_type = text(body.event_type, 'event_type', 40)
  if (!EVENT_TYPES.has(event_type)) throw new Error('event_type is unsupported')
  const base = { event_id: eventId(body.event_id), event_type }

  if (event_type === 'match_created') {
    const participants = Array.isArray(body.participants) ? body.participants.map(normalizeParticipant) : []
    const slots = new Set(participants.map((participant) => `${participant.team_key}:${participant.slot_index}`))
    const players = new Set(participants.map((participant) => participant.steam_id))
    if (participants.length !== 10 || slots.size !== 10 || players.size !== 10) throw new Error('match_created requires exactly ten unique original players across five slots per team')
    if ([...slots].filter((slot) => slot.startsWith('team1:')).length !== 5 || [...slots].filter((slot) => slot.startsWith('team2:')).length !== 5) throw new Error('match_created requires exactly five team1 and five team2 players')
    return {
      ...base,
      match_id: matchId(body.match_id),
      server_id: text(body.server_id, 'server_id', 80, /^[a-z0-9:_-]+$/i),
      matchzy_local_id: body.matchzy_local_id ? text(body.matchzy_local_id, 'matchzy_local_id', 64, /^\d+$/) : null,
      map_name: text(body.map_name, 'map_name', 128, /^(de_|cs_|workshop\/)/),
      map_number: integer(body.map_number || 0, 'map_number', 0, 99),
      participants,
    }
  }

  const normalized = { ...base, match_id: matchId(body.match_id), expected_revision: integer(body.expected_revision, 'expected_revision', 1, 1_000_000) }
  if (event_type === 'state_transition') {
    const state = text(body.state, 'state', 12)
    if (!CORE_STATES.has(state)) throw new Error('state is invalid')
    return { ...normalized, state, ...(body.reason ? { reason: text(body.reason, 'reason', 120) } : {}) }
  }
  if (event_type === 'player_disconnected') return { ...normalized, steam_id: steamId(body.steam_id), reconnect_window_seconds: integer(body.reconnect_window_seconds || value('MATCH_CORE_RECONNECT_WINDOW_SECONDS', '300'), 'reconnect_window_seconds', 30, 3_600) }
  if (event_type === 'player_returned') return { ...normalized, steam_id: steamId(body.steam_id) }
  if (event_type === 'fill_assigned') return { ...normalized, steam_id: steamId(body.steam_id), name: text(body.name, 'name', 64), team_key: teamKey(body.team_key), slot_index: integer(body.slot_index, 'slot_index', 1, 5) }
  if (event_type === 'fill_removed') return { ...normalized, steam_id: steamId(body.steam_id) }
  if (event_type === 'snapshot_saved') return { ...normalized, steam_id: steamId(body.steam_id), snapshot: object(body.snapshot, 'snapshot', 32_000) }
  if (event_type === 'result_final') return { ...normalized, result: object(body.result, 'result', 32_000) }
  return normalized
}

async function ingestCoreMatchEvent(pluginId, body) {
  const payload = normalizeEvent(body)
  if (payload.event_type === 'fill_removed') {
    return rpc('remove_core_match_fill', {
      p_plugin_id: pluginId,
      p_event_id: payload.event_id,
      p_match_id: payload.match_id,
      p_expected_revision: payload.expected_revision,
      p_steam_id: payload.steam_id,
    })
  }
  return rpc('ingest_core_match_event', { p_plugin_id: pluginId, p_event_id: payload.event_id, p_payload: payload })
}

async function getMatchState(id) {
  const rows = await readRows('core_matches', {
    select: 'id,server_id,matchzy_local_id,state,revision,map_name,map_number,pause_reason,paused_at,started_at,finished_at,cancelled_at,result,created_at,updated_at',
    id: `eq.${matchId(id)}`,
    limit: '1',
  })
  return rows[0] || null
}

async function getMatchParticipants(id) {
  const idValue = matchId(id)
  const [participants, slots] = await Promise.all([
    readRows('core_match_participants', {
      select: 'steam_id,team_key,slot_index,original_name,connected,disconnected_at,reconnect_deadline,returned_at,eligible_for_rewards',
      match_id: `eq.${idValue}`,
      order: 'team_key.asc,slot_index.asc',
      limit: '10',
    }),
    readRows('core_match_slots', {
      select: 'team_key,slot_index,active_role,updated_at,original_user_id,active_user_id,fill_user_id',
      match_id: `eq.${idValue}`,
      order: 'team_key.asc,slot_index.asc',
      limit: '10',
    }),
  ])
  return { participants, slots, slots_ready: slots.length === 10 && slots.every((slot) => slot.active_user_id && slot.active_role) }
}

async function getMatchHistory(steam, limit = 3) {
  const steam_id = steamId(steam)
  const parsedLimit = integer(limit, 'limit', 1, 20)
  const rows = await readRows('core_match_participants', {
    select: 'steam_id,team_key,slot_index,eligible_for_rewards,core_matches!inner(id,server_id,state,map_name,map_number,started_at,finished_at,result)',
    steam_id: `eq.${steam_id}`,
    order: 'updated_at.desc',
    limit: String(parsedLimit),
  })
  return rows.map((row) => ({
    steam_id: row.steam_id,
    team_key: row.team_key,
    slot_index: row.slot_index,
    eligible_for_rewards: row.eligible_for_rewards,
    match: row.core_matches,
  }))
}

module.exports = { normalizeEvent, ingestCoreMatchEvent, getMatchState, getMatchParticipants, getMatchHistory }
