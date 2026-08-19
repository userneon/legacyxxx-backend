const { value } = require('./config')

function auditEnabled() {
  return value('LEGACYX_AUDIT_ENABLED', 'true') === 'true'
}

function auditUrl() {
  const base = value('SUPABASE_URL').replace(/\/$/, '')
  const schema = encodeURIComponent(value('LEGACYX_DB_SCHEMA', 'legacy_x'))
  const table = encodeURIComponent(value('LEGACYX_AUDIT_TABLE', 'adminplus_audit_logs'))
  return `${base}/rest/v1/${table}?select=id`
}

async function recordAction({ req, action, targetType = 'server', targetId = null, command = null, metadata = {} }) {
  if (!auditEnabled()) return
  const serviceRoleKey = value('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceRoleKey) return

  const row = {
    actor_type: 'adminplus',
    actor_id: value('ADMINPLUS_INSTANCE_ID', 'legacy-x-adminplus'),
    action,
    target_type: targetType,
    target_id: targetId === null || targetId === undefined ? null : String(targetId),
    metadata: {
      ...metadata,
      ip: req?.ip || null,
      userAgent: req?.get?.('user-agent') || null,
      command: value('LEGACYX_AUDIT_INCLUDE_COMMANDS', 'false') === 'true' ? command : undefined,
    },
  }

  try {
    const response = await fetch(auditUrl(), {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
        'Content-Profile': value('LEGACYX_DB_SCHEMA', 'legacy_x'),
      },
      body: JSON.stringify(row),
    })
    if (!response.ok) {
      const text = await response.text()
      console.warn(`[AdminPlus] audit insert skipped (${response.status}): ${text.slice(0, 240)}`)
    }
  } catch (error) {
    console.warn('[AdminPlus] audit insert failed:', error.message)
  }
}

module.exports = { recordAction }
