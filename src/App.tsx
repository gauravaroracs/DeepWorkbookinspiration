import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type BlockType = 'deep' | 'shallow' | 'buffer' | 'break'
type RetryAction = 'plan' | 'replan' | 'summary' | null

type ScheduleBlock = {
  id: string
  title: string
  type: BlockType
  startTime: string
  endTime: string
  notes: string
  done?: boolean
  crossedOut?: boolean
}

const SYSTEM_PROMPT = `You are a deep work scheduling assistant for a student. You follow 
Cal Newport's block scheduling method strictly. Rules:
1. Batch all shallow tasks together into one or two blocks
2. Only insert a break after every 90-120 minutes of work, not after 
   every task. Max one lunch break of 30-45 min if session spans midday.
3. Always end with one buffer/overflow block (15-30 min)
4. Keep the total number of blocks under 8-10. Do not over-fragment.
5. Each block must have a clear rationale in the notes field (1 sentence)
6. Return ONLY valid JSON. No markdown. No explanation. No backticks.
IMPORTANT: Your entire response must be a single raw JSON object. No markdown. No code fences. No text before or after. Start your response with { and end with }`

const SUMMARY_PROMPT =
  'You are a direct but constructive study coach. Summarize this student deep work session in 2-3 honest sentences. Mention what worked, what slipped, and one practical adjustment for tomorrow.'

const typeStyles: Record<BlockType, string> = {
  deep: 'border-blue-950 bg-blue-950 text-white',
  shallow: 'border-teal-300 bg-teal-50 text-teal-950',
  buffer: 'border-amber-400 bg-amber-100 text-amber-900',
  break: 'border-emerald-500 bg-emerald-100 text-emerald-900',
}

const typeBadgeStyles: Record<BlockType, string> = {
  deep: 'bg-white/15 text-white ring-white/30',
  shallow: 'bg-teal-100 text-teal-950 ring-teal-300',
  buffer: 'bg-amber-200 text-amber-950 ring-amber-300',
  break: 'bg-emerald-200 text-emerald-950 ring-emerald-300',
}

const typeLabels: Record<BlockType, string> = {
  deep: 'Deep work',
  shallow: 'Shallow',
  buffer: 'Buffer',
  break: 'Break',
}

const sampleTasks =
  'Study linear algebra problem set ~90min\nDraft literature review section ~2hr\nReply to professor email\nReview flashcards ~30min\nGym break\nPrepare tomorrow seminar notes'

const pixelsPerMinute = 1.25

const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

