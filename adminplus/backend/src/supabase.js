/** Supabase REST helpers (service role) shared by the Match Core, reconnect and public read modules. */
const { value } = require('./config')

function serviceHeaders(profile = false) {
  const serviceRoleKey = value('SUPABASE_SERVICE_ROLE_KEY')
  const schema = value('LEGACYX_DB_SCHEMA', 'legacy_x')
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    ...(profile ? { 'Content-Profile': schema, 'Accept-Profile': schema } : {}),
  }
}

function supabaseUrl(pathname) {
  return `${value('SUPABASE_URL').replace(/\/$/, '')}${pathname}`
}


async function rpc(name, payload) {
  const response = await fetch(supabaseUrl(`/rest/v1/rpc/${name}`), {
    method: 'POST',
    headers: serviceHeaders(true),
    body: JSON.stringify(payload),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Supabase RPC ${name} failed (${response.status}): ${body.slice(0, 240)}`)
  return body ? JSON.parse(body) : null
}


async function readRows(view, params) {
  const url = new URL(supabaseUrl(`/rest/v1/${view}`))
  Object.entries(params).forEach(([key, row]) => url.searchParams.set(key, row))
  const response = await fetch(url, { headers: serviceHeaders(true) })
  const body = await response.text()
  if (!response.ok) throw new Error(`Supabase read ${view} failed (${response.status}): ${body.slice(0, 240)}`)
  return JSON.parse(body)
}


module.exports = { rpc, readRows }
