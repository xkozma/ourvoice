import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { load as loadCheerio } from 'cheerio'
import { randomUUID, createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import twilio from 'twilio'
import supabase from './supabaseClient.js'

dotenv.config({ path: new URL('../.env', import.meta.url) })

const app = express()
const PORT = process.env.PORT || 4000
const JWT_SECRET = process.env.JWT_SECRET || 'ourvoice-dev-secret'
const TWILIO_FROM = process.env.TWILIO_FROM || '+14058515936'
const DEV = process.env.DEV === 'true'
const DEV_BYPASS_CODE = '456123'
const DEFAULT_CORS_ORIGINS = ['http://localhost:5173']
const hasExplicitCorsOrigins = Boolean(process.env.CORS_ORIGIN?.trim())

// Twilio client — initialised lazily so missing creds only error at runtime
let _twilioClient = null
function getTwilioClient() {
  if (!_twilioClient) {
    const sid = process.env.TWILIO_ACCOUNT_SID
    const token = process.env.TWILIO_AUTH_TOKEN
    if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set.')
    _twilioClient = twilio(sid, token)
  }
  return _twilioClient
}

// In-memory OTP store: phone → { hash, expiresAt, sentAt }
// (single-instance; fine for this use case)
const otpStore = new Map()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dataDir = path.join(__dirname, '..', 'data')
const lawsPath = path.join(dataDir, 'laws.json')
const DB_PATH = path.join(dataDir, 'db.json')
const EXPLANATIONS_PATH = path.join(dataDir, 'law-explanations.json')
const LAWS_CACHE_PATH = path.join(dataDir, 'laws-cache.json')
const frontendDistPath = path.join(__dirname, '..', '..', 'frontend', 'dist')
const frontendIndexPath = path.join(frontendDistPath, 'index.html')

function ensureDbFile() {
  const dir = path.dirname(DB_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify({ users: [], lawFeedback: {}, lawExplanations: {} }, null, 2),
      'utf8'
    )
  }
}

async function readExplanations() {
  try {
    const { data, error } = await supabase
      .from('law_explanations')
      .select('law_id, explanation_text, source_url, generated_at, meta')

    if (error) {
      console.error('readExplanations supabase error:', error.message)
      return {}
    }

    const out = {}
    for (const row of data || []) {
      out[row.law_id] = {
        text: row.explanation_text,
        textSk: row.meta?.text_sk || null,
        sourceUrl: row.source_url,
        generatedAt: row.generated_at,
      }
    }
    return out
  } catch (err) {
    console.error('readExplanations error:', err.message)
    return {}
  }
}

async function upsertExplanation(lawId, entry) {
  try {
    const { data: existing, error: selectErr } = await supabase
      .from('law_explanations')
      .select('law_id, meta')
      .eq('law_id', lawId)
      .limit(1)

    if (selectErr) {
      console.error('upsertExplanation select error:', selectErr.message)
      return
    }

    if (existing && existing.length > 0) {
      // Record exists — only patch in SK text if it's missing
      const currentMeta = existing[0].meta || {}
      if (!currentMeta.text_sk && entry.textSk) {
        const { error: updateErr } = await supabase
          .from('law_explanations')
          .update({ meta: { ...currentMeta, text_sk: entry.textSk } })
          .eq('law_id', lawId)
        if (updateErr) console.error('upsertExplanation meta update error:', updateErr.message)
      }
      return
    }

    const record = {
      law_id: lawId,
      explanation_text: entry.text,
      source_url: entry.sourceUrl || null,
      generated_at: entry.generatedAt || new Date().toISOString(),
      model: entry.model || null,
      meta: { ...(entry.meta || {}), ...(entry.textSk ? { text_sk: entry.textSk } : {}) },
    }

    const { error } = await supabase.from('law_explanations').insert(record)
    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('duplicate key value') || msg.includes('unique constraint')) {
        return
      }
      console.error('upsertExplanation insert error:', error.message)
    }
  } catch (err) {
    console.error('upsertExplanation exception:', err.message)
  }
}

const NRSR_VOTING_URL = 'https://www.nrsr.sk/web/default.aspx?SectionId=108'
const NRSR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Accept: 'text/html,application/xhtml+xml,application/xml,*/*',
  Referer: 'https://www.nrsr.sk/web/',
}

function stripHtml(text) {
  return extractTextFromHtml(text)
}

function extractTextFromHtml(html) {
  // First try to just get content between tags, removing scripts/styles first
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
  
  // Get all text nodes by removing tags but keeping text
  let text = cleaned
    .replace(/<[^>]+>/g, ' ')  // Remove all HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&.*?;/g, ' ')  // Cleanup remaining HTML entities
    .replace(/\s+/g, ' ')    // Collapse multiple spaces
    .trim()
  
  return text
}

