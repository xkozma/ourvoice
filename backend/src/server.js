import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { load as loadCheerio } from 'cheerio'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

dotenv.config({ path: new URL('../.env', import.meta.url) })

const app = express()
const PORT = process.env.PORT || 4000
const JWT_SECRET = process.env.JWT_SECRET || 'ourvoice-dev-secret'
const DEFAULT_CORS_ORIGINS = ['http://localhost:5173']
const hasExplicitCorsOrigins = Boolean(process.env.CORS_ORIGIN?.trim())

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dataDir = path.join(__dirname, '..', 'data')
const lawsPath = path.join(dataDir, 'laws.json')
const DB_PATH = path.join(dataDir, 'db.json')
const EXPLANATIONS_PATH = path.join(dataDir, 'law-explanations.json')
const frontendDistPath = path.join(__dirname, '..', '..', 'frontend', 'dist')
const frontendIndexPath = path.join(frontendDistPath, 'index.html')

function ensureDbFile() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify({ users: [], lawFeedback: {}, lawExplanations: {} }, null, 2),
      'utf8'
    )
  }
}

function ensureExplanationsFile() {
  if (!fs.existsSync(EXPLANATIONS_PATH)) {
    fs.writeFileSync(EXPLANATIONS_PATH, JSON.stringify({}, null, 2), 'utf8')
  }
}

function readExplanations() {
  ensureExplanationsFile()
  return JSON.parse(fs.readFileSync(EXPLANATIONS_PATH, 'utf8'))
}

function writeExplanations(obj) {
  ensureExplanationsFile()
  fs.writeFileSync(EXPLANATIONS_PATH, JSON.stringify(obj, null, 2), 'utf8')
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
    votedOn: bill.votedOn || null,
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

    const withVotes = await Promise.all(
      latest.map(async (bill) => {
        const voting = await fetchVotingDetails(bill.votingUrl)
        return {
          ...bill,
          votedOn: voting.votedOn,
          status: voting.status,
          governmentVote: {
            for: voting.for,
            against: voting.against,
            abstain: voting.abstain,
          },
        }
      })
    )

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

  let laws = await loadNRSRLaws()
  if (!laws.length) {
    laws = readJson(lawsPath).slice(0, 10)
  }

  activeLawsCache = {
    items: laws,
    expiresAt: now + 5 * 60 * 1000,
  }

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
  })
)
app.use(express.json())

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
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
        const docIds = docIdMatch
          ? [0, 1, 2, 3].map((offset) => String(parseInt(docIdMatch[1], 10) + offset))
          : []
        
        for (const docId of docIds) {
          const previewUrl = docIdMatch ? baseHref.replace(/DocID=\d+/, `DocID=${docId}`) : baseHref
          try {
            const p = await fetch(previewUrl, { headers: NRSR_HEADERS })
            if (!p.ok) continue
            const body = await p.text()
            // NRSR document renderer uses awspan class elements for all text
            if (body.includes('awspan')) {
              const awSpanMatches = body.match(/class="awspan[^"]*"[^>]*>([^<]+)</g) || []
              if (awSpanMatches.length > 10) {
                const extracted = awSpanMatches
                  .map(m => {
                    const match = m.match(/class="awspan[^"]*"[^>]*>([^<]+)</)  
                    return match ? match[1] : ''
                  })
                  .filter(Boolean)
                  .join(' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                if (extracted.length > 100) {
                  return extracted
                }
              }
            }
            // Fallback: raw HTML extraction
            const extracted = extractTextFromHtml(body)
            if (extracted.length > 100) {
              return extracted
            }
          } catch (err) {
            // continue to next DocID
          }
        }
      }

      // Otherwise, try to find a link with text containing Návrh or Navrh
      const navrh = $('a').filter((i, el) => /navrh|návrh/i.test($(el).text())).first()
      if (navrh.length) {
        const href = navrh.attr('href')
        const abs = makeAbsoluteNrsrUrl(href) || href
        try {
          const p = await fetch(abs, { headers: NRSR_HEADERS })
          if (p.ok) {
            const body = await p.text()
            const extracted = extractTextFromHtml(body)
            if (extracted.length > 100) {
              return extracted
            }
          }
        } catch (err) {
          // ignore
        }
      }

      // Fall back to body text from cheerio
      const bodyText = $('body').text()
      if (bodyText && bodyText.length > 50) {
        return extractTextFromHtml(bodyText)
      }
      
      // Ultimate fallback: raw HTML extraction
      return extractTextFromHtml(text)
    }

    // Non-HTML fallback: use raw text extraction
    return extractTextFromHtml(text)
  } catch (error) {
    console.error('fetchDocumentTextFromUrl error:', error.message)
    return null
  }
}

