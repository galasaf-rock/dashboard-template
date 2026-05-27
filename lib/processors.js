const XLSX = require('xlsx')

// ── Helpers ───────────────────────────────────────────────────────────────────

function periodKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function toDate(val) {
  if (!val) return null
  if (val instanceof Date) return val
  if (typeof val === 'object' && val.y !== undefined) {
    return new Date(val.y, val.m - 1, val.d, val.H || 0, val.M || 0, val.S || 0)
  }
  return null
}

function readSheet(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json(ws, { raw: true, defval: null })
}

function hebrewMonth(year, month) {
  const MONTHS_HE = [
    "ינו׳", "פבר׳", "מרץ", "אפר׳", "מאי", "יוני",
    "יולי", "אוג׳", "ספט׳", "אוק׳", "נוב׳", "דצמ׳"
  ]
  return `${MONTHS_HE[month - 1]} '${String(year).slice(2)}`
}

// ── Extract functions ─────────────────────────────────────────────────────────
// Each returns { key: normalizedRow } for upsert into history.raw.
// Keys are stable identifiers so re-uploading the same row never double-counts.

function extractActiveClientRows(buf) {
  const rows = readSheet(buf)
  const result = {}
  for (const row of rows) {
    const cid = row['CustomerId']
    if (!cid) continue
    const lv = toDate(row['LastVisit'])
    const nm = toDate(row['NextMeeting'])
    result[String(cid)] = {
      customerId: String(cid),
      name: row['Name'] || '',
      lastVisit:    lv && !isNaN(lv) ? lv.toISOString() : null,
      nextMeeting:  nm && !isNaN(nm) ? nm.toISOString() : null,
    }
  }
  return result
}

function extractNewClientRows(buf) {
  const rows = readSheet(buf)
  const result = {}
  for (const row of rows) {
    const cid = row['CustomerId']
    if (!cid) continue
    const visits = parseFloat(row['NumberOfVisits']) || 0
    if (visits <= 0) continue
    const created = toDate(row['CreatedOn'])
    if (!created || isNaN(created)) continue
    result[String(cid)] = {
      customerId: String(cid),
      createdOn: created.toISOString(),
      numberOfVisits: visits,
    }
  }
  return result
}

function extractSalesRows(buf) {
  const rows = readSheet(buf)
  const result = {}
  for (const row of rows) {
    const dateVal = toDate(row['תאריך'])
    if (!dateVal || isNaN(dateVal)) continue
    const amount = parseFloat(row['סכום']) || 0
    const debt   = parseFloat(row['חוב'])  || 0
    const cid    = row['CustomerId'] ? String(row['CustomerId']) : 'unknown'
    const name   = row['לקוח'] || ''
    // Composite key: same transaction re-uploaded produces the same key → no duplicate
    const key = `${cid}_${dateVal.toISOString().slice(0, 10)}_${amount}_${debt}`
    if (!result[key]) {
      result[key] = { customerId: cid, name, date: dateVal.toISOString(), amount, debt }
    }
  }
  return result
}

function extractSubscriptionRows(buf) {
  const rows = readSheet(buf)
  const result = {}
  for (const row of rows) {
    const name = row['לקוח'] || ''
    if (!name) continue
    const remaining = parseFloat(row['נותרו'])
    result[name] = { name, remaining: isNaN(remaining) ? null : remaining }
  }
  return result
}

function extractMeetingRows(buf) {
  const rows = readSheet(buf)
  const result = {}
  for (const row of rows) {
    const cid = row['CustomerId']
    const t   = toDate(row['MeetingStartTime'])
    if (!cid || !t || isNaN(t)) continue
    const key = `${cid}_${t.toISOString()}`
    result[key] = {
      customerId:       String(cid),
      customerName:     row['CustomerName'] || '',
      meetingStartTime: t.toISOString(),
    }
  }
  return result
}

// ── deriveAll ─────────────────────────────────────────────────────────────────
// Recomputes every derived field (months, visitor_sets, debt, KPIs) from raw rows.
// Called after every upsert so all aggregates stay consistent.

