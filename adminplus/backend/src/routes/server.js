const fs = require('fs')
const path = require('path')
const express = require('express')
const router = express.Router()
const { executeCommand } = require('../rcon')
const { runAction, requiredToken, boundedInt } = require('../action')

const OFFICIAL_MAPS = ['de_ancient', 'de_anubis', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke', 'de_overpass', 'de_train', 'de_vertigo', 'cs_italy', 'cs_office']
const ALLOWED_WEAPONS = new Set(['ak47', 'aug', 'awp', 'deagle', 'famas', 'galilar', 'glock', 'm4a1', 'm4a1_silencer', 'm249', 'mac10', 'mag7', 'mp5sd', 'mp7', 'mp9', 'negev', 'nova', 'p250', 'p90', 'scout', 'sg556', 'ssg08', 'taser', 'tec9', 'ump45', 'usp_silencer', 'xm1014', 'hegrenade', 'flashbang', 'smokegrenade', 'molotov'])

function cleanMapName(value) { return String(value || '').trim().replace(/\.(bsp|vpk)$/i, '') }
function isSafeMapName(value) { return /^[a-zA-Z0-9_\-/]{1,96}$/.test(value) }
function isWorkshopId(value) { return /^\d{6,20}$/.test(String(value || '').trim()) }
function envMaps() { return String(process.env.ADMINPLUS_MAPS || '').split(',').map(cleanMapName).filter(Boolean).filter(isSafeMapName) }
function parseMapsOutput(raw) {
  const maps = new Set()
  for (const match of String(raw || '').matchAll(/([a-zA-Z0-9_\-/]+)\.bsp/g)) {
    const map = cleanMapName(match[1]); if (isSafeMapName(map)) maps.add(map)
  }
  return [...maps].sort()
}
function candidateMapDirs() {
  const dirs = String(process.env.ADMINPLUS_MAP_DIRS || '').split(',').map((v) => v.trim()).filter(Boolean)
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const gvfsRoot = uid !== null ? `/run/user/${uid}/gvfs` : null
  if (gvfsRoot && fs.existsSync(gvfsRoot)) for (const entry of fs.readdirSync(gvfsRoot, { withFileTypes: true })) if (entry.isDirectory()) dirs.push(path.join(gvfsRoot, entry.name, 'maps'))
  dirs.push(path.resolve(process.cwd(), '../maps'))
  return [...new Set(dirs)]
}
function discoverMapFiles() {
  const maps = new Set()
  for (const dir of candidateMapDirs()) {
    try {
      if (!fs.existsSync(dir)) continue
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !['.vpk', '.bsp'].includes(path.extname(entry.name).toLowerCase())) continue
        const map = cleanMapName(path.basename(entry.name))
        if (/^(de_|cs_|ar_)/i.test(map) && !/_vanity$/i.test(map) && isSafeMapName(map)) maps.add(map)
      }
    } catch (error) { console.warn(`[Maps] discovery skipped ${dir}:`, error.message) }
  }
  return [...maps].sort()
}

router.post('/restartround', (req, res) => runAction(req, res, { command: 'mp_restartgame 1', action: 'server.restart_round' }))
router.post('/endmatch', (req, res) => runAction(req, res, { command: 'mp_endmatch_votenextmap 0; mp_endmatch 1', action: 'server.end_match' }))
router.post('/warmup', (req, res) => runAction(req, res, { command: 'mp_warmup_start', action: 'server.warmup_start' }))

router.get('/maps', async (_req, res) => {
  const discovered = []
  try { discovered.push(...parseMapsOutput(await executeCommand('maps *'))) } catch (error) { console.warn('[Maps] RCON discovery failed:', error.message) }
  const files = discoverMapFiles()
  res.json({ maps: [...new Set([...OFFICIAL_MAPS, ...envMaps(), ...files, ...discovered])].sort(), official: OFFICIAL_MAPS, configured: envMaps(), files, discovered })
})

router.post('/changelevel', (req, res) => {
  const map = cleanMapName(req.body?.map)
  const mode = String(req.body?.mode || '').trim().toLowerCase()
  if (!map) return res.status(400).json({ error: 'map required' })
  if (mode === 'workshop' || isWorkshopId(map)) {
    if (!isWorkshopId(map)) return res.status(400).json({ error: 'valid workshop id required' })
    return runAction(req, res, { command: `host_workshop_map ${map}`, action: 'server.change_workshop_map', targetId: map, metadata: { mode: 'workshop' }, response: { command: 'host_workshop_map' } })
  }
  if (!isSafeMapName(map)) return res.status(400).json({ error: 'invalid map name' })
  return runAction(req, res, { command: `changelevel ${map}`, action: 'server.change_map', targetId: map, metadata: { mode: 'normal' }, response: { command: 'changelevel' } })
})

router.post('/givemoney/all', (req, res) => {
  try { const amount = boundedInt(req.body?.amount, 'amount', 0, 65535); return runAction(req, res, { command: `sm_givemoney_all ${amount}`, action: 'server.give_money_all', metadata: { amount } }) } catch (error) { return res.status(400).json({ error: error.message }) }
})
router.post('/giveweapon/all', (req, res) => {
  const name = String(req.body?.weapon || '').trim().toLowerCase()
  if (!ALLOWED_WEAPONS.has(name)) return res.status(400).json({ error: 'weapon is not allowed' })
  return runAction(req, res, { command: `sm_giveweapon_all weapon_${name}`, action: 'server.give_weapon_all', metadata: { weapon: name } })
})
router.post('/cvar', (req, res) => {
  const key = String(req.body?.key || '').trim()
  const value = String(req.body?.value ?? '').trim()
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(key) || !value || value.length > 64 || /[;\r\n]/.test(value)) return res.status(400).json({ error: 'invalid cvar or value' })
  return runAction(req, res, { command: `${key} ${value}`, action: 'server.set_cvar', targetId: key, metadata: { value } })
})

module.exports = router
