import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const password = req.headers['x-upload-password']
  if (password !== process.env.UPLOAD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )

  const { error } = await supabase
    .from('dashboard_history')
    .update({ data: null, updated_at: new Date().toISOString() })
    .eq('id', 1)

  if (error) return res.status(500).json({ error: error.message })

  return res.status(200).json({ ok: true })
}