function parseNrDate(dateString) {
  // Parse dates like "7.5.2026" or "7.5.2026 11:30:40"
  const match = String(dateString).match(/(\d+)\.(\d+)\.(\d{4})/)
  if (!match) return null
  const [, day, month, year] = match
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseNrTimestamp(dateString) {
  const match = String(dateString).match(
    /(\d+)\.(\d+)\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  )
  if (!match) {
    return { date: null, iso: null, timestamp: 0 }
  }

  const [, day, month, year, hour = '00', minute = '00', second = '00'] = match
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
  const parsed = new Date(iso)

  return {
    date: iso.slice(0, 10),
    iso,
    timestamp: Number.isNaN(parsed.valueOf()) ? 0 : parsed.valueOf(),
  }
}

function makeAbsoluteNrsrUrl(href) {
  const value = String(href || '').trim()
  if (!value) return null
  try {
    return new URL(value, 'https://www.nrsr.sk').toString()
  } catch {
    return null
  }
}

function createBillId(billNumber, title) {
  const raw = `nrsr-${String(billNumber || title || 'bill').trim()}`
  const normalized = raw
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return normalized
}

function inferCategory(text) {
  const lower = String(text).toLowerCase()
  if (/zdrav|nemocn|lekár|ošetrov|zdravie/.test(lower)) return 'Health'
  if (/doprava|cest|autobus|vlak|dráha|most|cesta/.test(lower)) return 'Transport'
  if (/škola|vzdel|študent|uciteľ|senior|mlad/.test(lower)) return 'Education'
  if (/klíma|eko|odpad|zelen|životné prostredie/.test(lower)) return 'Environment'
  if (/obec|samop|kraj|mesto|živnost|region/.test(lower)) return 'Local government'
  return 'Public policy'
}

function inferStatus(text) {
  const lower = String(text).toLowerCase()
  if (/zamietla|zamietnutá|zamietnutý|zamietol/.test(lower)) return 'rejected'
  if (/schválila|schválený|schváli|schválené|schválené/.test(lower)) return 'passed'
  return 'in-progress'
}

async function fetchVotingDetails(votingUrl) {
  try {
    if (!votingUrl) {
      return { for: 0, against: 0, abstain: 0, status: 'in-progress', votedOn: null }
    }

    const response = await fetch(votingUrl, { headers: NRSR_HEADERS })
    if (!response.ok) {
      return { for: 0, against: 0, abstain: 0, status: 'in-progress', votedOn: null }
    }

    const html = await response.text()
    const $ = loadCheerio(html)
    const normalized = $('body').text().replace(/\s+/g, ' ')

    const forMatch = normalized.match(/Za\s+hlasovalo\s*(\d+)/i)
    const againstMatch = normalized.match(/Proti\s+hlasovalo\s*(\d+)/i)
    const abstainMatch = normalized.match(/Zdržalo\s+sa\s+hlasovania\s*(\d+)/i)

    const votedOnMatch = normalized.match(/Dátum\s+a\s+čas\s*(\d+\.\s*\d+\.\s*\d{4}\s+\d{1,2}:\d{2})/i)
    const votedOn = votedOnMatch ? parseNrTimestamp(votedOnMatch[1]).date : null

    let status = 'in-progress'
    if (/Výsledok\s+hlasovania\s*Návrh\s+prešiel/i.test(normalized)) {
      status = 'passed'
    } else if (/Výsledok\s+hlasovania\s*Návrh\s+neprešiel/i.test(normalized)) {
      status = 'rejected'
    }

    return {
      for: forMatch ? parseInt(forMatch[1], 10) : 0,
      against: againstMatch ? parseInt(againstMatch[1], 10) : 0,
      abstain: abstainMatch ? parseInt(abstainMatch[1], 10) : 0,
      status,
      votedOn,
    }
  } catch (error) {
    console.error('fetch voting details error:', error.message)
    return { for: 0, against: 0, abstain: 0, status: 'in-progress', votedOn: null }
  }
}

function mapBillToLaw(bill) {
  const title = String(bill.title ?? '').trim()
  const summary = String(bill.description ?? title).trim()
  const billId = String(bill.billNumber ?? '')

  return {
    id: createBillId(billId, title),
    title,
    summary,
    status: bill.status || inferStatus(`${title} ${summary}`),
    category: inferCategory(`${title} ${summary}`),
    introducedOn: bill.date,
    // If the detail-page date regex didn't match, fall back to the list-page date
    // (the NRSR list only shows completed votes, so that date IS the voting date)
    votedOn: bill.votedOn || bill.date || null,
    governmentVote: bill.governmentVote || {
      for: 0,
      against: 0,
      abstain: 0,
    },
    resultNote: summary,
    sourceUrl: bill.sourceUrl || NRSR_VOTING_URL,
    votingUrl: bill.votingUrl || null,
    cpt: bill.billNumber || null,
    documentsUrl: bill.documentsUrl || null,
  }
}

async function loadNRSRLaws() {
  try {
    const response = await fetch(NRSR_VOTING_URL, {
      headers: NRSR_HEADERS,
    })

    if (!response.ok) {
      throw new Error(`NRSR fetch failed (${response.status})`)
    }

    const html = await response.text()
    const $ = loadCheerio(html)

    const bills = []

    $('table tr').each((index, element) => {
      const cells = $(element).find('td')
      if (cells.length < 6) return

      const sessionNum = $(cells[0]).text().trim()
      const dateStr = $(cells[1]).text().trim()
      const votingNum = $(cells[2]).text().trim()
      const billNum = $(cells[3]).text().trim()
      const titleText = stripHtml($(cells[4]).text())
      const voteHref = $(cells[5]).find('a').first().attr('href') || ''
      const cptHref = $(cells[3]).find('a').first().attr('href') || ''

      if (!titleText || !dateStr) return

      const billIdMatch = titleText.match(/\(tlač\s*(\d+)\)/)
      const billId = billIdMatch ? billIdMatch[1] : billNum
      const time = parseNrTimestamp(dateStr)
      const voteNumber = Number.parseInt(votingNum, 10)

      // Keep only rows with ČPT (law proposals / materials), skip procedural-only rows.
      if (!billId) return

      bills.push({
        sessionNumber: sessionNum,
        date: time.date || parseNrDate(dateStr),
        timestamp: time.timestamp,
        voteNumber: Number.isNaN(voteNumber) ? 0 : voteNumber,
        votingNumber: votingNum,
        billNumber: billId,
        title: titleText,
        description: titleText,
        sourceUrl: NRSR_VOTING_URL,
        votingUrl: makeAbsoluteNrsrUrl(voteHref),
        documentsUrl:
          makeAbsoluteNrsrUrl(cptHref) ||
          `https://www.nrsr.sk/web/?SectionId=91&CisloTlace=${encodeURIComponent(String(billId))}`,
        governmentVote: { for: 0, against: 0, abstain: 0 },
        status: 'in-progress',
        votedOn: null,
      })
    })

    const latest = bills
      .sort((a, b) => b.timestamp - a.timestamp || b.voteNumber - a.voteNumber)
      .slice(0, 10)

    // Check which bills already have complete vote data in Supabase to avoid
    // unnecessary requests to nrsr.sk for detail pages
    const existingIds = new Set()
    try {
      const ids = latest.map((b) => createBillId(String(b.billNumber ?? ''), String(b.title ?? '')))
      const { data: existing } = await supabase
        .from('laws')
        .select('id, raw')
        .in('id', ids)
      for (const row of existing || []) {
        const gv = row.raw?.governmentVote || {}
        const total = (gv.for || 0) + (gv.against || 0) + (gv.abstain || 0)
        if (total > 0) existingIds.add(row.id)
      }
    } catch (_) { /* non-fatal — fall through to full fetch */ }

    // Fetch detail pages sequentially (not parallel) to be polite to nrsr.sk,
    // and skip any bill whose vote data we already have
    const withVotes = []
    for (const bill of latest) {
      const billId = createBillId(String(bill.billNumber ?? ''), String(bill.title ?? ''))
      if (existingIds.has(billId)) {
        // Reuse whatever is in Supabase — syncLaws will upsert the rest unchanged
        withVotes.push(bill)
        continue
      }
      // Small delay between requests to nrsr.sk
      await new Promise((r) => setTimeout(r, 300))
      const voting = await fetchVotingDetails(bill.votingUrl)
      withVotes.push({
        ...bill,
        votedOn: voting.votedOn,
        status: voting.status,
        governmentVote: {
          for: voting.for,
          against: voting.against,
          abstain: voting.abstain,
        },
      })
    }

    return withVotes.map(mapBillToLaw)
  } catch (error) {
    console.error('NRSR fetch error:', error.message)
    return []
  }
}

let activeLawsCache = { items: [], expiresAt: 0 }

async function loadActiveLaws() {
  const now = Date.now()
  if (activeLawsCache.expiresAt > now && activeLawsCache.items.length) {
    return activeLawsCache.items
  }
  // Prefer reading recent laws from Supabase if available
  try {
    const { data, error } = await supabase
      .from('laws')
      .select('id, title, summary, status, category, introduced_on, voted_on, source_url, documents_url, cpt, raw')
      .order('introduced_on', { ascending: false })
      .limit(10)

    if (!error && data && data.length) {
      const mapped = data.map((row) => {
        const raw = row.raw || {}
        return {
          id: row.id,
          title: row.title,
          summary: row.summary || raw.summary || row.title,
          status: row.status || raw.status || inferStatus(row.title || row.summary || ''),
          category: row.category || inferCategory(row.title || row.summary || ''),
          introducedOn: row.introduced_on || raw.introducedOn || null,
          votedOn: (() => {
            if (row.voted_on) return row.voted_on
            if (raw.votedOn) return raw.votedOn
            // If vote counts exist the law was already voted on — use introducedOn as the date
            const gv = raw.governmentVote || raw.government_vote || {}
            const totalVotes = (gv.for || 0) + (gv.against || 0) + (gv.abstain || 0)
            return totalVotes > 0 ? (row.introduced_on || raw.introducedOn || null) : null
          })(),
          governmentVote: raw.governmentVote || raw.government_vote || { for: 0, against: 0, abstain: 0 },
          resultNote: raw.resultNote || row.summary || null,
          sourceUrl: row.source_url || raw.sourceUrl || NRSR_VOTING_URL,
          votingUrl: raw.votingUrl || row.voting_url || null,
          cpt: row.cpt || raw.cpt || null,
          documentsUrl: row.documents_url || raw.documentsUrl || null,
        }
      })

      activeLawsCache = { items: mapped, expiresAt: now + 5 * 60 * 1000 }
      return mapped
    }
  } catch (err) {
    console.error('loadActiveLaws supabase read error:', err.message)
  }

  // If Supabase had no laws, fall back to fetching/parsing NRSR and persist into Supabase
  const cached = readLawsCache()

  try {
    const res = await fetch(NRSR_VOTING_URL, { headers: NRSR_HEADERS })
      if (res.ok) {
      const html = await res.text()
      // Do not rely on local cache files; parse live page and upsert to Supabase

      // Delegate to full parser which will fetch and parse
      let laws = await loadNRSRLaws()

      // Upsert fetched laws into Supabase for future reads
      try {
        for (const l of laws) {
          await supabase.from('laws').upsert({
            id: l.id,
            title: l.title,
            summary: l.summary,
            status: l.status,
            category: l.category,
            introduced_on: l.introducedOn || null,
            voted_on: l.votedOn || null,
            source_url: l.sourceUrl || null,
            documents_url: l.documentsUrl || null,
            cpt: l.cpt || null,
            raw: l,
          }, { onConflict: 'id' })
        }
      } catch (err) {
        console.error('upsert laws to supabase error:', err.message)
      }

      activeLawsCache = { items: laws, expiresAt: now + 5 * 60 * 1000 }
      return laws
    }
  } catch (err) {
    // If fetch failed, fall back to cache or bundled laws
  }

  // Fallback: use persisted cache if available
  if (cached && Array.isArray(cached.items) && cached.items.length) {
    activeLawsCache = { items: cached.items, expiresAt: now + 5 * 60 * 1000 }
    return cached.items
  }

  // Final fallback: bundled laws file
  const laws = readJson(lawsPath).slice(0, 10)
  activeLawsCache = { items: laws, expiresAt: now + 5 * 60 * 1000 }
  return laws
}

function normalizeOrigin(origin) {
  return origin.trim().replace(/\/$/, '')
}

function resolveAllowedOrigins() {
  const fromEnv = process.env.CORS_ORIGIN?.trim()
  if (!fromEnv) {
    return DEFAULT_CORS_ORIGINS.map(normalizeOrigin)
  }

  return fromEnv
    .split(',')
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean)
}

