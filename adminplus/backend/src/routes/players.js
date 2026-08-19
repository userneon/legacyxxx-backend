const express = require('express')
const router = express.Router()
const { getPlayerInfo } = require('../rcon')
const { runAction, requiredToken, boundedInt } = require('../action')

function playerId(value) { return requiredToken(value, 'userid', /^\d{1,5}$/) }
function weapon(value) {
  const name = requiredToken(value, 'weapon', /^[a-z0-9-]{2,32}$/i).toLowerCase()
  const allowed = new Set(['ak47', 'aug', 'awp', 'deagle', 'famas', 'galilar', 'glock', 'm4a1', 'm4a1_silencer', 'm249', 'mac10', 'mag7', 'mp5sd', 'mp7', 'mp9', 'negev', 'nova', 'p250', 'p90', 'scout', 'sg556', 'ssg08', 'taser', 'tec9', 'ump45', 'usp_silencer', 'xm1014', 'hegrenade', 'flashbang', 'smokegrenade', 'molotov'])
  if (!allowed.has(name)) throw new Error('weapon is not allowed')
  return name
}

router.get('/', async (_req, res) => {
  try { res.json(await getPlayerInfo()) } catch (error) { res.status(502).json({ error: error.message }) }
})

const actionRoutes = [
  ['respawn', (body) => { const id = playerId(body.userid); return { id, command: `sm_respawn ${id}`, action: 'player.respawn' } }],
  ['freeze', (body) => { const id = playerId(body.userid); return { id, command: `sm_freeze ${id}`, action: 'player.freeze' } }],
  ['unfreeze', (body) => { const id = playerId(body.userid); return { id, command: `sm_unfreeze ${id}`, action: 'player.unfreeze' } }],
  ['stripweapons', (body) => { const id = playerId(body.userid); return { id, command: `sm_stripweapons ${id}`, action: 'player.stripweapons' } }],
  ['god', (body) => { const id = playerId(body.userid); return { id, command: `sm_god ${id}`, action: 'player.god' } }],
  ['kick', (body) => { const id = playerId(body.userid); return { id, command: `kickid ${id}`, action: 'player.kick' } }],
  ['setteam', (body) => { const id = playerId(body.userid); const team = String(body.team || '').toLowerCase(); if (!['ct', 't', 'spec'].includes(team)) throw new Error('team must be ct, t, or spec'); return { id, command: `sm_setteam ${id} ${team}`, action: 'player.setteam', metadata: { team } } }],
  ['givemoney', (body) => { const id = playerId(body.userid); const amount = boundedInt(body.amount, 'amount', 0, 65535); return { id, command: `sm_givemoney ${id} ${amount}`, action: 'player.givemoney', metadata: { amount } } }],
  ['sethp', (body) => { const id = playerId(body.userid); const hp = boundedInt(body.hp, 'hp', 0, 1000); return { id, command: `sm_sethp ${id} ${hp}`, action: 'player.sethp', metadata: { hp } } }],
  ['giveweapon', (body) => { const id = playerId(body.userid); const name = weapon(body.weapon); return { id, command: `sm_giveweapon ${id} weapon_${name}`, action: 'player.giveweapon', metadata: { weapon: name } } }],
  ['slap', (body) => { const id = playerId(body.userid); const damage = boundedInt(body.damage ?? 0, 'damage', 0, 100); return { id, command: `sm_slap ${id} ${damage}`, action: 'player.slap', metadata: { damage } } }],
]

for (const [path, build] of actionRoutes) {
  router.post(`/${path}`, (req, res) => {
    try {
      const item = build(req.body || {})
      runAction(req, res, { command: item.command, action: item.action, targetType: 'player', targetId: item.id, metadata: item.metadata })
    } catch (error) {
      res.status(400).json({ error: error.message })
    }
  })
}

module.exports = router
