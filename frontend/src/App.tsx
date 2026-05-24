import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import './App.css'

type User = {
  id: string
  name: string
  email: string
}

type Law = {
  id: string
  title: string
  summary: string
  status: 'passed' | 'rejected' | 'in-progress'
  category: string
  introducedOn: string
  votedOn: string | null
  governmentVote: {
    for: number
    against: number
    abstain: number
  }
  resultNote: string
  votingUrl?: string | null
  cpt?: string | null
  documentsUrl?: string | null
  citizen: {
    citizenVotes: {
      support: number
      oppose: number
    }
    usefulness: {
      useful: number
      useless: number
    }
  }
  aiExplanation?: string | null
}

const rawApiBase = (import.meta.env.VITE_API_URL || '/api').trim().replace(/\/$/, '')
const API_BASE = rawApiBase.endsWith('/api') ? rawApiBase : `${rawApiBase}/api`
const GOVERNMENT_CHART_COLORS = ['#1f6feb', '#d1242f', '#7f8ea3']
const CITIZEN_CHART_COLORS = ['#1d7a34', '#d1242f']
const USEFULNESS_CHART_COLORS = ['#0f8a7a', '#9c6a11']

type SplitData = {
  label: string
  value: number
}

function formatDate(date: string | null) {
  if (!date) return 'Not voted yet'
  return new Date(date).toLocaleDateString()
}

