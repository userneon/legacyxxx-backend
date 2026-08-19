const { value } = require('./config')

async function notifyDiscord({ action, targetType, targetId, requestId, metadata = {} }) {
  if (value('DISCORD_WEBHOOK_ENABLED', 'false') !== 'true') return
  const webhook = value('DISCORD_WEBHOOK_URL')
  if (!webhook || !/^https:\/\/discord\.com\/api\/webhooks\//.test(webhook)) {
    console.warn('[AdminPlus] Discord webhook is enabled but URL is invalid')
    return
  }

  const fields = [
    { name: 'Action', value: action, inline: true },
    { name: 'Target', value: `${targetType}${targetId ? `:${targetId}` : ''}`, inline: true },
    { name: 'Request ID', value: requestId || 'n/a', inline: false },
  ]
  if (metadata && Object.keys(metadata).length) fields.push({ name: 'Metadata', value: JSON.stringify(metadata).slice(0, 900), inline: false })

  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'LEGACY-X AdminPlus', embeds: [{ title: 'Admin action', color: 0x7c3aed, fields, timestamp: new Date().toISOString() }] }),
    })
    if (!response.ok) console.warn(`[AdminPlus] Discord webhook failed with ${response.status}`)
  } catch (error) {
    console.warn('[AdminPlus] Discord webhook error:', error.message)
  }
}

module.exports = { notifyDiscord }
