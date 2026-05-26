import { createClient } from '@supabase/supabase-js'
import { buildChartData } from '../lib/processors.js'

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )

  const { data: row } = await supabase
    .from('dashboard_history')
    .select('data')
    .eq('id', 1)
    .single()

  const history = row?.data

  if (!history) {
    return res.status(503).json({ error: 'No data available yet. Please upload data first.' })
  }

  const { labels, activeClients, newClients, revenueTotal, revenuePaid } =
    buildChartData(history.months || {})

  const kpis    = history.kpis || {}
  const updated = history.lastUpdated
    ? formatHebrewDate(new Date(history.lastUpdated))
    : 'לא ידוע'

  const js = `
const LAST_UPDATED = ${JSON.stringify(updated)};
const MONTHS = ${JSON.stringify(labels)};
const activeClients = ${JSON.stringify(activeClients)};
const newClients = ${JSON.stringify(newClients)};
const revenueTotal = ${JSON.stringify(revenueTotal)};
const revenuePaid = ${JSON.stringify(revenuePaid)};
const openDebts = ${JSON.stringify(kpis.openDebts    || { count: 0, total: 0, names: [] })};
const atRiskClients = ${JSON.stringify(kpis.atRiskClients || { count: 0, names: [] })};
const expiringCards = ${JSON.stringify(kpis.expiringCards || { count: 0, names: [] })};
const noNextMeeting = ${JSON.stringify(kpis.noNextMeeting || { count: 0, names: [] })};
`.trim()

  res.setHeader('Content-Type', 'application/javascript')
  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).send(js)
}

function formatHebrewDate(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
