import { createClient } from '@supabase/supabase-js'
import multiparty from 'multiparty'
import { readFileSync } from 'fs'
import {
  processNewClients,
  processActiveClients,
  processSales,
  processSubscriptions,
  processMeetings,
  computeAtRisk,
  computeOpenDebts,
} from '../lib/processors.js'

export const config = { api: { bodyParser: false } }

const VALID_TYPES = ['new_clients', 'active_clients', 'sales', 'subscriptions', 'meetings']

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const password = req.headers['x-upload-password'] || req.query.password
  if (password !== process.env.UPLOAD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const form = new multiparty.Form({ maxFilesSize: 10 * 1024 * 1024 })

  const { files } = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err)
      else resolve({ fields, files })
    })
  })

  // Read all uploaded buffers into memory
  const buffers = {}
  for (const type of VALID_TYPES) {
    const fileList = files[type]
    if (!fileList || fileList.length === 0) continue
    const file = fileList[0]
    if (!file.originalFilename.endsWith('.xlsx')) continue
    buffers[type] = readFileSync(file.path)
  }

  if (Object.keys(buffers).length === 0) {
    return res.status(400).json({ error: 'No valid Excel files received' })
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )

  // Load existing history from Supabase
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

  // Process each file type
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
    }
    history.client_name_map = buildClientNameMap(buffers.active_clients, history.client_name_map)
  }

  if (buffers.sales) {
    const { periods, debt_updates } = processSales(buffers.sales)
    for (const [period, { revenueTotal, revenuePaid }] of Object.entries(periods)) {
      if (!history.months[period]) history.months[period] = {}
      history.months[period].revenueTotal = revenueTotal
      history.months[period].revenuePaid  = revenuePaid
    }
    for (const { customerId, name, delta } of debt_updates) {
      if (!history.debt_ledger[customerId]) {
        history.debt_ledger[customerId] = { name, balance: 0 }
      }
      history.debt_ledger[customerId].balance += delta
      if (name) history.debt_ledger[customerId].name = name
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

  // Recompute derived KPIs
  history.kpis.openDebts     = computeOpenDebts(history.debt_ledger)
  history.kpis.atRiskClients = computeAtRisk(history.visitor_sets, history.client_name_map)
  history.lastUpdated        = new Date().toISOString()

  // Save to Supabase
  const { error: upsertError } = await supabase
    .from('dashboard_history')
    .upsert({ id: 1, data: history, updated_at: new Date().toISOString() })

  if (upsertError) {
    console.error('Supabase upsert error:', upsertError)
    return res.status(500).json({ error: 'Failed to save data', details: upsertError.message })
  }

  return res.status(200).json({ ok: true, lastUpdated: history.lastUpdated })
}

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
