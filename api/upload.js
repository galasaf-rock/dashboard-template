import { createClient } from '@supabase/supabase-js'
import multiparty from 'multiparty'
import { readFileSync } from 'fs'
import {
  extractActiveClientRows,
  extractNewClientRows,
  extractSalesRows,
  extractSubscriptionRows,
  extractMeetingRows,
  deriveAll,
} from '../lib/processors.js'

export const config = { api: { bodyParser: false } }

const VALID_TYPES = ['new_clients', 'active_clients', 'sales', 'subscriptions', 'meetings']

const EXTRACTORS = {
  active_clients: extractActiveClientRows,
  new_clients:    extractNewClientRows,
  sales:          extractSalesRows,
  subscriptions:  extractSubscriptionRows,
  meetings:       extractMeetingRows,
}

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

  const { data: row } = await supabase
    .from('dashboard_history')
    .select('data')
    .eq('id', 1)
    .single()

  let history = row?.data || {}

  // Initialize raw store on first upload
  if (!history.raw) history.raw = {}
  for (const type of VALID_TYPES) {
    if (!history.raw[type]) history.raw[type] = {}
  }

  // Upsert incoming rows — new rows are added, existing rows are updated,
  // rows absent from this upload are kept unchanged
  for (const [type, buf] of Object.entries(buffers)) {
    const incoming = EXTRACTORS[type](buf)
    Object.assign(history.raw[type], incoming)
  }

  // Recompute all derived data from the full raw store
  const derived        = deriveAll(history.raw)
  history.months       = derived.months
  history.visitor_sets = derived.visitor_sets
  history.debt_by_month = derived.debt_by_month
  history.debt_ledger  = derived.debt_ledger
  history.client_name_map = derived.client_name_map
  history.kpis         = derived.kpis
  history.lastUpdated  = new Date().toISOString()

  const { error: upsertError } = await supabase
    .from('dashboard_history')
    .upsert({ id: 1, data: history, updated_at: new Date().toISOString() })

  if (upsertError) {
    console.error('Supabase upsert error:', upsertError)
    return res.status(500).json({ error: 'Failed to save data', details: upsertError.message })
  }

  const { data: verify, error: verifyError } = await supabase
    .from('dashboard_history')
    .select('data')
    .eq('id', 1)
    .single()

  return res.status(200).json({
    ok: true,
    lastUpdated: history.lastUpdated,
    debug: {
      supabaseUrl:      process.env.SUPABASE_URL ? 'set' : 'MISSING',
      supabaseKey:      process.env.SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'MISSING',
      dataAfterUpsert:  verify?.data ? 'populated' : 'null',
      verifyError:      verifyError?.message || null,
    }
  })
}
