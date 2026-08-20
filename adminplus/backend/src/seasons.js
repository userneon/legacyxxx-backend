const { value } = require('./config')
const { rpc, readRows } = require('./rank')

async function getActiveSeason() {
  const rows = await readRows('rank_seasons', {
    select: 'id,slug,name,period_start,period_end,created_at',
    is_active: 'eq.true',
    order: 'created_at.desc',
    limit: '1',
  })
  return rows[0] || null
}

async function rollover(source = 'scheduler') {
  return rpc('rollover_monthly_rank_season', { p_source: source })
}

function startMonthlySeasonScheduler({ onSuccess = () => {}, onError = () => {} } = {}) {
  if (value('LEGACYX_SEASON_SCHEDULER_ENABLED', 'true') !== 'true') return () => {}
  const intervalMs = Math.max(60_000, Number.parseInt(value('LEGACYX_SEASON_SCHEDULER_INTERVAL_MS', '3600000'), 10) || 3_600_000)
  let running = false
  const check = async () => {
    if (running) return
    running = true
    try { onSuccess(await rollover('scheduler')) } catch (error) { onError(error) } finally { running = false }
  }
  void check()
  const timer = setInterval(() => void check(), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

module.exports = { getActiveSeason, rollover, startMonthlySeasonScheduler }
