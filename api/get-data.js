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

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({
    lastUpdated: updated,
    months: labels,
    activeClients,
    newClients,
    revenueTotal,
    revenuePaid,
    openDebts:     kpis.openDebts     || { count: 0, total: 0, names: [] },
    atRiskClients: kpis.atRiskClients || { count: 0, names: [] },
    expiringCards: kpis.expiringCards || { count: 0, names: [] },
    noNextMeeting: kpis.noNextMeeting || { count: 0, names: [] },
  })
}

function formatHebrewDate(date) {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replace(',', '')
}
