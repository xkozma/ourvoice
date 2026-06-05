import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { translations } from './i18n'
import type { Lang } from './i18n'
import './App.css'

type AuthUser = {
  id: string
  phone: string
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
  aiExplanationSk?: string | null
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

function formatDate(date: string | null, lang: Lang) {
  if (!date) return lang === 'sk' ? 'Ešte nehlasoval' : 'Not voted yet'
  return new Date(date).toLocaleDateString(lang === 'sk' ? 'sk-SK' : 'en-GB')
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
      <div className="chart-container" style={{ minHeight: 140, minWidth: 0 }}>
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
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('ourvoice_token'))
  const [user, setUser] = useState<AuthUser | null>(() => {
    const stored = localStorage.getItem('ourvoice_user')
    if (!stored) return null
    try {
      const parsed = JSON.parse(stored) as AuthUser
      // Discard stale sessions from the old email/password auth (no phone field)
      if (!parsed.phone) {
        localStorage.removeItem('ourvoice_user')
        localStorage.removeItem('ourvoice_token')
        return null
      }
      return parsed
    } catch {
      return null
    }
  })
  // Keep a ref so async callbacks always read the latest token
  const tokenRef = useRef<string | null>(token)
  const [phone, setPhone] = useState('+421')
  const [otpCode, setOtpCode] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [authError, setAuthError] = useState('')
  const [isAuthLoading, setIsAuthLoading] = useState(false)
  const [globalError, setGlobalError] = useState('')
  const [lang, setLang] = useState<Lang>(
    () => (localStorage.getItem('ourvoice_lang') as Lang) || 'sk'
  )
  const t = translations[lang]

  function switchLang(l: Lang) {
    setLang(l)
    localStorage.setItem('ourvoice_lang', l)
  }

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

  // Keep tokenRef in sync so async vote handlers always use the latest token
  useEffect(() => {
    tokenRef.current = token
  }, [token])

  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${API_BASE}${path}`
    const accessToken = tokenRef.current
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
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

  async function handlePhoneSubmit(event: FormEvent) {
    event.preventDefault()
    setAuthError('')
    setIsAuthLoading(true)

    const normalized = phone.startsWith('+421') ? phone : `+421${phone.replace(/\D/g, '')}`

    if (!/^\+421[0-9]{9}$/.test(normalized)) {
      setAuthError('Enter a valid Slovak number: +421 followed by 9 digits.')
      setIsAuthLoading(false)
      return
    }

    try {
      const res = await fetch(`${API_BASE}/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: normalized }),
      })
      const payload = await res.json() as { message?: string }
      if (!res.ok) throw new Error(payload.message || 'Failed to send code.')
      setPhone(normalized)
      setOtpSent(true)
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Failed to send verification code.')
    } finally {
      setIsAuthLoading(false)
    }
  }

  async function handleOtpSubmit(event: FormEvent) {
    event.preventDefault()
    setAuthError('')
    setIsAuthLoading(true)

    try {
      const res = await fetch(`${API_BASE}/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code: otpCode.trim() }),
      })
      const data = await res.json() as { token?: string; user?: AuthUser; message?: string }
      if (!res.ok) throw new Error(data.message || 'Invalid code.')

      setToken(data.token!)
      setUser(data.user!)
      tokenRef.current = data.token!
      localStorage.setItem('ourvoice_token', data.token!)
      localStorage.setItem('ourvoice_user', JSON.stringify(data.user))
      setOtpCode('')
      setOtpSent(false)
      setPhone('+421')
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Invalid verification code.')
    } finally {
      setIsAuthLoading(false)
    }
  }

  function signOut() {
    setToken(null)
    setUser(null)
    tokenRef.current = null
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
          <p className="subtitle">{t.subtitle}</p>
        </div>
        <div className="topbar-right">
          <div className="lang-switcher">
            <button
              type="button"
              className={`lang-btn${lang === 'sk' ? ' lang-btn-active' : ''}`}
              onClick={() => switchLang('sk')}
            >
              SK
            </button>
            <button
              type="button"
              className={`lang-btn${lang === 'en' ? ' lang-btn-active' : ''}`}
              onClick={() => switchLang('en')}
            >
              EN
            </button>
          </div>
          <div className="auth-state">
            {user ? (
              <>
                <span>+421&thinsp;·····{user.phone?.slice(-4) ?? '····'}</span>
                <button type="button" onClick={signOut}>
                  {t.signOut}
                </button>
              </>
            ) : (
              <span>{t.signInToVote}</span>
            )}
          </div>
        </div>
      </header>

      <section className="auth-panel">
        {!user && (
          <form
            className="auth-form"
            onSubmit={otpSent ? handleOtpSubmit : handlePhoneSubmit}
          >
            <h2>{t.signIn}</h2>

            {!otpSent ? (
              <>
                <label>
                  {t.phoneNumber}
                  <div className="phone-input-row">
                    <span className="phone-prefix">+421</span>
                    <input
                      value={phone.replace(/^\+421/, '')}
                      onChange={(e) =>
                        setPhone(`+421${e.target.value.replace(/\D/g, '').slice(0, 9)}`)
                      }
                      type="tel"
                      inputMode="numeric"
                      placeholder={t.phoneDigits}
                      autoComplete="tel"
                      required
                    />
                  </div>
                </label>
                <p className="helper-small">{t.phoneHint}</p>
              </>
            ) : (
              <>
                <p className="otp-prompt">
                  {t.codeSentTo} <strong>{phone}</strong>.
                </p>
                <label>
                  {t.verificationCode}
                  <input
                    value={otpCode}
                    onChange={(e) =>
                      setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                    }
                    type="text"
                    inputMode="numeric"
                    placeholder={t.sixDigitCode}
                    autoComplete="one-time-code"
                    required
                  />
                </label>
                {import.meta.env.VITE_DEV === 'true' && (
                  <p className="dev-hint">
                    {t.devHintPre}<strong>456123</strong>{t.devHintPost}
                  </p>
                )}
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setOtpSent(false)
                    setOtpCode('')
                    setAuthError('')
                  }}
                >
                  {t.changeNumber}
                </button>
              </>
            )}

            {authError && <p className="error">{authError}</p>}

            <button disabled={isAuthLoading} type="submit">
              {isAuthLoading ? t.pleaseWait : otpSent ? t.verifyCode : t.sendCode}
            </button>
          </form>
        )}

        <p className="helper">
          {t.feedbackIntro} <strong>{t.feedbackSupport}</strong> {t.feedbackAnd}{' '}
          <strong>{t.feedbackUsefulness}</strong>. {t.feedbackOutro}
        </p>
      </section>

      {globalError && <p className="error global-error">{globalError}</p>}

      <section className="laws-grid">
        {sortedLaws.map((law) => {
          const governmentChartData: SplitData[] = [
            { label: t.for, value: law.governmentVote.for },
            { label: t.against, value: law.governmentVote.against },
            { label: t.abstain, value: law.governmentVote.abstain },
          ]

          const citizenSentimentData: SplitData[] = [
            { label: t.support, value: law.citizen.citizenVotes.support },
            { label: t.oppose, value: law.citizen.citizenVotes.oppose },
          ]

          const usefulnessData: SplitData[] = [
            { label: t.useful, value: law.citizen.usefulness.useful },
            { label: t.useless, value: law.citizen.usefulness.useless },
          ]

          return (
          <article className="law-card" key={law.id}>
            <header className="law-header">
              <div>
                <h3>{law.title}</h3>
                <p className="law-summary-clamped">{law.summary}</p>
                <button className="ghost" type="button" onClick={() => setSelectedLaw(law)}>
                  {t.readFullText}
                </button>
              </div>
              <div className="meta">
                <span className={`status status-${law.status}`}>
                  {law.status === 'passed' ? t.statusPassed : law.status === 'rejected' ? t.statusRejected : t.statusInProgress}
                </span>
                <span>{law.category}</span>
                {law.cpt && <span>ČPT: {law.cpt}</span>}
                {law.documentsUrl && (
                  <a href={law.documentsUrl} target="_blank" rel="noreferrer">
                    {t.documents}
                  </a>
                )}
                {law.votingUrl && (
                  <a href={law.votingUrl} target="_blank" rel="noreferrer">
                    {t.votingDetail}
                  </a>
                )}
              </div>
            </header>

            <div className="comparison">
              <section className="column">
                <h4>{t.government}</h4>
                <p>
                  {t.votedOn} <strong>{formatDate(law.votedOn, lang)}</strong>
                </p>
                <div className="stat-row">
                  <span>{t.for}</span>
                  <strong>{law.governmentVote.for}</strong>
                </div>
                <div className="stat-row">
                  <span>{t.against}</span>
                  <strong>{law.governmentVote.against}</strong>
                </div>
                <div className="stat-row">
                  <span>{t.abstain}</span>
                  <strong>{law.governmentVote.abstain}</strong>
                </div>

                <SplitDonutChart
                  title={t.govChartTitle}
                  data={governmentChartData}
                  colors={GOVERNMENT_CHART_COLORS}
                />

                <p className="result-note">{law.resultNote}</p>
              </section>

              <section className="column citizen-column">
                <h4>{t.citizens}</h4>
                <div className="stat-row">
                  <span>{t.support}</span>
                  <strong>{law.citizen.citizenVotes.support}</strong>
                </div>
                <div className="stat-row">
                  <span>{t.oppose}</span>
                  <strong>{law.citizen.citizenVotes.oppose}</strong>
                </div>
                <div className="stat-row">
                  <span>{t.useful}</span>
                  <strong>{law.citizen.usefulness.useful}</strong>
                </div>
                <div className="stat-row">
                  <span>{t.useless}</span>
                  <strong>{law.citizen.usefulness.useless}</strong>
                </div>
                <p className="civic-disclaimer">{t.civicDisclaimer}</p>

                <div className="charts-grid">
                  <SplitDonutChart
                    title={t.citizenSupportChart}
                    data={citizenSentimentData}
                    colors={CITIZEN_CHART_COLORS}
                  />
                  <SplitDonutChart
                    title={t.citizenUsefulnessChart}
                    data={usefulnessData}
                    colors={USEFULNESS_CHART_COLORS}
                  />
                </div>

                <div className="ai-explanation">
                  <h5>{t.aiExplanation}</h5>
                  {(lang === 'sk' ? law.aiExplanationSk : law.aiExplanation) ? (
                    <>
                      <p className="ai-text">{lang === 'sk' ? law.aiExplanationSk : law.aiExplanation}</p>
                      <p className="ai-disclaimer">{t.aiDisclaimer}</p>
                    </>
                  ) : (
                    <p className="ai-pending">{t.aiPending}</p>
                  )}
                </div>
                {user ? (
                  <div className="action-row">
                    <button type="button" onClick={() => submitCitizenVote(law.id, 'support')}>
                      {t.support}
                    </button>
                    <button type="button" onClick={() => submitCitizenVote(law.id, 'oppose')}>
                      {t.oppose}
                    </button>
                    <button type="button" onClick={() => submitUsefulnessVote(law.id, 'useful')}>
                      {t.useful}
                    </button>
                    <button
                      type="button"
                      onClick={() => submitUsefulnessVote(law.id, 'useless')}
                    >
                      {t.useless}
                    </button>
                  </div>
                ) : (
                  <p className="helper">{t.signInToVoteHint}</p>
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
                {t.close}
              </button>
            </header>
            <p>{selectedLaw.summary}</p>
            <section className="modal-ai">
              <h4>{t.aiExplanation}</h4>
              {(lang === 'sk' ? selectedLaw.aiExplanationSk : selectedLaw.aiExplanation) ? (
                <>
                  <p>{lang === 'sk' ? selectedLaw.aiExplanationSk : selectedLaw.aiExplanation}</p>
                  <p className="ai-disclaimer">{t.aiDisclaimer}</p>
                </>
              ) : (
                <p className="ai-pending">{t.aiPendingModal}</p>
              )}
            </section>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