async function callGoogleGenerative(prompt) {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GENERATIVE_API_KEY
  if (!apiKey) throw new Error('Missing Google API key')

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent'

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
    const explanations = readExplanations()
    if (explanations[law.id]) return explanations[law.id]

    let docText = null
    const docUrl = law.documentsUrl || law.sourceUrl || null
    
    if (docUrl && !docUrl.includes('nrsr.sk/web/default.aspx')) {
      docText = await fetchDocumentTextFromUrl(docUrl)
    }

    // If no doc text from URL, generate from summary/title directly
    if (!docText || docText.length < 100) {
      docText = `Title: ${law.title}\nSummary: ${law.summary || law.title}\nStatus: ${law.status || ''}\nCategory: ${law.category || ''}`
    }

    const prompt = `Summarize the following law proposal in at most 3 sentences. Include at least one sentence describing how this will directly affect ordinary citizens in their daily life. Be concise and plain.\n\nLaw:\n${docText.slice(0, 3000)}`

    const aiText = await callGoogleGenerative(prompt)

    const entry = {
      text: aiText,
      sourceUrl: docUrl,
      generatedAt: new Date().toISOString(),
    }

    explanations[law.id] = entry
    writeExplanations(explanations)
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
    req.user = payload
    return next()
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' })
  }
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' })
    }

    const normalizedEmail = String(email).trim().toLowerCase()
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
  } catch (error) {
    console.error('register error:', error.message)
    return res.status(500).json({ message: error.message })
  }
})

app.post('/api/auth/login', async (req, res) => {
  try {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' })
  }

  const normalizedEmail = String(email).trim().toLowerCase()
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

    const db = await readDb()
    const explanations = readExplanations()

    const items = laws.map((law) => {
      const feedback = lawState(db, law.id)
      const summary = summarizeLawFeedback(feedback)
      const explanationEntry = explanations[law.id]

      return {
        ...law,
        citizen: summary,
        aiExplanation: explanationEntry ? explanationEntry.text : null,
      }
    })

    // Persist any initial DB changes (e.g. lawFeedback initialization)
    await writeDb(db)

    // Trigger background generation for laws missing explanations
    if (process.env.GOOGLE_API_KEY || process.env.GENERATIVE_API_KEY) {
      ;(async () => {
        try {
          for (const law of laws) {
            const current = readExplanations()
            if (!current[law.id]) {
              // generate but don't block the response
              await generateExplanationForLaw(law)
            }
          }
        } catch (err) {
          console.error('background explanation generation error:', err.message)
        }
      })()
    }

    res.json({ items })
  } catch (error) {
    console.error('laws error:', error.message)
    res.status(500).json({ message: error.message })
  }
})

app.post('/api/laws/:lawId/citizen-vote', authRequired, async (req, res) => {
  try {
    const { lawId } = req.params
    const { vote } = req.body

    if (!['support', 'oppose'].includes(vote)) {
      return res.status(400).json({ message: 'Vote must be support or oppose.' })
    }

    const laws = await loadActiveLaws()
    if (!laws.some((law) => law.id === lawId)) {
      return res.status(404).json({ message: 'Law not found.' })
    }

    const db = await readDb()
    const feedback = lawState(db, lawId)
    feedback.citizenVotes[req.user.id] = vote
    await writeDb(db)

    res.json({ citizen: summarizeLawFeedback(feedback) })
  } catch (error) {
    console.error('citizen-vote error:', error.message)
    res.status(500).json({ message: error.message })
  }
})

app.post('/api/laws/:lawId/usefulness', authRequired, async (req, res) => {
  try {
    const { lawId } = req.params
    const { vote } = req.body

    if (!['useful', 'useless'].includes(vote)) {
      return res.status(400).json({ message: 'Vote must be useful or useless.' })
    }

    const laws = await loadActiveLaws()
    if (!laws.some((law) => law.id === lawId)) {
      return res.status(404).json({ message: 'Law not found.' })
    }

    const db = await readDb()
    const feedback = lawState(db, lawId)
    feedback.usefulnessVotes[req.user.id] = vote
    await writeDb(db)

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

    const entry = await generateExplanationForLaw(law)
    if (!entry) return res.status(500).json({ message: 'Failed to generate explanation.' })

    res.json({ explanation: entry })
  } catch (error) {
    console.error('generate-explanation error:', error.message)
    res.status(500).json({ message: error.message })
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
