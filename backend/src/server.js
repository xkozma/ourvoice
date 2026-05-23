import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

dotenv.config({ path: new URL('../.env', import.meta.url) })

const app = express()
const PORT = process.env.PORT || 4000
const JWT_SECRET = process.env.JWT_SECRET || 'ourvoice-dev-secret'
const DEFAULT_CORS_ORIGINS = ['http://localhost:5173']
const hasExplicitCorsOrigins = Boolean(process.env.CORS_ORIGIN?.trim())

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY

if (!JSONBIN_BIN_ID || !JSONBIN_API_KEY) {
  console.warn(
    'Warning: JSONBIN_BIN_ID or JSONBIN_API_KEY not set. Database reads/writes will fail.'
  )
} else {
  console.log(
    `jsonbin configured — bin: ${JSONBIN_BIN_ID} | key: ${JSONBIN_API_KEY.slice(0, 8)}...${JSONBIN_API_KEY.slice(-4)}`
  )
}

const JSONBIN_BASE = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`
const JSONBIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Master-Key': JSONBIN_API_KEY,
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dataDir = path.join(__dirname, '..', 'data')
const lawsPath = path.join(dataDir, 'laws.json')
const frontendDistPath = path.join(__dirname, '..', '..', 'frontend', 'dist')
const frontendIndexPath = path.join(frontendDistPath, 'index.html')

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

async function jsonbinRequest(url, options = {}) {
  console.log(`[jsonbin] ${options.method ?? 'GET'} ${url}`)
  console.log(`[jsonbin] X-Master-Key starts with: ${JSONBIN_API_KEY?.slice(0, 12) ?? '(not set)'}`)
  const response = await fetch(url, { ...options, headers: { ...JSONBIN_HEADERS, ...options.headers } })
  const text = await response.text()
  console.log(`[jsonbin] status: ${response.status} | body[:300]: ${text.slice(0, 300)}`)
  if (!response.ok) {
    throw new Error(`jsonbin ${options.method ?? 'GET'} failed (${response.status}): ${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`jsonbin returned non-JSON (status ${response.status}): ${text.slice(0, 300)}`)
  }
}

async function readDb() {
  const payload = await jsonbinRequest(`${JSONBIN_BASE}/latest`)
  return payload.record
}

async function writeDb(db) {
  await jsonbinRequest(JSONBIN_BASE, {
    method: 'PUT',
    body: JSON.stringify(db),
  })
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
    comments: feedback.comments,
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

app.get('/api/debug-jsonbin', async (_req, res) => {
  const binId = process.env.JSONBIN_BIN_ID
  const apiKey = process.env.JSONBIN_API_KEY
  const url = `https://api.jsonbin.io/v3/b/${binId}/latest`
  const keyPreview = apiKey ? `${apiKey.slice(0, 10)}...${apiKey.slice(-4)}` : '(not set)'

  try {
    const response = await fetch(url, {
      headers: { 'X-Master-Key': apiKey, 'Content-Type': 'application/json' },
    })
    const text = await response.text()
    res.json({ url, keyPreview, status: response.status, body: text.slice(0, 500) })
  } catch (error) {
    res.json({ url, keyPreview, error: error.message })
  }
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
    const laws = readJson(lawsPath)
    const db = await readDb()

    const items = laws.map((law) => {
      const feedback = lawState(db, law.id)
      const summary = summarizeLawFeedback(feedback)

      return {
        ...law,
        citizen: summary,
      }
    })

    await writeDb(db)
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

    const laws = readJson(lawsPath)
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

    const laws = readJson(lawsPath)
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

app.post('/api/laws/:lawId/comments', authRequired, async (req, res) => {
  try {
    const { lawId } = req.params
    const { text } = req.body

    if (!text || String(text).trim().length < 2) {
      return res.status(400).json({ message: 'Comment must have at least 2 characters.' })
    }

    const laws = readJson(lawsPath)
    if (!laws.some((law) => law.id === lawId)) {
      return res.status(404).json({ message: 'Law not found.' })
    }

    const db = await readDb()
    const feedback = lawState(db, lawId)
    const comment = {
      id: randomUUID(),
      userId: req.user.id,
      userName: req.user.name,
      text: String(text).trim(),
      createdAt: new Date().toISOString(),
    }

    feedback.comments.unshift(comment)
    if (feedback.comments.length > 200) {
      feedback.comments = feedback.comments.slice(0, 200)
    }

    await writeDb(db)
    res.status(201).json({ citizen: summarizeLawFeedback(feedback) })
  } catch (error) {
    console.error('comments error:', error.message)
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
