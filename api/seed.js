import { createClient } from '@supabase/supabase-js'

// One-time seed endpoint — loads May 2026 real data into KV
// Call once: POST /api/seed?password=<UPLOAD_PASSWORD>

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const password = req.query.password || req.headers['x-upload-password']
  if (password !== process.env.UPLOAD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )

  const { data: existing } = await supabase
    .from('dashboard_history')
    .select('id')
    .eq('id', 1)
    .single()

  if (existing) {
    return res.status(409).json({ error: 'History already exists. Delete it first if you want to re-seed.' })
  }

  const history = {
    months: {
      '2026-05': {
        activeClients: 40,
        newClients:    5,
        revenueTotal:  17720,
        revenuePaid:   13390,
      },
    },
    visitor_sets: {
      '2026-05': [
        1739, 2778, 13298, 26014, 28039, 30058, 31075, 48346, 50742, 54421,
        54422, 54423, 54424, 54425, 54426, 54427, 54428, 54429, 54430, 54431,
        54432, 54433, 54434, 54435, 54436, 54437, 54438, 54439, 54440, 54441,
        54442, 54443, 54444, 54445, 54446, 54447, 54448, 54449, 54450, 56442,
        56443, 56444, 56445, 56446, 56447, 56448, 56449, 56450, 56451, 56452,
        56453, 56454, 56455, 56456,
      ],
    },
    client_name_map: {},
    debt_ledger: {
      // CustomerId (string) → { name, balance }
      // Based on analyzed TotalSales (2).xlsx
      // Exact IDs unknown for מזל עמון / ליאת כהן / חלי אואקנין at seed time
      // Will be populated correctly on first real upload
    },
    kpis: {
      openDebts: {
        count: 3,
        total: 3050,
        names: ['מזל עמון – 1,250 ₪', 'ליאת כהן – 1,250 ₪', 'חלי אואקנין – 550 ₪'],
      },
      atRiskClients: {
        count: 9,
        names: ['מליס אקא', 'עמית כהן', 'רחל אהרון', 'שירה איטח', 'סימה עזרא', 'אוולין חלביה', 'שירה אשכנזי', 'רחל חלפון', 'בן חכמון'],
      },
      expiringCards: {
        count: 14,
        names: ['דיאנה יונוסוב', 'צליל חיים', 'שירי שחורי', 'תמי דהרי', 'רווית בן דוד', 'פייגה סבג', 'מיכל מור', 'לין סבאג', 'חן אהוד', 'מעיין גרטנר', 'שירה אשכנזי', 'אודליה ברנס', 'לירי כהן', 'מרינה בקייב'],
      },
      noNextMeeting: {
        count: 39,
        names: ['אבירן רופא', 'אודליה שרעבי', 'אוולין חלביה', 'אופיר בן דוד', 'אורי שירי', 'אילנה יהב', 'איריס שגב', 'אתי נאמן', 'בן מלייב', 'גיל יצחק', 'הילה שחר', 'הראל יונוסוב', 'חלי אואקנין', 'טליה רז', 'טלר שוהם', 'ירין חיי', 'כריסטינה נניוצנקו', 'ליאל חלביה', 'ליאת כהן', 'מזל ראוי', 'מיה שירי', 'מעיין אואקנין', 'ניר לבלוביץ', 'סאלי רופא', 'סיגל בבני', 'סיגל גואטה', 'סימה קריו', 'ספיר בראון', 'עמית אנץ', 'פנינה אבן שוע', 'רותם אואקנין', 'ריקי סיטון', 'שושי בן חמו', 'שושי מישורי', 'שחר מאור', 'שירה איטח', 'שירה אשכנזי', 'שירי שחורי', 'תהל דורלה'],
      },
    },
    lastUpdated: new Date().toISOString(),
  }

  await supabase
    .from('dashboard_history')
    .insert({ id: 1, data: history, updated_at: new Date().toISOString() })

  return res.status(200).json({ ok: true, message: 'Seeded with May 2026 data' })
}
