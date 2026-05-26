import { put } from '@vercel/blob'
import multiparty from 'multiparty'
import { readFileSync } from 'fs'

export const config = { api: { bodyParser: false } }

const VALID_TYPES = ['new_clients', 'active_clients', 'sales', 'subscriptions', 'meetings']

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Simple password check
  const password = req.headers['x-upload-password'] || req.query.password
  if (password !== process.env.UPLOAD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const form = new multiparty.Form({ maxFilesSize: 10 * 1024 * 1024 })

  const { fields, files } = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err)
      else resolve({ fields, files })
    })
  })

  const uploaded = []

  for (const type of VALID_TYPES) {
    const fileList = files[type]
    if (!fileList || fileList.length === 0) continue

    const file = fileList[0]
    if (!file.originalFilename.endsWith('.xlsx')) continue

    const buf = readFileSync(file.path)
    const blob = await put(`uploads/${type}_${Date.now()}.xlsx`, buf, {
      access: 'public',
      addRandomSuffix: false,
      metadata: { type },
    })

    uploaded.push({ type, url: blob.url })
  }

  if (uploaded.length === 0) {
    return res.status(400).json({ error: 'No valid Excel files received' })
  }

  // Trigger processing
  const baseUrl = `https://${req.headers.host}`
  await fetch(`${baseUrl}/api/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-upload-password': process.env.UPLOAD_PASSWORD,
    },
    body: JSON.stringify({ blobs: uploaded }),
  })

  return res.status(200).json({ ok: true, uploaded })
}