const allowedOrigins = resolveAllowedOrigins()

app.use(
  cors({
    origin(origin, callback) {
      if (!hasExplicitCorsOrigins && origin) {
        try {
          const parsedOrigin = new URL(origin)
          if (['localhost', '127.0.0.1'].includes(parsedOrigin.hostname)) {
            return callback(null, true)
          }
        } catch {}
      }

      if (!origin || allowedOrigins.includes(normalizeOrigin(origin))) {
        return callback(null, true)
      }

      return callback(null, false)
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
)
app.use(express.json())

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function ensureLawsCacheFile() {
  // Archive-only: do not create or rely on local laws cache file when using Supabase
  return
}

function readLawsCache() {
  // Always prefer Supabase; do not read local cache files
  return { items: [], hash: null, fetchedAt: null }
}

function writeLawsCache(obj) {
  // Skip writing local cache when using Supabase
  return
}

async function readDb() {
  ensureDbFile()
  return readJson(DB_PATH)
}

async function writeDb(db) {
  ensureDbFile()
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8')
}

function lawState(db, lawId) {
  if (!db.lawFeedback[lawId]) {
    db.lawFeedback[lawId] = {
      citizenVotes: {},
      usefulnessVotes: {},
      comments: [],
    }
  }
  return db.lawFeedback[lawId]
}

async function getFeedback(lawId) {
  try {
    const { data, error } = await supabase.from('law_feedback').select('citizen_votes, usefulness_votes, comments').eq('law_id', lawId).limit(1)
    if (error) {
      console.error('getFeedback supabase error:', error.message)
      return { citizenVotes: {}, usefulnessVotes: {}, comments: [] }
    }
    if (!data || data.length === 0) return { citizenVotes: {}, usefulnessVotes: {}, comments: [] }
    const row = data[0]
    return {
      citizenVotes: row.citizen_votes || {},
      usefulnessVotes: row.usefulness_votes || {},
      comments: row.comments || [],
    }
  } catch (err) {
    console.error('getFeedback error:', err.message)
    return { citizenVotes: {}, usefulnessVotes: {}, comments: [] }
  }
}

async function upsertFeedback(lawId, feedback) {
  try {
    const record = {
      law_id: lawId,
      citizen_votes: feedback.citizenVotes || {},
      usefulness_votes: feedback.usefulnessVotes || {},
      comments: feedback.comments || [],
    }

    // Some Supabase/Postgres schemas may not have a unique constraint on `law_id`.
    // Use select -> insert or update to avoid ON CONFLICT errors.
    const { data: existing, error: selectErr } = await supabase
      .from('law_feedback')
      .select('law_id')
      .eq('law_id', lawId)
      .limit(1)

    if (selectErr) {
      console.error('upsertFeedback select error:', selectErr.message)
      // Fallback to try upsert without onConflict
      const { error: upsertErr } = await supabase.from('law_feedback').upsert(record)
      if (upsertErr) console.error('upsertFeedback fallback upsert error:', upsertErr.message)
      return
    }

    if (existing && existing.length > 0) {
      const { error: updateErr } = await supabase
        .from('law_feedback')
        .update({ citizen_votes: record.citizen_votes, usefulness_votes: record.usefulness_votes, comments: record.comments })
        .eq('law_id', lawId)
      if (updateErr) console.error('upsertFeedback update error:', updateErr.message)
      return
    }

    const { error: insertErr } = await supabase.from('law_feedback').insert(record)
    if (insertErr) console.error('upsertFeedback insert error:', insertErr.message)
  } catch (err) {
    console.error('upsertFeedback exception:', err.message)
  }
}

async function fetchDocumentTextFromUrl(url) {
  try {
    if (!url) return null
    const res = await fetch(url, { headers: NRSR_HEADERS })
    if (!res.ok) return null

    const contentType = res.headers.get('content-type') || ''
    const text = await res.text()

    // If it's HTML, try to locate a DocumentPreview link (DocID)
    if (contentType.includes('text/html')) {
      const $ = loadCheerio(text)

// Prefer explicit DocumentPreview links - try a few consecutive DocIDs since the first may be a cover image
      const previewAnchor = $('a[href*="DocumentPreview.aspx?DocID="]').first()
      if (previewAnchor.length) {
        const href = previewAnchor.attr('href')
        const baseHref = makeAbsoluteNrsrUrl(href) || href
        const docIdMatch = baseHref.match(/DocID=(\d+)/)
        // Try a larger window of consecutive DocIDs — some multi-page previews use adjacent DocIDs
        const docIds = docIdMatch
          ? Array.from({ length: 16 }, (_, i) => String(parseInt(docIdMatch[1], 10) + i))
          : []
        
        // Accumulate extracted text across pages
        const accumulated = []
        for (const docId of docIds) {
          const previewUrl = docIdMatch ? baseHref.replace(/DocID=\d+/, `DocID=${docId}`) : baseHref
          try {
            const p = await fetch(previewUrl, { headers: NRSR_HEADERS })
            if (!p.ok) continue
            const pContentType = (p.headers.get('content-type') || '').toLowerCase()
            // Skip binary previews (images, pdfs) to avoid extracting binary metadata as text
            if (!pContentType.includes('text/html') && !pContentType.includes('application/xhtml+xml') && !pContentType.includes('text/plain')) {
              continue
            }
            const body = await p.text()
            console.log(`fetchDocumentTextFromUrl: fetched DocID=${docId} content-type=${pContentType} length=${body.length}`)
            // NRSR document renderer uses awspan class elements for all text
            if (body.includes('awspan')) {
              const awSpanMatches = body.match(/class="awspan[^"]*"[^>]*>([^<]+)</g) || []
              const extracted = awSpanMatches
                .map((m) => {
                  const match = m.match(/class=\"awspan[^\\\"]*\"[^>]*>([^<]+)</)
                  return match ? match[1] : ''
                })
                .filter(Boolean)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
              if (extracted.length) accumulated.push(extracted)
            }
            // Fallback: raw HTML extraction
            const extracted = extractTextFromHtml(body)
            if (extracted.length) accumulated.push(extracted)
            // If we amassed a decent amount of text across pages, return it
            const joined = accumulated.join(' ').replace(/\s+/g, ' ').trim()
            if (joined.length > 250) {
              return joined
            }
          } catch (err) {
            // continue to next DocID
          }
        }
        // If we exited the loop but have some accumulated text, return it
        const joinedFinal = accumulated.join(' ').replace(/\s+/g, ' ').trim()
        if (joinedFinal.length > 50) return joinedFinal
      }

      // Otherwise, try to find a link with text containing Návrh or Navrh
      const navrh = $('a').filter((i, el) => /navrh|návrh/i.test($(el).text())).first()
      if (navrh.length) {
        const href = navrh.attr('href')
        const abs = makeAbsoluteNrsrUrl(href) || href
        try {
          const p = await fetch(abs, { headers: NRSR_HEADERS })
          if (p.ok) {
            const pContentType = (p.headers.get('content-type') || '').toLowerCase()
            if (!pContentType.includes('text/html') && !pContentType.includes('application/xhtml+xml') && !pContentType.includes('text/plain')) {
              // don't try to extract text from binary content
            } else {
              const body = await p.text()
              const extracted = extractTextFromHtml(body)
              if (extracted.length > 100) {
                return extracted
              }
            }
          }
        } catch (err) {
          // ignore
        }
      }

      // Fall back to body text from cheerio (only if it looks like textual HTML)
      const bodyText = $('body').text()
      if (bodyText && bodyText.length > 50) {
        return extractTextFromHtml(bodyText)
      }

      // Ultimate fallback: raw HTML extraction
      return extractTextFromHtml(text)
    }

    // Non-HTML fallback: avoid extracting from binary types (pdf/images)
    if (contentType.includes('application/pdf') || contentType.startsWith('image/')) {
      return null
    }

    return extractTextFromHtml(text)
  } catch (error) {
    console.error('fetchDocumentTextFromUrl error:', error.message)
    return null
  }
}

async function callGoogleGenerative(prompt) {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GENERATIVE_API_KEY
  if (!apiKey) throw new Error('Missing Google API key')

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent'

  const body = {
    contents: [
      {
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Google API error: ${res.status} ${txt}`)
  }

  const json = await res.json()

  // Parse the Google Generative API response (v1beta: candidates[0].content.parts[0].text)
  if (Array.isArray(json.candidates) && json.candidates.length > 0) {
    const candidate = json.candidates[0]
    if (candidate.content && candidate.content.parts && Array.isArray(candidate.content.parts)) {
      for (const part of candidate.content.parts) {
        if (part.text) {
          return part.text.trim()
        }
      }
    }
  }

  return JSON.stringify(json).slice(0, 2000)
}

async function generateExplanationForLaw(law) {
  try {
    const explanations = await readExplanations()
    const existing = explanations[law.id]

    // If both languages already exist, nothing to do
    if (existing && existing.text && existing.textSk) return existing

    let docText = null
    const docUrl = law.documentsUrl || law.sourceUrl || null
    
    if (docUrl && !docUrl.includes('nrsr.sk/web/default.aspx')) {
      docText = await fetchDocumentTextFromUrl(docUrl)
    }

    if (!docText || docText.length < 100) {
      docText = `Title: ${law.title}\nSummary: ${law.summary || law.title}\nStatus: ${law.status || ''}\nCategory: ${law.category || ''}`
    }

    const MAX_PROMPT_CHARS = 20000
    const usedText = docText.length > MAX_PROMPT_CHARS ? docText.slice(0, MAX_PROMPT_CHARS) : docText
    if (docText.length > usedText.length) {
      console.log(`generateExplanationForLaw: docText truncated from ${docText.length} to ${usedText.length} chars for prompt`)
    }

    const enText = existing?.text || await callGoogleGenerative(
      `Summarize the following law proposal in at most 3 sentences. Include at least one sentence describing how this will directly affect ordinary citizens in their daily life. Be concise and plain.\n\nLaw:\n${usedText}`
    )

    const skText = existing?.textSk || await callGoogleGenerative(
      `Zhrňte nasledujúci návrh zákona v najviac 3 vetách v slovenskom jazyku. Zahrňte aspoň jednu vetu popisujúcu, ako to priamo ovplyvní bežných občanov v ich každodennom živote. Buďte stručný a zrozumiteľný.\n\nZákon:\n${usedText}`
    )

    const entry = {
      text: enText,
      textSk: skText,
      sourceUrl: docUrl,
      generatedAt: new Date().toISOString(),
    }
    console.log(`generateExplanationForLaw: law=${law.id} docUrl=${docUrl} docTextLength=${docText ? docText.length : 0}`)
    await upsertExplanation(law.id, entry)
    return entry
  } catch (error) {
    console.error('generateExplanationForLaw error:', error.message)
    return null
  }
}
function summarizeLawFeedback(feedback) {
  const citizenVoteValues = Object.values(feedback.citizenVotes)
  const usefulnessValues = Object.values(feedback.usefulnessVotes)

  return {
    citizenVotes: {
      support: citizenVoteValues.filter((value) => value === 'support').length,
      oppose: citizenVoteValues.filter((value) => value === 'oppose').length,
    },
    usefulness: {
      useful: usefulnessValues.filter((value) => value === 'useful').length,
      useless: usefulnessValues.filter((value) => value === 'useless').length,
    },
  }
}

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Missing authentication token.' })
  }

  const token = authHeader.slice('Bearer '.length)
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    if (!payload.phone || !payload.phone.startsWith('+421')) {
      return res.status(403).json({ message: 'Only Slovak (+421) phone numbers are permitted.' })
    }
    req.user = { id: payload.id, phone: payload.phone }
    return next()
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' })
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

// Send OTP to a Slovak (+421) phone number via Twilio
app.post('/api/auth/otp/request', async (req, res) => {
  try {
    const raw = String(req.body.phone || '').trim()
    const phone = raw.startsWith('+') ? raw : `+421${raw.replace(/\D/g, '')}`

    if (!/^\+421[0-9]{9}$/.test(phone)) {
      return res.status(400).json({ message: 'Invalid phone number. Provide a Slovak +421 number with 9 digits.' })
    }

    // Rate-limit: one OTP per 60 seconds per number
    const existing = otpStore.get(phone)
    if (existing && Date.now() - existing.sentAt < 60_000) {
      return res.status(429).json({ message: 'Please wait 60 seconds before requesting another code.' })
    }

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const hash = createHash('sha256').update(`${phone}:${otp}`).digest('hex')
    otpStore.set(phone, { hash, expiresAt: Date.now() + 5 * 60_000, sentAt: Date.now() })

    if (DEV) {
      console.log(`[DEV] OTP for ${phone}: ${otp}`)
    }

    try {
      await getTwilioClient().messages.create({
        body: `Your OurVoice verification code: ${otp}. Valid for 5 minutes.`,
        from: TWILIO_FROM,
        to: phone,
      })
    } catch (twilioErr) {
      if (!DEV) throw twilioErr
      // In DEV: swallow Twilio errors (trial accounts can't SMS unverified numbers).
      // Use the code logged above or the bypass code 456123.
      console.warn(`[DEV] Twilio send failed (${twilioErr.message}) — use logged OTP or bypass code 456123.`)
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error('otp/request error:', err.message)
    return res.status(500).json({ message: 'Failed to send verification code.' })
  }
})

// Verify OTP and return a signed JWT
app.post('/api/auth/otp/verify', async (req, res) => {
  try {
    const raw = String(req.body.phone || '').trim()
    const phone = raw.startsWith('+') ? raw : `+421${raw.replace(/\D/g, '')}`
    const code = String(req.body.code || '').trim()

    if (!/^\+421[0-9]{9}$/.test(phone)) {
      return res.status(400).json({ message: 'Invalid phone number.' })
    }
    if (!/^[0-9]{6}$/.test(code)) {
      return res.status(400).json({ message: 'Invalid code format.' })
    }

    // DEV bypass: code 456123 always works when DEV=true
    const isDevBypass = DEV && code === DEV_BYPASS_CODE

    if (!isDevBypass) {
      const entry = otpStore.get(phone)
      if (!entry || Date.now() > entry.expiresAt) {
        return res.status(401).json({ message: 'Code expired or not found. Request a new one.' })
      }

      const expected = Buffer.from(entry.hash, 'hex')
      const actual = Buffer.from(createHash('sha256').update(`${phone}:${code}`).digest('hex'), 'hex')
      const valid = expected.length === actual.length && timingSafeEqual(expected, actual)

      if (!valid) {
        return res.status(401).json({ message: 'Incorrect verification code.' })
      }

      otpStore.delete(phone)
    }

    // Deterministic user ID from phone — same number always gets the same ID
    const userId = createHash('sha256').update(`ourvoice-user:${phone}`).digest('hex').slice(0, 32)
    const user = { id: userId, phone }
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' })

    return res.json({ token, user })
  } catch (err) {
    console.error('otp/verify error:', err.message)
    return res.status(500).json({ message: 'Verification failed.' })
  }
})

// Legacy register — disabled (phone auth replaces this)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' })
    }

    const normalizedEmail = String(email).trim().toLowerCase()

    // Prefer Supabase-backed users table when available
    try {
      const { data: existing, error: selectErr } = await supabase
        .from('users')
        .select('id, name, email')
        .eq('email', normalizedEmail)
        .limit(1)

      if (selectErr) throw selectErr

      if (existing && existing.length > 0) {
        return res.status(409).json({ message: 'Email is already registered.' })
      }

      const passwordHash = await bcrypt.hash(password, 10)
      const newUser = {
        id: randomUUID(),
        name: String(name).trim(),
        email: normalizedEmail,
        password_hash: passwordHash,
      }

      const { data: inserted, error: insertErr } = await supabase.from('users').insert(newUser).select('id, name, email')
      if (insertErr) {
        console.error('supabase register insert error:', insertErr.message)
        throw insertErr
      }

      const created = (inserted && inserted[0]) ? inserted[0] : { id: newUser.id, name: newUser.name, email: newUser.email }
      const token = jwt.sign(publicUser(created), JWT_SECRET, { expiresIn: '7d' })
      return res.status(201).json({ token, user: publicUser(created) })
    } catch (err) {
      // Fallback to local DB file if Supabase unavailable
      console.warn('Supabase register failed, falling back to local DB:', err.message)
      const db = await readDb()

      if (db.users.some((user) => user.email === normalizedEmail)) {
        return res.status(409).json({ message: 'Email is already registered.' })
      }

      const passwordHash = await bcrypt.hash(password, 10)
      const user = {
        id: randomUUID(),
        name: String(name).trim(),
        email: normalizedEmail,
        passwordHash,
      }

      db.users.push(user)
      await writeDb(db)

      const token = jwt.sign(publicUser(user), JWT_SECRET, { expiresIn: '7d' })
      return res.status(201).json({ token, user: publicUser(user) })
    }
  } catch (error) {
    console.error('register error:', error.message)
    return res.status(500).json({ message: error.message })
  }
})

// Legacy login — disabled (phone auth replaces this)
app.post('/api/auth/login', async (req, res) => {
  return res.status(410).json({ message: 'Email/password login is no longer supported. Use phone OTP.' })
  // eslint-disable-next-line no-unreachable
  try {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' })
  }

  const normalizedEmail = String(email).trim().toLowerCase()

  // Prefer Supabase users table for authentication
  try {
    const { data: rows, error: selectErr } = await supabase
      .from('users')
      .select('id, name, email, password_hash')
      .eq('email', normalizedEmail)
      .limit(1)

    if (selectErr) throw selectErr

    const rowUser = (rows && rows[0]) || null
    if (!rowUser) {
      // fallback to local DB
      throw new Error('no-supabase-user')
    }

    const isValidPassword = await bcrypt.compare(password, rowUser.password_hash || '')
    if (!isValidPassword) return res.status(401).json({ message: 'Invalid email or password.' })

    const token = jwt.sign(publicUser(rowUser), JWT_SECRET, { expiresIn: '7d' })
    return res.json({ token, user: publicUser(rowUser) })
  } catch (err) {
    if (err.message !== 'no-supabase-user') console.warn('Supabase login error, falling back to local DB:', err.message)
    const db = await readDb()
    const user = db.users.find((entry) => entry.email === normalizedEmail)

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password.' })
    }

    const isValidPassword = await bcrypt.compare(password, user.passwordHash)
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid email or password.' })
    }

    const token = jwt.sign(publicUser(user), JWT_SECRET, { expiresIn: '7d' })
    return res.json({ token, user: publicUser(user) })
  }
  } catch (error) {
    console.error('login error:', error.message)
    return res.status(500).json({ message: error.message })
  }
})

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ user: req.user })
})

app.get('/api/laws', async (_req, res) => {
  try {
    const laws = await loadActiveLaws()

    const explanations = await readExplanations()

    const items = await Promise.all(
      laws.map(async (law) => {
        const feedback = await getFeedback(law.id)
        const summary = summarizeLawFeedback(feedback)
        const explanationEntry = explanations[law.id]

        return {
          ...law,
          citizen: summary,
          aiExplanation: explanationEntry ? explanationEntry.text : null,
          aiExplanationSk: explanationEntry ? explanationEntry.textSk : null,
        }
      })
    )
    // Background explanation generation is performed on startup and via scheduled sync
    // to avoid triggering heavy generation on every /api/laws request.

    res.json({ items })
  } catch (error) {
    console.error('laws error:', error.message)
    res.status(500).json({ message: error.message })
  }
})

app.post('/api/laws/:lawId/citizen-vote', authRequired, async (req, res) => {
  try {
    console.log('citizen-vote request:', { path: req.path, hasAuthorization: !!req.headers.authorization, body: req.body })
    const { lawId } = req.params
    const { vote } = req.body

    if (!['support', 'oppose'].includes(vote)) {
      return res.status(400).json({ message: 'Vote must be support or oppose.' })
    }

    const laws = await loadActiveLaws()
    if (!laws.some((law) => law.id === lawId)) {
      return res.status(404).json({ message: 'Law not found.' })
    }

    const feedback = await getFeedback(lawId)
    feedback.citizenVotes[req.user.id] = vote
    await upsertFeedback(lawId, feedback)

    res.json({ citizen: summarizeLawFeedback(feedback) })
  } catch (error) {
    console.error('citizen-vote error:', error.message)
    res.status(500).json({ message: error.message })
  }
})

app.post('/api/laws/:lawId/usefulness', authRequired, async (req, res) => {
  try {
    console.log('usefulness request:', { path: req.path, hasAuthorization: !!req.headers.authorization, body: req.body })
    const { lawId } = req.params
    const { vote } = req.body

    if (!['useful', 'useless'].includes(vote)) {
      return res.status(400).json({ message: 'Vote must be useful or useless.' })
    }

    const laws = await loadActiveLaws()
    if (!laws.some((law) => law.id === lawId)) {
      return res.status(404).json({ message: 'Law not found.' })
    }

    const feedback = await getFeedback(lawId)
    feedback.usefulnessVotes[req.user.id] = vote
    await upsertFeedback(lawId, feedback)

    res.json({ citizen: summarizeLawFeedback(feedback) })
  } catch (error) {
    console.error('usefulness error:', error.message)
    res.status(500).json({ message: error.message })
  }
})

// Trigger generation of AI explanation for a single law (can be used to debug/generate on-demand)
app.post('/api/laws/:lawId/generate-explanation', async (req, res) => {
  try {
    const { lawId } = req.params
    const laws = await loadActiveLaws()
    const law = laws.find((l) => l.id === lawId)
    if (!law) return res.status(404).json({ message: 'Law not found.' })

    // Do not regenerate if an explanation already exists.
    const explanations = await readExplanations()
    if (explanations[lawId]) {
      return res.status(200).json({ explanation: explanations[lawId], message: 'Existing explanation returned; regeneration is disabled.' })
    }

    const entry = await generateExplanationForLaw(law)
    if (!entry) return res.status(500).json({ message: 'Failed to generate explanation.' })

    res.json({ explanation: entry })
  } catch (error) {
    console.error('generate-explanation error:', error.message)
    res.status(500).json({ message: error.message })
  }
})

// Debug endpoint: fetch a document URL and show content-type, length and extracted text
app.get('/api/debug/extract', async (req, res) => {
  try {
    const url = req.query.url
    if (!url) return res.status(400).json({ message: 'Missing url query param' })

    const response = await fetch(String(url), { headers: NRSR_HEADERS })
    const contentType = response.headers.get('content-type') || null
    const body = await response.text()

    const extracted = await fetchDocumentTextFromUrl(String(url))

    res.json({ url, contentType, bodyLength: body.length, extracted: extracted || null })
  } catch (err) {
    console.error('debug extract error:', err.message)
    res.status(500).json({ message: err.message })
  }
})

if (fs.existsSync(frontendIndexPath)) {
  app.use(express.static(frontendDistPath))

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next()
    }

    if (path.extname(req.path)) {
      return next()
    }

    res.sendFile(frontendIndexPath)
  })
}

app.listen(PORT, () => {
  console.log(`OurVoice backend running on http://localhost:${PORT}`)
})

// ----- NRSR sync: fetch latest laws and upsert to Supabase -----
let syncing = false
async function syncLaws() {
  if (syncing) {
    console.log('syncLaws: already running, skipping')
    return { ok: false, message: 'already running' }
  }

  try {
    syncing = true
    console.log('syncLaws: starting NRSR sync')
    const laws = await loadNRSRLaws()
    if (!Array.isArray(laws) || laws.length === 0) {
      console.log('syncLaws: no laws fetched')
      return { ok: true, inserted: 0, updated: 0 }
    }

    let inserted = 0
    let updated = 0

    for (const l of laws) {
      // Upsert will insert or update; we can treat all as upserts for simplicity
      const { error } = await supabase.from('laws').upsert({
        id: l.id,
        title: l.title,
        summary: l.summary,
        status: l.status,
        category: l.category,
        introduced_on: l.introducedOn || null,
        voted_on: l.votedOn || null,
        source_url: l.sourceUrl || null,
        documents_url: l.documentsUrl || null,
        cpt: l.cpt || null,
        raw: l,
      }, { onConflict: 'id' })

      if (error) {
        console.error('syncLaws upsert error for', l.id, error.message)
      } else {
        // We cannot easily detect insert vs update from supabase-js here without returning; count as upsert
        inserted += 1
      }
    }

    console.log(`syncLaws: finished, processed ${inserted} items`)

    // Start background generation for any laws missing explanations (non-blocking)
    ;(async () => {
      try {
        const explanations = await readExplanations()
        const toGenerate = laws.filter((l) => !explanations[l.id])
        if (toGenerate.length) console.log(`syncLaws: will auto-generate ${toGenerate.length} explanations in background`)
        for (const law of toGenerate) {
          ;(async (law) => {
            try {
              console.log(`auto-generate: starting ${law.id}`)
              await generateExplanationForLaw(law)
              console.log(`auto-generate: finished ${law.id}`)
            } catch (err) {
              console.error(`auto-generate error for ${law.id}:`, err.message)
            }
          })(law)
        }
      } catch (err) {
        console.error('syncLaws background generation error:', err.message)
      }
    })()

    return { ok: true, inserted, updated }
  } catch (err) {
    console.error('syncLaws error:', err.message)
    return { ok: false, message: err.message }
  } finally {
    syncing = false
  }
}

app.post('/api/sync-laws', async (_req, res) => {
  try {
    const result = await syncLaws()
    if (!result.ok) return res.status(500).json(result)
    return res.json(result)
  } catch (err) {
    console.error('sync-laws endpoint error:', err.message)
    return res.status(500).json({ ok: false, message: err.message })
  }
})

// Schedule daily midnight sync: compute delay until next local midnight
function scheduleDailyMidnight(task) {
  const now = new Date()
  const next = new Date(now)
  next.setHours(24, 0, 0, 0) // next midnight
  const delay = next.valueOf() - now.valueOf()
  console.log(`scheduleDailyMidnight: first run in ${Math.round(delay / 1000)}s`) 
  setTimeout(() => {
    task()
    setInterval(task, 24 * 60 * 60 * 1000)
  }, delay)
}

// Run sync on startup (non-blocking) and schedule daily
;(async () => {
  try {
    console.log('startup: triggering syncLaws')
    await syncLaws()
    scheduleDailyMidnight(() => {
      console.log('daily sync: running syncLaws')
      syncLaws().catch((e) => console.error('daily sync error:', e.message))
    })
  } catch (err) {
    console.error('startup sync error:', err.message)
  }
})()

// On startup run a one-shot sweep to generate any missing explanations (non-blocking)
if (process.env.GOOGLE_API_KEY || process.env.GENERATIVE_API_KEY) {
  ;(async () => {
    try {
      console.log('initial explanation sweep: starting')
      const laws = await loadActiveLaws()
      for (const law of laws) {
        const current = await readExplanations()
        const entry = current[law.id]
        if (entry && entry.text && entry.textSk) {
          console.log(`initial explanation sweep: already have ${law.id}`)
          continue
        }
        console.log(`initial explanation sweep: generating ${law.id}`)
        await generateExplanationForLaw(law)
        console.log(`initial explanation sweep: generated ${law.id}`)
      }
      console.log('initial explanation sweep: finished')
    } catch (err) {
      console.error('initial explanation sweep error:', err.message)
    }
  })()
}