function deriveAll(raw) {
  const months         = {}
  const visitor_sets   = {}
  const client_name_map = {}

  // active_clients → visitor_sets, activeClients count, client_name_map
  for (const row of Object.values(raw.active_clients || {})) {
    if (!row.lastVisit) continue
    const lv = new Date(row.lastVisit)
    if (isNaN(lv)) continue
    const key = periodKey(lv)
    if (!visitor_sets[key]) visitor_sets[key] = []
    const id = Number(row.customerId)
    if (!visitor_sets[key].includes(id)) visitor_sets[key].push(id)
    if (row.name) client_name_map[id] = row.name
  }
  for (const [period, ids] of Object.entries(visitor_sets)) {
    if (!months[period]) months[period] = {}
    months[period].activeClients = ids.length
  }

  // new_clients → newClients count per period
  for (const row of Object.values(raw.new_clients || {})) {
    if (!row.createdOn) continue
    const created = new Date(row.createdOn)
    if (isNaN(created)) continue
    const key = periodKey(created)
    if (!months[key]) months[key] = {}
    months[key].newClients = (months[key].newClients || 0) + 1
  }

  // sales → revenueTotal, revenuePaid, debt_by_month
  const debt_by_month  = {}
  const salesByPeriod  = {}
  for (const row of Object.values(raw.sales || {})) {
    const d = new Date(row.date)
    if (isNaN(d)) continue
    const key = periodKey(d)
    if (!salesByPeriod[key]) salesByPeriod[key] = []
    salesByPeriod[key].push(row)
    if (row.debt !== 0 && row.customerId && row.customerId !== 'unknown') {
      if (!debt_by_month[key]) debt_by_month[key] = {}
      if (!debt_by_month[key][row.customerId]) {
        debt_by_month[key][row.customerId] = { name: row.name, delta: 0 }
      }
      debt_by_month[key][row.customerId].delta += row.debt
      if (row.name) debt_by_month[key][row.customerId].name = row.name
    }
  }
  for (const [key, rows] of Object.entries(salesByPeriod)) {
    let revenueTotal = 0, outstandingDebt = 0
    for (const row of rows) {
      if (row.amount > 0 && row.debt >= 0) {
        revenueTotal += row.amount
        if (row.debt > 0) outstandingDebt += row.debt
      }
      // debt < 0 = old-debt payment — excluded from revenueTotal
    }
    if (!months[key]) months[key] = {}
    months[key].revenueTotal = revenueTotal
    months[key].revenuePaid  = Math.max(0, revenueTotal - outstandingDebt)
  }

  const debt_ledger = recomputeDebtLedger(debt_by_month)

  // subscriptions → expiringCards
  const expiringNames = []
  for (const row of Object.values(raw.subscriptions || {})) {
    if (row.remaining >= 1 && row.remaining <= 2) expiringNames.push(row.name)
  }
  const expiringCards = { count: expiringNames.length, names: expiringNames }

  // meetings + active_clients → noNextMeeting
  const now = new Date()
  const nextMeetingMap = {}
  for (const row of Object.values(raw.active_clients || {})) {
    const nm = row.nextMeeting ? new Date(row.nextMeeting) : null
    nextMeetingMap[row.customerId] = nm && nm > now ? nm : null
  }
  const monthCounts = {}
  for (const row of Object.values(raw.meetings || {})) {
    const t = new Date(row.meetingStartTime)
    if (isNaN(t)) continue
    const key = periodKey(t)
    monthCounts[key] = (monthCounts[key] || 0) + 1
  }
  const targetPeriod = Object.entries(monthCounts).sort((a, b) => b[1] - a[1])[0]?.[0]
  const seenMeeting  = new Set()
  const noNextNames  = []
  for (const row of Object.values(raw.meetings || {})) {
    const t = new Date(row.meetingStartTime)
    if (isNaN(t) || periodKey(t) !== targetPeriod) continue
    if (seenMeeting.has(row.customerId)) continue
    seenMeeting.add(row.customerId)
    if (!nextMeetingMap[row.customerId]) noNextNames.push(row.customerName)
  }
  const noNextMeeting = { count: noNextNames.length, names: noNextNames.sort() }

  return {
    months,
    visitor_sets,
    debt_by_month,
    debt_ledger,
    client_name_map,
    kpis: {
      expiringCards,
      noNextMeeting,
      atRiskClients: computeAtRisk(visitor_sets, client_name_map),
      openDebts:     computeOpenDebts(debt_ledger),
    },
  }
}

// ── recomputeDebtLedger ───────────────────────────────────────────────────────

function recomputeDebtLedger(debt_by_month) {
  const ledger = {}
  for (const periodEntries of Object.values(debt_by_month)) {
    for (const [cid, { name, delta }] of Object.entries(periodEntries)) {
      if (!ledger[cid]) ledger[cid] = { name, balance: 0 }
      ledger[cid].balance += delta
      if (name) ledger[cid].name = name
    }
  }
  for (const cid of Object.keys(ledger)) {
    if (Math.abs(ledger[cid].balance) < 0.01) delete ledger[cid]
  }
  return ledger
}

// ── computeAtRisk ─────────────────────────────────────────────────────────────

function computeAtRisk(visitor_sets, clientNameMap) {
  const periods = Object.keys(visitor_sets).sort()
  if (periods.length < 2) return { count: 0, names: [] }

  const latest     = periods[periods.length - 1]
  const [ly, lm]   = latest.split('-').map(Number)
  const prev       = periodKey(new Date(ly, lm - 2, 1))

  const prevSet    = new Set(visitor_sets[prev]   || [])
  const currentSet = new Set(visitor_sets[latest] || [])

  const names = [...prevSet]
    .filter(id => !currentSet.has(id))
    .map(id => clientNameMap[id] || String(id))
    .sort()

  return { count: names.length, names }
}

// ── computeOpenDebts ──────────────────────────────────────────────────────────

function computeOpenDebts(debt_ledger) {
  const open = Object.values(debt_ledger).filter(e => e.balance > 0)
  open.sort((a, b) => b.balance - a.balance)
  const names = open.map(e => `${e.name} – ${Math.round(e.balance).toLocaleString('he-IL')} ₪`)
  const total = open.reduce((s, e) => s + e.balance, 0)
  return { count: open.length, total: Math.round(total), names }
}

// ── buildChartData ────────────────────────────────────────────────────────────

function buildChartData(months_history, maxMonths = 12) {
  const now           = new Date()
  const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const visible = Object.keys(months_history)
    .filter(k => k <= currentPeriod)
    .sort()
    .slice(-maxMonths)

  const labels = [], activeClients = [], newClients = [], revenueTotal = [], revenuePaid = []

  for (const key of visible) {
    const [y, m] = key.split('-').map(Number)
    labels.push(hebrewMonth(y, m))
    const d = months_history[key]
    activeClients.push(d.activeClients ?? null)
    newClients.push(d.newClients       ?? null)
    revenueTotal.push(d.revenueTotal   ?? null)
    revenuePaid.push(d.revenuePaid     ?? null)
  }

  return { labels, activeClients, newClients, revenueTotal, revenuePaid }
}

module.exports = {
  extractActiveClientRows,
  extractNewClientRows,
  extractSalesRows,
  extractSubscriptionRows,
  extractMeetingRows,
  deriveAll,
  recomputeDebtLedger,
  computeAtRisk,
  computeOpenDebts,
  buildChartData,
}
