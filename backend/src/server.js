import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const app = express()
const PORT = process.env.PORT || 4000
const JWT_SECRET = process.env.JWT_SECRET || 'ourvoice-dev-secret'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dataDir = path.join(__dirname, '..', 'data')
const lawsPath = path.join(dataDir, 'laws.json')
const dbPath = path.join(dataDir, 'db.json')

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }))
app.use(express.json())

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeDb(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8')
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

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email and password are required.' })
  }

  const normalizedEmail = String(email).trim().toLowerCase()
  const db = readJson(dbPath)

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
  writeDb(db)

  const token = jwt.sign(publicUser(user), JWT_SECRET, { expiresIn: '7d' })
  return res.status(201).json({ token, user: publicUser(user) })
})

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' })
  }

  const normalizedEmail = String(email).trim().toLowerCase()
  const db = readJson(dbPath)
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
})

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ user: req.user })
})

app.get('/api/laws', (_req, res) => {
  const laws = readJson(lawsPath)
  const db = readJson(dbPath)

  const items = laws.map((law) => {
    const feedback = lawState(db, law.id)
    const summary = summarizeLawFeedback(feedback)

    return {
      ...law,
      citizen: summary,
    }
  })

  writeDb(db)
  res.json({ items })
})

app.post('/api/laws/:lawId/citizen-vote', authRequired, (req, res) => {
  const { lawId } = req.params
  const { vote } = req.body

  if (!['support', 'oppose'].includes(vote)) {
    return res.status(400).json({ message: 'Vote must be support or oppose.' })
  }

  const laws = readJson(lawsPath)
  if (!laws.some((law) => law.id === lawId)) {
    return res.status(404).json({ message: 'Law not found.' })
  }

  const db = readJson(dbPath)
  const feedback = lawState(db, lawId)
  feedback.citizenVotes[req.user.id] = vote
  writeDb(db)

  res.json({ citizen: summarizeLawFeedback(feedback) })
})

app.post('/api/laws/:lawId/usefulness', authRequired, (req, res) => {
  const { lawId } = req.params
  const { vote } = req.body

  if (!['useful', 'useless'].includes(vote)) {
    return res.status(400).json({ message: 'Vote must be useful or useless.' })
  }

  const laws = readJson(lawsPath)
  if (!laws.some((law) => law.id === lawId)) {
    return res.status(404).json({ message: 'Law not found.' })
  }

  const db = readJson(dbPath)
  const feedback = lawState(db, lawId)
  feedback.usefulnessVotes[req.user.id] = vote
  writeDb(db)

  res.json({ citizen: summarizeLawFeedback(feedback) })
})

app.post('/api/laws/:lawId/comments', authRequired, (req, res) => {
  const { lawId } = req.params
  const { text } = req.body

  if (!text || String(text).trim().length < 2) {
    return res.status(400).json({ message: 'Comment must have at least 2 characters.' })
  }

  const laws = readJson(lawsPath)
  if (!laws.some((law) => law.id === lawId)) {
    return res.status(404).json({ message: 'Law not found.' })
  }

  const db = readJson(dbPath)
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

  writeDb(db)
  res.status(201).json({ citizen: summarizeLawFeedback(feedback) })
})

app.listen(PORT, () => {
  console.log(`OurVoice backend running on http://localhost:${PORT}`)
})
