import { createClient } from '@supabase/supabase-js'
import { del } from '@vercel/blob'
import {
  processNewClients,
  processActiveClients,
  processSales,
  processSubscriptions,
  processMeetings,
  computeAtRisk,
  computeOpenDebts,
} from '../lib/processors.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const password = req.headers['x-upload-password']
  if (password !== process.env.UPLOAD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { blobs } = req.body  // [{ type, url }, ...]

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )

  // Load history from Supabase (or start fresh)
  const { data: row } = await supabase
    .from('dashboard_history')
    .select('data')
    .eq('id', 1)
    .single()

  let history = row?.data || {
    months: {},
    visitor_sets: {},
    debt_ledger: {},
    client_name_map: {},
    kpis: {},
    lastUpdated: null,
  }

  // Download all file buffers
  const buffers = {}
  for (const { type, url } of blobs) {
    const resp = await fetch(url)
    buffers[type] = Buffer.from(await resp.arrayBuffer())
  }

  // ── Process each file type ────────────────────────────────────────────────

  if (buffers.new_clients) {
    const newByPeriod = processNewClients(buffers.new_clients)
    for (const [period, count] of Object.entries(newByPeriod)) {
      if (!history.months[period]) history.months[period] = {}
      history.months[period].newClients = count
    }
  }

  if (buffers.active_clients) {
    const { periods, visitor_sets } = processActiveClients(buffers.active_clients)
    for (const [period, count] of Object.entries(periods)) {
      if (!history.months[period]) history.months[period] = {}
      history.months[period].activeClients = count
    }
    for (const [period, ids] of Object.entries(visitor_sets)) {
      history.visitor_sets[period] = ids

      // Build client name map from this file
      // (CustomerId → name, extracted during processActiveClients already stored in ids)
      // We re-parse here minimally for name mapping
    }
    // Re-build client_name_map from active clients file
    history.client_name_map = buildClientNameMap(buffers.active_clients, history.client_name_map)
  }

  if (buffers.sales) {
    const { periods, debt_updates } = processSales(buffers.sales)
    for (const [period, { revenueTotal, revenuePaid }] of Object.entries(periods)) {
      if (!history.months[period]) history.months[period] = {}
      history.months[period].revenueTotal = revenueTotal
      history.months[period].revenuePaid  = revenuePaid
    }
    // Apply debt updates to ledger
    for (const { customerId, name, delta } of debt_updates) {
      if (!history.debt_ledger[customerId]) {
        history.debt_ledger[customerId] = { name, balance: 0 }
      }
      history.debt_ledger[customerId].balance += delta
      if (name) history.debt_ledger[customerId].name = name
      // Remove if balance effectively zero
      if (Math.abs(history.debt_ledger[customerId].balance) < 0.01) {
        delete history.debt_ledger[customerId]
      }
    }
  }

  if (buffers.subscriptions) {
    const { expiringCards } = processSubscriptions(buffers.subscriptions)
    history.kpis.expiringCards = expiringCards
  }

  if (buffers.meetings) {
    const { noNextMeeting } = processMeetings(
      buffers.meetings,
      buffers.active_clients || null,
    )
    history.kpis.noNextMeeting = noNextMeeting
  }

  // ── Recompute derived KPIs ────────────────────────────────────────────────

  history.kpis.openDebts    = computeOpenDebts(history.debt_ledger)
  history.kpis.atRiskClients = computeAtRisk(history.visitor_sets, history.client_name_map)

  history.lastUpdated = new Date().toISOString()

  // ── Save to Supabase ──────────────────────────────────────────────────────

  await supabase
    .from('dashboard_history')
    .upsert({ id: 1, data: history, updated_at: new Date().toISOString() })

  // ── Delete processed Blobs ────────────────────────────────────────────────

  await Promise.all(blobs.map(({ url }) => del(url)))

  return res.status(200).json({ ok: true, lastUpdated: history.lastUpdated })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildClientNameMap(buf, existing = {}) {
  const XLSX = require('xlsx')
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { raw: false, defval: null })
  const map = { ...existing }
  for (const row of rows) {
    const cid  = row['CustomerId']
    const name = row['Name']
    if (cid && name) map[Number(cid)] = name
  }
  return map
}
