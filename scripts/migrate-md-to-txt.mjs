#!/usr/bin/env node
/**
 * One-time migration: renames diary-YYYY-MM-DD.md files in Google Drive to
 * diary-YYYY-MM-DD.txt. Uses a metadata-only rename, so the file id and the
 * full Drive revision history are preserved.
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/migrate-md-to-txt.mjs
 *
 * Add DRY_RUN=1 to list what would be renamed without changing anything.
 */

import http from 'http'
import { randomBytes, createHash } from 'crypto'
import { exec } from 'child_process'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const DRY_RUN = process.env.DRY_RUN === '1'
const PORT = 14321
const REDIRECT_URI = `http://localhost:${PORT}/callback`
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const BASE = 'https://www.googleapis.com/drive/v3'
const FOLDER_NAME = 'linger_diary'

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.')
  process.exit(1)
}

// --- PKCE helpers ---

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pkce() {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

// --- OAuth flow ---

async function getAccessToken() {
  const { verifier, challenge } = pkce()
  const state = base64url(randomBytes(12))

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', SCOPE)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')

  console.log('\nOpening browser for Google authentication...')
  console.log('If the browser does not open, visit:\n' + authUrl.toString() + '\n')
  openBrowser(authUrl.toString())

  const code = await waitForCode(state)

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Token exchange failed: ${body}`)
  }

  const { access_token } = await res.json()
  return access_token
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`
  exec(cmd, () => {})
}

function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`)
      if (url.pathname !== '/callback') return

      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><p>Authentication complete. You can close this tab.</p></body></html>')
      server.close()

      if (error) return reject(new Error(`OAuth error: ${error}`))
      if (state !== expectedState) return reject(new Error('State mismatch'))
      resolve(code)
    })

    server.listen(PORT, '127.0.0.1', () => {})
    server.on('error', reject)
    setTimeout(() => { server.close(); reject(new Error('Timed out waiting for OAuth callback (2 min)')) }, 120_000)
  })
}

// --- Drive helpers ---

function headers(token, extra) {
  return { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache', ...extra }
}

async function driveGet(token, url) {
  const res = await fetch(url, { headers: headers(token) })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${await res.text()}`)
  return res.json()
}

async function findFolder(token) {
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`)
  const { files } = await driveGet(token, `${BASE}/files?q=${q}&fields=files(id)`)
  if (!files.length) throw new Error(`Folder "${FOLDER_NAME}" not found in Drive.`)
  return files[0].id
}

async function listMdFiles(token, folderId) {
  const fields = encodeURIComponent('nextPageToken,files(id,name)')
  const files = []
  let pageToken
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='text/plain'`)
    const url = `${BASE}/files?q=${q}&fields=${fields}&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    const res = await driveGet(token, url)
    if (res.files) files.push(...res.files)
    pageToken = res.nextPageToken
  } while (pageToken)
  return files.filter(f => /^diary-\d{4}-\d{2}-\d{2}\.md$/.test(f.name))
}

async function renameToTxt(token, fileId, newName) {
  const res = await fetch(`${BASE}/files/${fileId}?fields=id`, {
    method: 'PATCH',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: newName }),
  })
  if (!res.ok) throw new Error(`Rename failed: ${res.status}: ${await res.text()}`)
}

// --- Main ---

async function main() {
  const token = await getAccessToken()
  console.log('Authenticated.\n')

  const folderId = await findFolder(token)
  const mdFiles = await listMdFiles(token, folderId)

  if (mdFiles.length === 0) {
    console.log('No .md diary files found. Nothing to migrate.')
    return
  }

  console.log(`Found ${mdFiles.length} .md file(s) to rename${DRY_RUN ? ' (dry run)' : ''}.\n`)

  let migrated = 0
  const errors = []

  for (const file of mdFiles) {
    const newName = file.name.replace(/\.md$/, '.txt')
    process.stdout.write(`  ${file.name} → ${newName}`)

    if (DRY_RUN) {
      console.log(' (skipped: dry run)')
      continue
    }

    try {
      await renameToTxt(token, file.id, newName)
      console.log('')
      migrated++
    } catch (e) {
      console.log(` ERROR: ${e.message}`)
      errors.push({ name: file.name, error: e.message })
    }
  }

  console.log(`\nDone. renamed=${migrated}, errors=${errors.length}`)
  if (errors.length) {
    console.error('\nFailed files:')
    errors.forEach(e => console.error(`  ${e.name}: ${e.error}`))
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
