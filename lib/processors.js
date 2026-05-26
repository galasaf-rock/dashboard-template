const XLSX = require('xlsx')

// ── Helpers ───────────────────────────────────────────────────────────────────

function periodKey(date) {
  // Returns "YYYY-MM" from a JS Date
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function xlsxDateToJs(serial) {
  // SheetJS stores dates as serial numbers when {raw:true}
  if (serial instanceof Date) return serial
  if (typeof serial === 'number') return XLSX.SSF.parse_date_code(serial)
  return null
}

function toDate(val) {
  if (!val) return null
  if (val instanceof Date) return val
  // SheetJS date object {y,m,d,H,M,S}
  if (typeof val === 'object' && val.y !== undefined) {
    return new Date(val.y, val.m - 1, val.d, val.H || 0, val.M || 0, val.S || 0)
  }
  return null
}

function readSheet(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json(ws, { raw: false, defval: null })
}

function hebrewMonth(year, month) {
  const MONTHS_HE = [
    "ינו׳", "פבר׳", "מרץ", "אפר׳", "מאי", "יוני",
    "יולי", "אוג׳", "ספט׳", "אוק׳", "נוב׳", "דצמ׳"
  ]
  const shortYear = String(year).slice(2)
  return `${MONTHS_HE[month - 1]} '${shortYear}`
}

// ── processNewClients ─────────────────────────────────────────────────────────
// File: Customers (5) — has CreatedOn + NumberOfVisits
// Result: { "2026-05": 5, ... } — new clients count per period

function processNewClients(buf) {
  const rows = readSheet(buf)
  const byPeriod = {}

  for (const row of rows) {
    const created = toDate(row['CreatedOn'] ? new Date(row['CreatedOn']) : null)
    const visits = parseFloat(row['NumberOfVisits']) || 0
    if (!created || isNaN(created.getTime())) continue
    if (visits <= 0) continue

    const key = periodKey(created)
    byPeriod[key] = (byPeriod[key] || 0) + 1
  }

  return byPeriod  // { "2026-05": 5, ... }
}

// ── processActiveClients ──────────────────────────────────────────────────────
// File: Customers (6) — has LastVisit, NextMeeting, CustomerId
// Result: { periods: { "2026-05": 40, ... }, visitor_sets: { "2026-05": [ids] } }

function processActiveClients(buf) {
  const rows = readSheet(buf)
  const periods = {}
  const visitor_sets = {}

  for (const row of rows) {
    const lv = row['LastVisit'] ? new Date(row['LastVisit']) : null
    if (!lv || isNaN(lv.getTime())) continue

    const cid = row['CustomerId']
    const key = periodKey(lv)

    periods[key] = (periods[key] || 0) + 1
    if (!visitor_sets[key]) visitor_sets[key] = []
    if (cid && !visitor_sets[key].includes(Number(cid))) {
      visitor_sets[key].push(Number(cid))
    }
  }

  return { periods, visitor_sets }
}

// ── processSales ──────────────────────────────────────────────────────────────
// File: TotalSales — has תאריך, סכום, חוב, לקוח, CustomerId
// Result: { periods: { "2026-05": { revenueTotal, revenuePaid } }, debt_updates: [...] }

function processSales(buf) {
  const rows = readSheet(buf)
  const byPeriod = {}      // period → { sales: [], debts: [] }
  const debt_updates = []  // { customerId, name, delta }

  for (const row of rows) {
    const dateVal = row['תאריך'] ? new Date(row['תאריך']) : null
    if (!dateVal || isNaN(dateVal.getTime())) continue

    const amount = parseFloat(row['סכום']) || 0
    const debt   = parseFloat(row['חוב'])  || 0
    const key    = periodKey(dateVal)
    const cid    = row['CustomerId'] ? String(row['CustomerId']) : null
    const name   = row['לקוח'] || ''

    if (!byPeriod[key]) byPeriod[key] = { salesRows: [] }
    byPeriod[key].salesRows.push({ amount, debt })

    // Update debt ledger for every row with non-zero debt
    if (debt !== 0 && cid) {
      debt_updates.push({ customerId: cid, name, delta: debt })
    }
  }

  // Compute revenueTotal / revenuePaid per period
  const periods = {}
  for (const [key, { salesRows }] of Object.entries(byPeriod)) {
    let revenueTotal = 0
    let outstandingDebt = 0

    for (const { amount, debt } of salesRows) {
      if (amount > 0 && debt >= 0) {
        // New sale row
        revenueTotal += amount
        if (debt > 0) outstandingDebt += debt
      }
      // Rows with debt < 0 are old-debt payments — excluded from revenueTotal
    }

    periods[key] = {
      revenueTotal,
      revenuePaid: Math.max(0, revenueTotal - outstandingDebt),
    }
  }

  return { periods, debt_updates }
}

// ── processSubscriptions ──────────────────────────────────────────────────────
// File: Subscriptions — has לקוח, נותרו
// Result: { expiringCards: { count, names } }

function processSubscriptions(buf) {
  const rows = readSheet(buf)
  const seen = new Set()
  const names = []

  for (const row of rows) {
    const remaining = parseFloat(row['נותרו'])
    const client    = row['לקוח'] || ''
    if (remaining >= 1 && remaining <= 2 && !seen.has(client)) {
      seen.add(client)
      names.push(client)
    }
  }

  return { expiringCards: { count: names.length, names } }
}

// ── processMeetings ───────────────────────────────────────────────────────────
// File: MeetingClosings — has CustomerId, CustomerName, MeetingStartTime
// Needs visitor_sets from active clients to cross-reference NextMeeting
// Also needs activeClientRows for NextMeeting lookup
// Result: { noNextMeeting: { count, names } }

function processMeetings(meetingsBuf, activeClientsBuf) {
  const meetingRows = readSheet(meetingsBuf)

  // Build a map of CustomerId → NextMeeting from the active clients file
  const nextMeetingMap = {}
  if (activeClientsBuf) {
    const clientRows = readSheet(activeClientsBuf)
    const now = new Date()
    for (const row of clientRows) {
      const cid = row['CustomerId']
      const nm  = row['NextMeeting'] ? new Date(row['NextMeeting']) : null
      if (cid) {
        nextMeetingMap[String(cid)] = nm && nm > now ? nm : null
      }
    }
  }

  // Find the dominant month from meeting start times
  const monthCounts = {}
  for (const row of meetingRows) {
    const t = row['MeetingStartTime'] ? new Date(row['MeetingStartTime']) : null
    if (!t || isNaN(t.getTime())) continue
    const key = periodKey(t)
    monthCounts[key] = (monthCounts[key] || 0) + 1
  }
  const targetPeriod = Object.entries(monthCounts).sort((a, b) => b[1] - a[1])[0]?.[0]

  // Unique customers who had a meeting in the target period
  const seen = new Set()
  const noNext = []

  for (const row of meetingRows) {
    const t = row['MeetingStartTime'] ? new Date(row['MeetingStartTime']) : null
    if (!t || isNaN(t.getTime())) continue
    if (periodKey(t) !== targetPeriod) continue

    const cid  = String(row['CustomerId'] || '')
    const name = row['CustomerName'] || ''
    if (seen.has(cid)) continue
    seen.add(cid)

    const hasNextMeeting = nextMeetingMap[cid] != null
    if (!hasNextMeeting) noNext.push(name)
  }

  return { noNextMeeting: { count: noNext.length, names: noNext.sort() } }
}

// ── computeAtRisk ─────────────────────────────────────────────────────────────
// Clients who visited in the previous month but NOT in the current month
// visitor_sets: { "2026-04": [ids], "2026-05": [ids] }

function computeAtRisk(visitor_sets, clientNameMap) {
  const periods = Object.keys(visitor_sets).sort()
  if (periods.length < 2) return { count: 0, names: [] }

  const latest  = periods[periods.length - 1]
  const [ly, lm] = latest.split('-').map(Number)
  const prevDate = new Date(ly, lm - 2, 1)  // one month back
  const prev = periodKey(prevDate)

  const prevSet    = new Set(visitor_sets[prev]  || [])
  const currentSet = new Set(visitor_sets[latest] || [])

  const atRiskIds = [...prevSet].filter(id => !currentSet.has(id))
  const names = atRiskIds
    .map(id => clientNameMap[id] || String(id))
    .sort()

  return { count: names.length, names }
}

// ── computeOpenDebts ──────────────────────────────────────────────────────────
// From accumulated debt_ledger: { customerId: { name, balance } }

function computeOpenDebts(debt_ledger) {
  const open = Object.values(debt_ledger).filter(e => e.balance > 0)
  open.sort((a, b) => b.balance - a.balance)

  const names = open.map(e => `${e.name} – ${Math.round(e.balance).toLocaleString('he-IL')} ₪`)
  const total = open.reduce((s, e) => s + e.balance, 0)

  return { count: open.length, total: Math.round(total), names }
}

// ── buildChartData ────────────────────────────────────────────────────────────
// From history.months → arrays for the last MAX_MONTHS months with data

function buildChartData(months_history, maxMonths = 12) {
  const sortedKeys = Object.keys(months_history).sort()
  const visible    = sortedKeys.slice(-maxMonths)

  const labels        = []
  const activeClients = []
  const newClients    = []
  const revenueTotal  = []
  const revenuePaid   = []

  for (const key of visible) {
    const [y, m] = key.split('-').map(Number)
    labels.push(hebrewMonth(y, m))
    const d = months_history[key]
    activeClients.push(d.activeClients ?? null)
    newClients.push(d.newClients    ?? null)
    revenueTotal.push(d.revenueTotal ?? null)
    revenuePaid.push(d.revenuePaid  ?? null)
  }

  return { labels, activeClients, newClients, revenueTotal, revenuePaid }
}

module.exports = {
  processNewClients,
  processActiveClients,
  processSales,
  processSubscriptions,
  processMeetings,
  computeAtRisk,
  computeOpenDebts,
  buildChartData,
}