const toTime = (minutes: number) => {
  const normalized = Math.max(0, Math.min(23 * 60 + 59, minutes))
  const hours = Math.floor(normalized / 60)
  const mins = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

const nowTime = () => {
  const now = new Date()
  return toTime(now.getHours() * 60 + now.getMinutes())
}

const makeId = () => crypto.randomUUID?.() ?? `block-${Date.now()}-${Math.random()}`

const durationMinutes = (block: ScheduleBlock) => Math.max(0, toMinutes(block.endTime) - toMinutes(block.startTime))

const durationLabel = (block: ScheduleBlock) => {
  const minutes = durationMinutes(block)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`
}

const normalizeBlock = (block: Partial<ScheduleBlock>, startTime: string, endTime: string): ScheduleBlock => {
  const start = typeof block.startTime === 'string' ? block.startTime : startTime
  const end = typeof block.endTime === 'string' ? block.endTime : toTime(toMinutes(start) + 30)
  const startMinutes = Math.max(toMinutes(startTime), Math.min(toMinutes(endTime) - 15, toMinutes(start)))
  const endMinutes = Math.min(toMinutes(endTime), Math.max(startMinutes + 15, toMinutes(end)))
  const type = block.type && ['deep', 'shallow', 'buffer', 'break'].includes(block.type) ? block.type : 'buffer'

  return {
    id: block.id || makeId(),
    title: block.title?.trim() || 'Untitled block',
    type,
    startTime: toTime(startMinutes),
    endTime: toTime(endMinutes),
    notes: block.notes?.trim() || 'Scheduled to keep the session intentional and bounded.',
  }
}

const parseAiBlocks = (content: string, startTime: string, endTime: string) => {
  let parsed: unknown
  const jsonMatch = content.match(/\{[\s\S]*\}/)

  if (!jsonMatch) {
    throw new Error('No JSON found')
  }

  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    throw new Error('The AI response was not valid JSON.')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('No blocks array')
  }

  const candidate = parsed as {
    blocks?: unknown
    schedule?: unknown
    plan?: { blocks?: unknown }
  }
  const rawBlocks = Array.isArray(candidate.blocks)
    ? candidate.blocks
    : Array.isArray(candidate.schedule)
      ? candidate.schedule
      : Array.isArray(candidate.plan?.blocks)
        ? candidate.plan.blocks
        : null

  if (!rawBlocks) {
    throw new Error(`No blocks array. Model returned: ${content.slice(0, 260)}`)
  }

  const blocks = (rawBlocks as Partial<ScheduleBlock>[])
    .map((block) => normalizeBlock(block, startTime, endTime))
    .filter((block) => toMinutes(block.endTime) > toMinutes(block.startTime))

  if (!blocks.length) throw new Error('The AI returned an empty schedule.')
  return blocks
}

async function callOpenAi(params: {
  apiKey: string
  messages: { role: 'system' | 'user'; content: string }[]
  json?: boolean
}) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 30_000)

  let response: Response
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: params.json ? 0.2 : 0.4,
        ...(params.json ? { response_format: { type: 'json_object' } } : {}),
        messages: params.messages,
      }),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('OpenAI request timed out after 30 seconds.', { cause: err })
    }
    throw err
  } finally {
    window.clearTimeout(timeout)
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    throw new Error(`OpenAI request failed (${response.status})${details ? `: ${details.slice(0, 220)}` : ''}`)
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('OpenAI returned no content.')
  return content
}

async function requestPlan(params: {
  apiKey: string
  tasks: string
  startTime: string
  endTime: string
  completed?: ScheduleBlock[]
  currentTime?: string
  happened?: string
  leftToDo?: string
}) {
  const userContent = params.currentTime
    ? `Completed blocks: ${JSON.stringify(params.completed ?? [])}
Current time: ${params.currentTime}
Session end time: ${params.endTime}
What happened: ${params.happened}
What's left to do: ${params.leftToDo}
Return the same JSON shape, only for remaining time slots.`
    : `Task list: ${params.tasks}
Session start time: ${params.startTime}
Session end time: ${params.endTime}
Return ONLY valid JSON.`

  const content = await callOpenAi({
    apiKey: params.apiKey,
    json: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  })

  return parseAiBlocks(content, params.currentTime ?? params.startTime, params.endTime)
}

function App() {
  const envKey = import.meta.env.VITE_OPENAI_API_KEY as string | undefined
  const [apiKey, setApiKey] = useState(envKey ?? '')
  const [startTime, setStartTime] = useState('10:00')
  const [endTime, setEndTime] = useState('22:00')
  const [tasks, setTasks] = useState(sampleTasks)
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([])
  const [setupOpen, setSetupOpen] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reflection, setReflection] = useState('')
  const [aiSummary, setAiSummary] = useState('')
  const [error, setError] = useState('')
  const [retryAction, setRetryAction] = useState<RetryAction>(null)
  const [loading, setLoading] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [replanOpen, setReplanOpen] = useState(false)
  const [happened, setHappened] = useState('')
  const [leftToDo, setLeftToDo] = useState('')
  const [currentTime, setCurrentTime] = useState(nowTime)

  const timelineRef = useRef<HTMLDivElement | null>(null)
  const nowLineRef = useRef<HTMLDivElement | null>(null)
  const selectedRef = useRef<string | null>(null)

  const activeBlocks = useMemo(() => blocks.filter((block) => !block.crossedOut), [blocks])
  const completedCount = activeBlocks.filter((block) => block.done).length
  const score = activeBlocks.length ? Math.round((completedCount / activeBlocks.length) * 100) : 0
  const sessionStart = toMinutes(startTime)
  const sessionEnd = toMinutes(endTime)
  const sessionMinutes = Math.max(60, sessionEnd - sessionStart)
  const currentMinutes = toMinutes(currentTime)
  const isNowInSession = currentMinutes >= sessionStart && currentMinutes <= sessionEnd
  const nowTop = Math.max(0, Math.min(sessionMinutes, currentMinutes - sessionStart)) * pixelsPerMinute
  const plannedMinutes = activeBlocks.reduce((total, block) => total + durationMinutes(block), 0)
  const completedMinutes = activeBlocks
    .filter((block) => block.done)
    .reduce((total, block) => total + durationMinutes(block), 0)
  const completionWidth = plannedMinutes ? Math.min(100, Math.round((completedMinutes / plannedMinutes) * 100)) : 0
  const reflectionUnlocked = completedCount > 0 || currentMinutes >= sessionEnd

  const scrollNowIntoView = useCallback(() => {
    window.setTimeout(() => {
      if (nowLineRef.current && isNowInSession) {
        nowLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else {
        timelineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }, 100)
  }, [isNowInSession])

  const clearError = () => {
    setError('')
    setRetryAction(null)
  }

  const planSession = async () => {
    if (!apiKey.trim()) {
      setError('Add an OpenAI API key to plan the session.')
      setRetryAction('plan')
      return
    }

    setLoading(true)
    clearError()
    try {
      const planned = await requestPlan({ apiKey, tasks, startTime, endTime })
      setBlocks(planned)
      setSelectedId(planned[0]?.id ?? null)
      setSetupOpen(false)
      scrollNowIntoView()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Planning failed.')
      setRetryAction('plan')
    } finally {
      setLoading(false)
    }
  }

  const replanRemaining = async () => {
    if (!apiKey.trim()) {
      setError('Add an OpenAI API key to replan the remaining session.')
      setRetryAction('replan')
      return
    }

    const current = nowTime()
    const nextCurrentMinutes = toMinutes(current)
    setCurrentTime(current)
    setLoading(true)
    clearError()

    try {
      const replanned = await requestPlan({
        apiKey,
        tasks,
        startTime,
        endTime,
        completed: blocks.filter((block) => block.done),
        currentTime: current,
        happened,
        leftToDo,
      })

      setBlocks((existing) => [
        ...existing.map((block) =>
          !block.done && toMinutes(block.endTime) > nextCurrentMinutes ? { ...block, crossedOut: true } : block,
        ),
        ...replanned,
      ])
      setSelectedId(replanned[0]?.id ?? null)
      setReplanOpen(false)
      scrollNowIntoView()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replanning failed.')
      setRetryAction('replan')
    } finally {
      setLoading(false)
    }
  }

  const summarizeDay = async () => {
    if (!apiKey.trim()) {
      setError('Add an OpenAI API key to summarize the session.')
      setRetryAction('summary')
      return
    }

    setSummaryLoading(true)
    clearError()
    try {
      const summary = await callOpenAi({
        apiKey,
        messages: [
          { role: 'system', content: SUMMARY_PROMPT },
          {
            role: 'user',
            content: `Blocks: ${JSON.stringify(activeBlocks)}
Completion score: ${score}%
Planned minutes: ${plannedMinutes}
Completed minutes: ${completedMinutes}
Student reflection: ${reflection}`,
          },
        ],
      })
      setAiSummary(summary.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Summary failed.')
      setRetryAction('summary')
    } finally {
      setSummaryLoading(false)
    }
  }

  const retry = () => {
    if (retryAction === 'plan') void planSession()
    if (retryAction === 'replan') void replanRemaining()
    if (retryAction === 'summary') void summarizeDay()
  }

  const toggleDone = useCallback((id: string) => {
    setBlocks((current) => current.map((block) => (block.id === id ? { ...block, done: !block.done } : block)))
  }, [])

  const resizeBlock = (id: string, direction: 1 | -1) => {
    setBlocks((current) =>
      current.map((block) => {
        if (block.id !== id) return block
        const end = toMinutes(block.endTime) + direction * 15
        const minEnd = toMinutes(block.startTime) + 15
        return { ...block, endTime: toTime(Math.max(minEnd, Math.min(sessionEnd, end))) }
      }),
    )
  }

  const updateTime = (id: string, field: 'startTime' | 'endTime', value: string) => {
    setBlocks((current) => current.map((block) => (block.id === id ? { ...block, [field]: value } : block)))
  }

  const exportSummary = () => {
    const lines = [
      'Deep Work Session',
      `${startTime}-${endTime} | ${score}% completed`,
      '',
      ...blocks.map((block) => {
        const status = block.done ? '[x]' : block.crossedOut ? '[-]' : '[ ]'
        const crossed = block.crossedOut ? '~~' : ''
        return `${status} ${crossed}${block.startTime}-${block.endTime} ${typeLabels[block.type]}: ${block.title}${crossed}`
      }),
      '',
      `Reflection: ${reflection || 'No reflection yet.'}`,
      `AI summary: ${aiSummary || 'Not generated.'}`,
    ]
    navigator.clipboard?.writeText(lines.join('\n'))
    setError('Plain text summary copied to clipboard.')
    setRetryAction(null)
  }

  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(nowTime()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (blocks.length) scrollNowIntoView()
  }, [blocks.length, scrollNowIntoView])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.code !== 'Space' || !selectedRef.current || target?.matches('input, textarea, select, button')) return
      event.preventDefault()
      toggleDone(selectedRef.current)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleDone])

  return (
    <main className="min-h-screen bg-[#f7f3ea] px-4 py-5 text-slate-900 sm:px-6">
      <div className="mx-auto w-full max-w-[800px]">
        <header className="mb-5 border-b border-stone-300 pb-4">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-slate-500">Deep Work Block Planner</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-normal text-slate-950 sm:text-4xl">
            Plan your session.
          </h1>
        </header>

        {error && (
          <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span>
              {retryAction && (
                <button type="button" onClick={retry} className="rounded bg-amber-900 px-3 py-2 text-white">
                  Retry
                </button>
              )}
            </div>
          </div>
        )}

        <section
          className={
            blocks.length && !setupOpen
              ? 'rounded border border-stone-300 bg-stone-100/80'
              : 'rounded border border-stone-300 bg-[#fffdf7] shadow-sm'
          }
        >
          {blocks.length && !setupOpen ? (
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm text-slate-600">
              <p className="truncate">
                <span className="font-medium text-slate-800">Session:</span> {startTime} - {endTime} · {blocks.length}{' '}
                blocks planned
              </p>
              <button type="button" onClick={() => setSetupOpen(true)} className="font-mono text-blue-900 underline">
                edit ✎
              </button>
            </div>
          ) : (
            <div className="p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="font-mono text-xs uppercase text-slate-500">Session start</span>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                    className="mt-1 w-full rounded border border-stone-300 bg-white px-3 py-2 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="font-mono text-xs uppercase text-slate-500">Session end</span>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                    className="mt-1 w-full rounded border border-stone-300 bg-white px-3 py-2 font-mono"
                  />
                </label>
              </div>

              <label className="mt-5 block">
                <span className="font-mono text-xs uppercase text-slate-500">Brain dump</span>
                <textarea
                  value={tasks}
                  onChange={(event) => setTasks(event.target.value)}
                  rows={8}
                  className="mt-1 w-full resize-y rounded border border-stone-300 bg-white px-4 py-3 leading-7 outline-none focus:border-slate-700"
                  placeholder="problem set ~90min, reading notes, email professor"
                />
              </label>

              <label className="mt-5 block">
                <span className="font-mono text-xs uppercase text-slate-500">OpenAI API key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="mt-1 w-full rounded border border-stone-300 bg-white px-3 py-2"
                  placeholder="sk-... or VITE_OPENAI_API_KEY"
                />
              </label>

              {error && (
                <div className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span>{error}</span>
                    {retryAction && (
                      <button type="button" onClick={retry} className="rounded bg-amber-900 px-3 py-1.5 text-white">
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="mt-5 flex justify-end">
                <button
                  type="button"
                  onClick={planSession}
                  disabled={loading || sessionStart >= sessionEnd}
                  className="rounded bg-slate-950 px-5 py-3 font-medium text-white disabled:opacity-50"
                >
                  {loading ? 'Planning...' : 'Plan My Session'}
                </button>
              </div>
            </div>
          )}
        </section>

        <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(160px,190px)_minmax(0,1fr)]">
          <aside className="sticky top-3 z-20 min-w-[160px] rounded border border-stone-300 bg-[#fffdf7]/95 p-4 shadow-sm backdrop-blur sm:self-start">
            <p className="font-mono text-xs uppercase text-slate-500">Session</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-1">
              <div className="rounded border border-stone-300 bg-white p-3">
                <p className="text-slate-500">Score</p>
                <p className="mt-1 text-2xl font-semibold">{score}%</p>
              </div>
              <div className="rounded border border-stone-300 bg-white p-3">
                <p className="text-slate-500">Done</p>
                <p className="mt-1 text-2xl font-semibold">
                  {completedCount}/{activeBlocks.length}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setReplanOpen((open) => !open)}
              disabled={!blocks.length || loading}
              className="mt-3 w-full whitespace-nowrap rounded bg-slate-950 px-3 py-3 text-sm text-white disabled:opacity-50"
            >
              Something came up
            </button>

            <div className="mt-4 border-l-2 border-slate-300 pl-3 text-[11px] leading-4 text-slate-600">
              <p className="font-mono text-slate-950">"A schedule defends from chaos and whim"</p>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 font-mono text-xs text-slate-600 sm:grid-cols-1">
              {Object.entries(typeLabels).map(([type, label]) => (
                <div key={type} className="flex min-w-0 items-center gap-2 whitespace-nowrap">
                  <span className={`h-3 w-3 shrink-0 rounded-sm border ${typeStyles[type as BlockType]}`} />
                  <span className="leading-none">{label}</span>
                </div>
              ))}
            </div>
          </aside>

          <div>
            {replanOpen && (
              <section className="mb-4 rounded border border-stone-300 bg-[#fffdf7] p-4 shadow-sm">
                <p className="font-mono text-xs uppercase text-slate-500">Replan remaining session</p>
                <label className="mt-3 block">
                  <span className="text-sm font-medium">What happened?</span>
                  <textarea
                    value={happened}
                    onChange={(event) => setHappened(event.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded border border-stone-300 bg-white px-3 py-2"
                  />
                </label>
                <label className="mt-3 block">
                  <span className="text-sm font-medium">What's left to do?</span>
                  <textarea
                    value={leftToDo}
                    onChange={(event) => setLeftToDo(event.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded border border-stone-300 bg-white px-3 py-2"
                  />
                </label>
                <button
                  type="button"
                  onClick={replanRemaining}
                  disabled={loading}
                  className="mt-3 rounded bg-slate-950 px-4 py-3 text-sm text-white disabled:opacity-50"
                >
                  {loading ? 'Replanning...' : 'Replan remaining day'}
                </button>
              </section>
            )}

            <section ref={timelineRef} className="rounded border border-stone-300 bg-[#fffdf7] p-4 shadow-sm">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-xs uppercase text-slate-500">Live timeline</p>
                  <p className="text-sm text-slate-600">{startTime} - {endTime}</p>
                </div>
                <p className="font-mono text-sm text-red-700">NOW {currentTime}</p>
              </div>

              {!blocks.length ? (
                <div className="rounded border border-dashed border-stone-300 bg-stone-50 p-8 text-center text-sm text-slate-500">
                  {loading ? 'Planning your session...' : error ? `Planning failed: ${error}` : 'Plan your session to draw the live timeline.'}
                </div>
              ) : (
                <div
                  className="relative grid grid-cols-[58px_minmax(0,1fr)] gap-3 font-mono text-sm"
                  style={{ minHeight: sessionMinutes * pixelsPerMinute }}
                >
                  <div className="relative border-r border-stone-300 pr-3 text-right text-slate-400">
                    {Array.from({ length: Math.floor(sessionMinutes / 60) + 1 }).map((_, index) => (
                      <div
                        key={index}
                        className="absolute right-3"
                        style={{ top: index * 60 * pixelsPerMinute - 8 }}
                      >
                        {toTime(sessionStart + index * 60)}
                      </div>
                    ))}
                  </div>

                  <div className="relative">
                    {isNowInSession && (
                      <div ref={nowLineRef} className="absolute left-0 right-0 z-10" style={{ top: nowTop }}>
                        <div className="flex items-center gap-2">
                          <span className="whitespace-nowrap rounded bg-red-700 px-2 py-1 text-[11px] font-semibold text-white">
                            NOW {currentTime}
                          </span>
                          <span className="h-0.5 flex-1 bg-red-600" />
                        </div>
                      </div>
                    )}

                    {blocks.map((block) => {
                      const top = Math.max(0, toMinutes(block.startTime) - sessionStart) * pixelsPerMinute
                      const height = Math.max(58, durationMinutes(block) * pixelsPerMinute - 8)
                      const selected = selectedId === block.id
                      const completeStyle = block.done || block.crossedOut ? 'opacity-40' : ''

                      return (
                        <article
                          key={block.id}
                          onClick={() => setSelectedId(selected ? null : block.id)}
                          className={`group absolute left-0 right-0 rounded border p-3 shadow-sm transition ${typeStyles[block.type]} ${completeStyle} ${
                            selected ? 'ring-2 ring-slate-900 ring-offset-2' : ''
                          }`}
                          style={{ top, minHeight: height }}
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`rounded px-2 py-1 text-[11px] ring-1 ${typeBadgeStyles[block.type]}`}>
                                  {typeLabels[block.type]}
                                </span>
                                <span className="text-xs opacity-80">
                                  {block.startTime} - {block.endTime} · {durationLabel(block)}
                                </span>
                              </div>
                              <p className={`mt-2 text-base font-semibold ${block.done || block.crossedOut ? 'line-through' : ''}`}>
                                {block.title}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                toggleDone(block.id)
                              }}
                              className="self-start rounded border border-current px-3 py-1.5 text-xs"
                            >
                              {block.done ? 'Undo' : 'Done'}
                            </button>
                          </div>

                          {selected && (
                            <div className="mt-3 border-t border-current/25 pt-3 text-xs leading-5">
                              <p>{block.notes}</p>
                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                <input
                                  type="time"
                                  value={block.startTime}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) => updateTime(block.id, 'startTime', event.target.value)}
                                  className="rounded border border-current bg-white/80 px-2 py-1 text-slate-950"
                                />
                                <span>to</span>
                                <input
                                  type="time"
                                  value={block.endTime}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) => updateTime(block.id, 'endTime', event.target.value)}
                                  className="rounded border border-current bg-white/80 px-2 py-1 text-slate-950"
                                />
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    resizeBlock(block.id, -1)
                                  }}
                                  className="rounded border border-current px-2 py-1 sm:opacity-0 sm:transition group-hover:opacity-100"
                                >
                                  -15m
                                </button>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    resizeBlock(block.id, 1)
                                  }}
                                  className="rounded border border-current px-2 py-1 sm:opacity-0 sm:transition group-hover:opacity-100"
                                >
                                  +15m
                                </button>
                              </div>
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>

        {reflectionUnlocked ? (
        <section className="mt-5 rounded border border-stone-300 bg-[#fffdf7] p-5 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-mono text-xs uppercase text-slate-500">Reflection</p>
              <h2 className="mt-1 text-2xl font-semibold">End of session</h2>
            </div>
            <div className="rounded border border-stone-300 bg-white p-4">
              <p className="text-sm text-slate-500">Completion score</p>
              <p className="mt-1 text-4xl font-semibold">{score}%</p>
            </div>
          </div>

          <div className="mt-5">
            <div className="flex justify-between text-xs text-slate-500">
              <span>Planned time</span>
              <span>{completedMinutes} / {plannedMinutes} min completed</span>
            </div>
            <div className="mt-2 h-3 overflow-hidden rounded bg-stone-200">
              <div className="h-full bg-blue-950" style={{ width: `${completionWidth}%` }} />
            </div>
          </div>

          <div className="mt-5 space-y-2">
            {activeBlocks.map((block) => {
              const status =
                block.done ? { mark: '✓', label: 'done', color: 'text-emerald-700' } :
                currentMinutes >= toMinutes(block.startTime) && currentMinutes < toMinutes(block.endTime) ?
                  { mark: '→', label: 'in progress', color: 'text-amber-700' } :
                  currentMinutes > toMinutes(block.endTime) ? { mark: '✗', label: 'skipped', color: 'text-red-700' } :
                    { mark: '•', label: 'planned', color: 'text-slate-500' }

              return (
                <div key={block.id} className="grid grid-cols-[70px_minmax(0,1fr)_92px] items-center gap-3 text-sm">
                  <span className="font-mono text-slate-500">{block.startTime}</span>
                  <div className={`rounded border px-3 py-2 ${typeStyles[block.type]} ${block.done ? '' : 'opacity-80'}`}>
                    {block.title}
                  </div>
                  <span className={`font-mono text-right text-xs ${status.color}`}>
                    {status.mark} {status.label}
                  </span>
                </div>
              )
            })}
          </div>

          <label className="mt-5 block">
            <span className="font-mono text-xs uppercase text-slate-500">What would you do differently?</span>
            <textarea
              value={reflection}
              onChange={(event) => setReflection(event.target.value)}
              rows={5}
              className="mt-2 w-full rounded border border-stone-300 bg-white px-3 py-2"
            />
          </label>

          <div className="mt-4 rounded border border-stone-300 bg-stone-50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="font-mono text-xs uppercase text-slate-500">AI summary of your day</p>
              <button
                type="button"
                onClick={summarizeDay}
                disabled={summaryLoading || !reflection.trim()}
                className="rounded bg-slate-950 px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {summaryLoading ? 'Summarizing...' : 'Summarize my day'}
              </button>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-700">{aiSummary || 'Add a reflection, then summarize the session.'}</p>
          </div>

          <button type="button" onClick={exportSummary} className="mt-4 rounded bg-slate-950 px-4 py-3 text-white">
            Export Plain Text
          </button>
        </section>
        ) : (
          <p className="mt-5 rounded border border-stone-300 bg-stone-100/80 px-3 py-2 text-sm text-slate-500">
            Reflection unlocks at end of session.
          </p>
        )}
      </div>
    </main>
  )
}

export default App