function SplitDonutChart({
  title,
  data,
  colors,
}: {
  title: string
  data: SplitData[]
  colors: string[]
}) {
  return (
    <div className="split-chart">
      <h5>{title}</h5>
      <div className="chart-container">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="label" innerRadius={50} outerRadius={80}>
              {data.map((entry, index) => (
                <Cell key={entry.label} fill={colors[index % colors.length]} />
              ))}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function App() {
  const [laws, setLaws] = useState<Law[]>([])
  const [selectedLaw, setSelectedLaw] = useState<Law | null>(null)
  const [token, setToken] = useState<string | null>(localStorage.getItem('ourvoice_token'))
  const [user, setUser] = useState<User | null>(() => {
    const stored = localStorage.getItem('ourvoice_user')
    return stored ? JSON.parse(stored) : null
  })
  const [isRegisterMode, setIsRegisterMode] = useState(true)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [isAuthLoading, setIsAuthLoading] = useState(false)
  const [globalError, setGlobalError] = useState('')

  const sortedLaws = useMemo(() => {
    return [...laws].sort((a, b) => {
      const dateA = new Date(a.votedOn ?? a.introducedOn).valueOf() || 0
      const dateB = new Date(b.votedOn ?? b.introducedOn).valueOf() || 0
      if (dateA !== dateB) {
        return dateB - dateA
      }
      const cptA = Number.parseInt(String(a.cpt || '0'), 10) || 0
      const cptB = Number.parseInt(String(b.cpt || '0'), 10) || 0
      return cptB - cptA
    })
  }, [laws])

  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${API_BASE}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options?.headers ?? {}),
      },
    })

    const contentType = response.headers.get('content-type') || ''
    const isJson = contentType.includes('application/json')

    if (!response.ok) {
      const payload = isJson ? await response.json().catch(() => ({})) : {}
      throw new Error(payload.message || 'Request failed.')
    }

    if (!isJson) {
      const bodyText = await response.text()
      throw new Error(
        `API returned non-JSON from ${url}. Check VITE_API_URL. Response starts with: ${bodyText.slice(0, 80)}`
      )
    }

    return response.json()
  }

  async function loadLaws() {
    try {
      setGlobalError('')
      const data = await request<{ items: Law[] }>('/laws')
      setLaws(data.items)
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : 'Failed to load laws.')
    }
  }

  useEffect(() => {
    void loadLaws()
  }, [])

  async function handleAuthSubmit(event: FormEvent) {
    event.preventDefault()
    setAuthError('')
    setIsAuthLoading(true)

    try {
      const path = isRegisterMode ? '/auth/register' : '/auth/login'
      const body = isRegisterMode ? { name, email, password } : { email, password }
      const data = await request<{ token: string; user: User }>(path, {
        method: 'POST',
        body: JSON.stringify(body),
      })

      setToken(data.token)
      setUser(data.user)
      localStorage.setItem('ourvoice_token', data.token)
      localStorage.setItem('ourvoice_user', JSON.stringify(data.user))
      setPassword('')
      setName('')
      setEmail('')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed.')
    } finally {
      setIsAuthLoading(false)
    }
  }

  function signOut() {
    setToken(null)
    setUser(null)
    localStorage.removeItem('ourvoice_token')
    localStorage.removeItem('ourvoice_user')
  }

  async function submitCitizenVote(lawId: string, vote: 'support' | 'oppose') {
    try {
      await request(`/laws/${lawId}/citizen-vote`, {
        method: 'POST',
        body: JSON.stringify({ vote }),
      })
      await loadLaws()
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : 'Failed to save vote.')
    }
  }

  async function submitUsefulnessVote(lawId: string, vote: 'useful' | 'useless') {
    try {
      await request(`/laws/${lawId}/usefulness`, {
        method: 'POST',
        body: JSON.stringify({ vote }),
      })
      await loadLaws()
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : 'Failed to save usefulness vote.')
    }
  }

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>OurVoice</h1>
          <p className="subtitle">Compare how government voted with what citizens think.</p>
        </div>
        <div className="auth-state">
          {user ? (
            <>
              <span>Signed in as {user.name}</span>
              <button type="button" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <span>Sign in to vote</span>
          )}
        </div>
      </header>

      <section className="auth-panel">
        {!user && (
          <form className="auth-form" onSubmit={handleAuthSubmit}>
            <h2>{isRegisterMode ? 'Create account' : 'Sign in'}</h2>
            {isRegisterMode && (
              <label>
                Name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={2}
                />
              </label>
            )}

            <label>
              Email
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                required
              />
            </label>

            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                required
                minLength={6}
              />
            </label>

            {authError && <p className="error">{authError}</p>}

            <button disabled={isAuthLoading} type="submit">
              {isAuthLoading ? 'Please wait...' : isRegisterMode ? 'Register' : 'Sign in'}
            </button>

            <button
              className="ghost"
              type="button"
              onClick={() => setIsRegisterMode((current) => !current)}
            >
              {isRegisterMode ? 'Already have an account? Sign in' : 'Need an account? Register'}
            </button>
          </form>
        )}

        <p className="helper">
          Citizens can submit two types of feedback: <strong>support/oppose</strong> and
          <strong> useful/useless</strong>. This helps policymakers compare formal vote results
          with citizen sentiment.
        </p>
      </section>

      {globalError && <p className="error global-error">{globalError}</p>}

      <section className="laws-grid">
        {sortedLaws.map((law) => {
          const governmentChartData: SplitData[] = [
            { label: 'For', value: law.governmentVote.for },
            { label: 'Against', value: law.governmentVote.against },
            { label: 'Abstain', value: law.governmentVote.abstain },
          ]

          const citizenSentimentData: SplitData[] = [
            { label: 'Support', value: law.citizen.citizenVotes.support },
            { label: 'Oppose', value: law.citizen.citizenVotes.oppose },
          ]

          const usefulnessData: SplitData[] = [
            { label: 'Useful', value: law.citizen.usefulness.useful },
            { label: 'Useless', value: law.citizen.usefulness.useless },
          ]

          return (
          <article className="law-card" key={law.id}>
            <header className="law-header">
              <div>
                <h3>{law.title}</h3>
                <p className="law-summary-clamped">{law.summary}</p>
                <button className="ghost" type="button" onClick={() => setSelectedLaw(law)}>
                  Read full text
                </button>
              </div>
              <div className="meta">
                <span className={`status status-${law.status}`}>{law.status}</span>
                <span>{law.category}</span>
                {law.cpt && <span>ČPT: {law.cpt}</span>}
                {law.documentsUrl && (
                  <a href={law.documentsUrl} target="_blank" rel="noreferrer">
                    Documents
                  </a>
                )}
                {law.votingUrl && (
                  <a href={law.votingUrl} target="_blank" rel="noreferrer">
                    Voting detail
                  </a>
                )}
              </div>
            </header>

            <div className="comparison">
              <section className="column">
                <h4>Government</h4>
                <p>
                  Voted on: <strong>{formatDate(law.votedOn)}</strong>
                </p>
                <div className="stat-row">
                  <span>For</span>
                  <strong>{law.governmentVote.for}</strong>
                </div>
                <div className="stat-row">
                  <span>Against</span>
                  <strong>{law.governmentVote.against}</strong>
                </div>
                <div className="stat-row">
                  <span>Abstain</span>
                  <strong>{law.governmentVote.abstain}</strong>
                </div>

                <SplitDonutChart
                  title="Government vote split"
                  data={governmentChartData}
                  colors={GOVERNMENT_CHART_COLORS}
                />

                <p className="result-note">{law.resultNote}</p>
              </section>

              <section className="column citizen-column">
                <h4>Citizens</h4>
                <div className="stat-row">
                  <span>Support</span>
                  <strong>{law.citizen.citizenVotes.support}</strong>
                </div>
                <div className="stat-row">
                  <span>Oppose</span>
                  <strong>{law.citizen.citizenVotes.oppose}</strong>
                </div>
                <div className="stat-row">
                  <span>Useful</span>
                  <strong>{law.citizen.usefulness.useful}</strong>
                </div>
                <div className="stat-row">
                  <span>Useless</span>
                  <strong>{law.citizen.usefulness.useless}</strong>
                </div>

                <div className="charts-grid">
                  <SplitDonutChart
                    title="Citizen support split"
                    data={citizenSentimentData}
                    colors={CITIZEN_CHART_COLORS}
                  />
                  <SplitDonutChart
                    title="Citizen usefulness split"
                    data={usefulnessData}
                    colors={USEFULNESS_CHART_COLORS}
                  />
                </div>

                <div className="ai-explanation">
                  <h5>AI explanation</h5>
                  {law.aiExplanation ? (
                    <p className="ai-text">{law.aiExplanation}</p>
                  ) : (
                    <p className="ai-pending">Not available yet — generating a short summary.</p>
                  )}
                </div>
                {user ? (
                  <div className="action-row">
                    <button type="button" onClick={() => submitCitizenVote(law.id, 'support')}>
                      Support
                    </button>
                    <button type="button" onClick={() => submitCitizenVote(law.id, 'oppose')}>
                      Oppose
                    </button>
                    <button type="button" onClick={() => submitUsefulnessVote(law.id, 'useful')}>
                      Useful
                    </button>
                    <button
                      type="button"
                      onClick={() => submitUsefulnessVote(law.id, 'useless')}
                    >
                      Useless
                    </button>
                  </div>
                ) : (
                  <p className="helper">Sign in to vote and rate usefulness.</p>
                )}
              </section>
            </div>

          </article>
          )
        })}
      </section>

      {selectedLaw && (
        <div className="modal-backdrop" onClick={() => setSelectedLaw(null)} role="presentation">
          <section
            className="law-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Law full description"
          >
            <header className="law-modal-header">
              <h3>{selectedLaw.title}</h3>
              <button type="button" className="ghost" onClick={() => setSelectedLaw(null)}>
                Close
              </button>
            </header>
            <p>{selectedLaw.summary}</p>
            <section className="modal-ai">
              <h4>AI explanation</h4>
              {selectedLaw.aiExplanation ? (
                <p>{selectedLaw.aiExplanation}</p>
              ) : (
                <p className="ai-pending">Explanation not available yet. It may take a moment.</p>
              )}
            </section>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
