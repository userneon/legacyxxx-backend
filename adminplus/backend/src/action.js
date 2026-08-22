const { executeCommand } = require('./rcon')
const { recordAction } = require('./audit')

async function runAction(req, res, { command, action, targetType = 'server', targetId = null, metadata = {}, response = {} }) {
  try {
    await executeCommand(command)
    await recordAction({ req, action, targetType, targetId, command, metadata })
    res.json({ ok: true, ...response })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
}

function requiredToken(value, name, pattern = /^[a-zA-Z0-9_.:-]{1,64}$/) {
  const token = String(value ?? '').trim()
  if (!pattern.test(token)) throw new Error(`${name} is invalid`)
  return token
}

function boundedInt(value, name, min, max) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return number
}

module.exports = { runAction, requiredToken, boundedInt }
