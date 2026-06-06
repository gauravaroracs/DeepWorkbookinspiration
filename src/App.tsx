import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, useMotionValue, useTransform, animate, type PanInfo } from 'framer-motion'
import * as Tooltip from '@radix-ui/react-tooltip'

type BlockType = 'deep' | 'shallow' | 'buffer' | 'break'
type Mode = 'ai' | 'manual' | null
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
0. Cover every minute of the session with no gaps. If there is
   time between tasks, insert an explicit 'Open / unscheduled' block
   of type buffer. The schedule must be continuous from the first
   task to the end buffer block. No unassigned minutes.
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

const typeLabelClass: Record<BlockType, string> = {
  deep: 'type-label-deep',
  shallow: 'type-label-shallow',
  buffer: 'type-label-buffer',
  break: 'type-label-break',
}

const typeLabels: Record<BlockType, string> = {
  deep: 'Deep work',
  shallow: 'Shallow',
  buffer: 'Buffer',
  break: 'Break',
}

const sampleTasks =
  'Study linear algebra problem set ~90min\nDraft literature review section ~2hr\nReply to professor email\nReview flashcards ~30min\nGym break\nPrepare tomorrow seminar notes'

const pixelsPerMinute = 1.6

const formatDate = () => {
  const now = new Date()
  return now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

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

const parseTasks = (raw: string) =>
  raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 2)
    .map((line) => ({
      id: makeId(),
      text: line.replace(/~\d+\s*(min|hr|h|m)\b/gi, '').trim(),
      done: false,
    }))

const fillGaps = (blocks: ScheduleBlock[], start: number, end: number) => {
  const MAX_GAP_TO_FILL = 60
  const sorted = [...blocks.filter((b) => b.title !== 'Open time')].sort(
    (a, b) => toMinutes(a.startTime) - toMinutes(b.startTime),
  )
  const filled: ScheduleBlock[] = []
  let cursor = start
  for (const block of sorted) {
    const blockStart = toMinutes(block.startTime)
    if (blockStart > cursor + 5 && blockStart - cursor <= MAX_GAP_TO_FILL) {
      filled.push({
        id: makeId(),
        title: 'Open time',
        type: 'buffer',
        startTime: toTime(cursor),
        endTime: toTime(blockStart),
        notes: 'Unscheduled gap — assign or absorb into adjacent block.',
      })
    }
    filled.push(block)
    cursor = toMinutes(block.endTime)
  }
  if (cursor < end - 5 && end - cursor <= MAX_GAP_TO_FILL) {
    filled.push({
      id: makeId(),
      title: 'Open time',
      type: 'buffer',
      startTime: toTime(cursor),
      endTime: toTime(end),
      notes: 'Remaining unscheduled time.',
    })
  }
  return filled
}

const dedupBlocks = (blocks: ScheduleBlock[]) =>
  blocks.reduce((acc, block) => {
    const lastBlock = acc[acc.length - 1]
    if (lastBlock && toMinutes(block.startTime) < toMinutes(lastBlock.endTime)) {
      const dur = toMinutes(block.endTime) - toMinutes(block.startTime)
      const start = toMinutes(lastBlock.endTime)
      return [...acc, { ...block, startTime: toTime(start), endTime: toTime(start + dur) }]
    }
    return [...acc, block]
  }, [] as ScheduleBlock[])

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
  if (params.apiKey === 'demo') {
    const isSummary = params.messages.some(m => m.content === SUMMARY_PROMPT || m.content.includes('coach'))
    if (isSummary) {
      return "Fantastic deep work session today! You remained extremely focused during the linear algebra problems and completed Anki cards efficiently. Tomorrow, try to maintain a continuous break duration of strictly 30 minutes to stay refreshed."
    }
    const isReplan = params.messages.some(m => m.content.includes('Replan') || m.content.includes('Remaining'))
    if (isReplan) {
      return JSON.stringify({
        blocks: [
          { title: 'Reply to professor email', type: 'shallow', startTime: '15:30', endTime: '15:45', notes: 'Urgent email reply.' },
          { title: 'Review flashcards', type: 'shallow', startTime: '15:45', endTime: '16:15', notes: 'Short review deck.' },
          { title: 'Gym break', type: 'break', startTime: '16:15', endTime: '17:15', notes: 'Leg day workout.' },
          { title: 'Prepare tomorrow seminar notes', type: 'buffer', startTime: '17:15', endTime: '17:45', notes: 'Write summaries.' }
        ]
      })
    }
    return JSON.stringify({
      blocks: [
        { title: 'Study linear algebra problem set', type: 'deep', startTime: '14:00', endTime: '15:30', notes: 'Work through set 3.' },
        { title: 'Reply to professor email', type: 'shallow', startTime: '15:30', endTime: '16:00', notes: 'Request extension.' },
        { title: 'Review flashcards', type: 'shallow', startTime: '16:00', endTime: '16:30', notes: 'Anki review.' },
        { title: 'Gym break', type: 'break', startTime: '16:30', endTime: '17:30', notes: 'Leg workout.' },
        { title: 'Prepare tomorrow seminar notes', type: 'buffer', startTime: '17:30', endTime: '18:00', notes: 'Write down summaries.' }
      ]
    })
  }

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
  completed?: ScheduleBlock[]
  currentTime?: string
  happened?: string
  leftToDo?: string
}) {
  const isReplan = Boolean(params.completed?.length || params.happened || params.leftToDo)
  const userContent = isReplan
    ? `Completed blocks: ${JSON.stringify(params.completed ?? [])}
Current time: ${params.currentTime}
What happened: ${params.happened}
What's left to do: ${params.leftToDo}
Return the same JSON shape, only for remaining time slots.`
    : `Task list: ${params.tasks}
Today's full day schedule. Current time: ${params.currentTime ?? nowTime()}.
Place tasks at sensible times starting from now or slightly before.
Return ONLY valid JSON.`

  const content = await callOpenAi({
    apiKey: params.apiKey,
    json: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  })

  return parseAiBlocks(content, '00:00', '23:59')
}

// Spring configs
export const spring = {
  snappy:  { type: 'spring', stiffness: 500, damping: 35 } as const,
  smooth:  { type: 'spring', stiffness: 300, damping: 30 } as const,
  floaty:  { type: 'spring', stiffness: 200, damping: 25 } as const,
  instant: { duration: 0.12, ease: 'easeOut' } as const,
}

export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit:    { opacity: 0 },
} as const

// Block accent colors
const blockAccentColors: Record<BlockType, string> = {
  deep: '#4f46e5',
  shallow: '#d97706',
  buffer: '#0284c7',
  break: '#16a34a',
}

// Block glow shadows
const glowShadows = {
  deep: 'inset 3px 0 0 #4f46e5, -2px 0 8px rgba(79,70,229,0.10)',
  shallow: 'inset 3px 0 0 #d97706, -2px 0 8px rgba(217,119,6,0.10)',
  break: 'inset 3px 0 0 #16a34a, -2px 0 8px rgba(22,163,74,0.10)',
  buffer: 'inset 3px 0 0 #0284c7, -2px 0 8px rgba(2,132,199,0.10)',
}

// Animated Score Counter
function AnimatedScore({ score }: { score: number }) {
  const scoreDisplay = useMotionValue(0)
  const roundedScore = useTransform(scoreDisplay, (v) => Math.round(v))
  const [currentScore, setCurrentScore] = useState(0)

  useEffect(() => {
    const controls = animate(scoreDisplay, score, { duration: 0.6, ease: 'easeOut' })
    return () => controls.stop()
  }, [score, scoreDisplay])

  useEffect(() => {
    return roundedScore.on('change', (latest) => {
      setCurrentScore(latest)
    })
  }, [roundedScore])

  return (
    <motion.span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {currentScore}
    </motion.span>
  )
}

type BlockCardProps = {
  block: ScheduleBlock
  index: number
  selected: boolean
  onClick: () => void
  onUpdateTimes: (id: string, start: string, end: string) => void
  onUpdateEndTime: (id: string, end: string) => void
  toggleDone: (id: string) => void
  timelineRef: React.RefObject<HTMLDivElement | null>
  visibleStart: number
  visibleEnd: number
  pixelsPerMinute: number
  newlyAddedBlockIdRef: React.RefObject<string | null>
}

// BlockCard Subcomponent
function BlockCard({
  block,
  selected,
  onClick,
  onUpdateTimes,
  onUpdateEndTime,
  toggleDone,
  timelineRef,
  visibleStart,
  visibleEnd,
  pixelsPerMinute,
  newlyAddedBlockIdRef,
}: BlockCardProps) {
  const y = useMotionValue(0)
  const accumulatedY = useRef(0)
  const dragMoved = useRef(false)
  const isNew = newlyAddedBlockIdRef.current === block.id

  const isOpenTime = block.title === 'Open time'
  const accentColor = block.crossedOut
    ? '#d4d4d8'
    : isOpenTime
      ? '#e4e4e7'
      : blockAccentColors[block.type]

  const top = (toMinutes(block.startTime) - visibleStart) * pixelsPerMinute
  const height = Math.max(28, durationMinutes(block) * pixelsPerMinute)

  const handleDragEnd = (_event: any, info: PanInfo) => {
    if (block.crossedOut) return
    const offsetY = info.offset.y
    const deltaMinutes = Math.round(offsetY / pixelsPerMinute / 15) * 15
    if (deltaMinutes !== 0) {
      const currentStartMin = toMinutes(block.startTime)
      const currentEndMin = toMinutes(block.endTime)
      const duration = currentEndMin - currentStartMin
      
      const newStartMin = Math.max(visibleStart, Math.min(visibleEnd - 15, currentStartMin + deltaMinutes))
      const newEndMin = Math.min(visibleEnd, newStartMin + duration)
      onUpdateTimes(block.id, toTime(newStartMin), toTime(newEndMin))
    }
    y.set(0)
    dragMoved.current = false
  }

  const handleResizeDrag = (_event: any, info: PanInfo) => {
    if (block.crossedOut) return
    accumulatedY.current += info.delta.y
    const step = 15 * pixelsPerMinute
    if (Math.abs(accumulatedY.current) >= step) {
      const dir = Math.sign(accumulatedY.current)
      const steps = Math.floor(Math.abs(accumulatedY.current) / step)
      accumulatedY.current -= dir * steps * step

      const currentEnd = toMinutes(block.endTime)
      const newEnd = Math.max(toMinutes(block.startTime) + 15, Math.min(visibleEnd, currentEnd + dir * steps * 15))
      onUpdateEndTime(block.id, toTime(newEnd))
    }
  }

  const handleResizeDragStart = () => {
    accumulatedY.current = 0
  }

  const shadow = selected
    ? `0 0 0 2px ${accentColor}40`
    : block.crossedOut
      ? 'none'
      : isOpenTime
        ? 'inset 1px 1px 0 rgba(255,255,255,0.8)'
        : glowShadows[block.type]

  return (
    <motion.article
      layout
      layoutId={`block-${block.id}`}
      initial={
        isNew
          ? { opacity: 0, scale: 0.85, y: -12 }
          : { opacity: 0, y: 16, scale: 0.97 }
      }
      animate={{
        opacity: block.crossedOut ? 0.28 : block.done ? 0.38 : isOpenTime ? 0.7 : 1,
        y: 0,
        scale: 1,
        boxShadow: shadow,
        filter: block.crossedOut ? 'grayscale(70%)' : block.done ? 'grayscale(50%)' : 'grayscale(0%)',
      }}
      exit={{ opacity: 0, scale: 0.95, y: -8 }}
      transition={isNew ? spring.floaty : spring.smooth}
      drag={block.crossedOut ? false : 'y'}
      dragConstraints={timelineRef}
      dragElastic={0}
      dragMomentum={false}
      onDragStart={() => {
        dragMoved.current = false
      }}
      onDrag={() => {
        dragMoved.current = true
      }}
      onDragEnd={handleDragEnd}
      onClick={() => {
        if (!dragMoved.current && !block.crossedOut) onClick()
      }}
      whileHover={block.crossedOut ? undefined : { y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.1)' }}
      whileTap={block.crossedOut ? undefined : { scale: 0.99 }}
      whileDrag={
        block.crossedOut
          ? undefined
          : {
              cursor: 'grabbing',
              boxShadow: '0 16px 40px rgba(0,0,0,0.15)',
              scale: 1.02,
              zIndex: 40,
            }
      }
      className={`block-card ${block.crossedOut ? 'block-crossed' : ''} ${
        block.done ? 'block-done' : ''
      } ${selected ? 'block-card-selected' : ''}`}
      style={{
        position: 'absolute',
        top,
        minHeight: height,
        left: 0,
        right: 0,
        y,
        zIndex: selected ? 12 : 8,
        pointerEvents: block.crossedOut ? 'none' : 'auto',
      }}
    >
      {/* Outer layer - accent glow stripe */}
      <div
        className="block-card-accent-stripe"
        style={{
          backgroundColor: accentColor,
          boxShadow: block.crossedOut ? 'none' : `2px 0 12px ${accentColor}40`,
        }}
      />

      {/* Inner surface */}
      <div className="block-card-inner">
        <div>
          {!isOpenTime && !block.crossedOut && (
            <AnimatePresence mode="wait">
              <motion.span
                key={block.type}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={spring.snappy}
                className="block-type-badge"
                style={{ color: accentColor }}
              >
                {typeLabels[block.type]}
              </motion.span>
            </AnimatePresence>
          )}

          {block.crossedOut && (
            <span
              style={{
                position: 'absolute',
                top: '12px',
                right: '12px',
                fontSize: '10px',
                color: '#a1a1aa',
                fontStyle: 'italic',
              }}
            >
              revised
            </span>
          )}

          <p
            className={`block-title-text ${
              block.done || block.crossedOut ? 'block-title-done' : ''
            }`}
            style={isOpenTime ? { color: '#a1a1aa', fontStyle: 'italic' } : undefined}
          >
            {block.title}
          </p>

          <p className="block-meta-text">
            {block.startTime} – {block.endTime} · {durationLabel(block)}
          </p>
        </div>

        {!block.crossedOut && !isOpenTime && (
          <Tooltip.Provider delayDuration={400}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    event.currentTarget.classList.add('animate-done-btn')
                    toggleDone(block.id)
                  }}
                  className="done-btn"
                >
                  <AnimatePresence mode="wait">
                    {block.done ? (
                      <motion.span
                        key="undo"
                        initial={{ opacity: 0, scale: 0.7, rotate: -10 }}
                        animate={{ opacity: 1, scale: 1, rotate: 0 }}
                        exit={{ opacity: 0, scale: 0.7 }}
                        transition={spring.snappy}
                        className="text-[#16a34a]"
                      >
                        ✓ undo
                      </motion.span>
                    ) : (
                      <span key="done">done</span>
                    )}
                  </AnimatePresence>
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" sideOffset={5}>
                  Mark as done (or press Space)
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        )}

        {!block.crossedOut && !isOpenTime && (
          <motion.div
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={0}
            dragMomentum={false}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onDragStart={handleResizeDragStart}
            onDrag={handleResizeDrag}
            initial={{ opacity: 0 }}
            whileHover={{ opacity: 1 }}
            className="resize-handle"
          >
            <span className="resize-pill" />
          </motion.div>
        )}
      </div>
    </motion.article>
  )
}

function App() {
  const envKey = import.meta.env.VITE_OPENAI_API_KEY as string | undefined
  const [apiKey, setApiKey] = useState(envKey ?? '')
  const [tasks, setTasks] = useState(sampleTasks)
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([])
  const [setupOpen, setSetupOpen] = useState(true)
  const [mode, setMode] = useState<Mode>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reflection, setReflection] = useState('')
  const [aiSummary, setAiSummary] = useState('')
  const [toasts, setToasts] = useState<{ id: string; msg: string; type: 'error' | 'success' }[]>([])
  const [retryAction, setRetryAction] = useState<RetryAction>(null)
  const [loading, setLoading] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [replanOpen, setReplanOpen] = useState(false)
  const [happened, setHappened] = useState('')
  const [leftToDo, setLeftToDo] = useState('')
  const [currentTime, setCurrentTime] = useState(nowTime)
  const [taskList, setTaskList] = useState<{ id: string; text: string; done: boolean }[]>([])
  const [taskPanelOpen, setTaskPanelOpen] = useState(true)

  const timelineRef = useRef<HTMLDivElement | null>(null)
  const nowLineRef = useRef<HTMLDivElement | null>(null)
  const selectedRef = useRef<string | null>(null)
  const prevBlockCountRef = useRef(0)
  const newlyAddedBlockIdRef = useRef<string | null>(null)

  const activeBlocks = useMemo(() => blocks.filter((block) => !block.crossedOut), [blocks])
  const completedCount = activeBlocks.filter((block) => block.done).length
  const score = activeBlocks.length ? Math.round((completedCount / activeBlocks.length) * 100) : 0
  const sessionEnd = 23 * 60 + 59
  const currentMinutes = toMinutes(currentTime)
  const windowStart = Math.max(0, currentMinutes - 90)
  const windowEnd = Math.min(1439, currentMinutes + 360)
  const blockStarts = blocks.filter((b) => !b.crossedOut).map((b) => toMinutes(b.startTime))
  const blockEnds = blocks.filter((b) => !b.crossedOut).map((b) => toMinutes(b.endTime))
  const earliestBlock = blockStarts.length ? Math.min(...blockStarts) : currentMinutes
  const latestBlock = blockEnds.length ? Math.max(...blockEnds) : currentMinutes + 120
  const visibleStart = blocks.length ? Math.min(windowStart, earliestBlock - 15) : windowStart
  const visibleEnd = blocks.length ? Math.max(windowEnd, latestBlock + 30) : windowEnd
  const visibleMinutes = visibleEnd - visibleStart
  const isNowInSession = currentMinutes >= visibleStart && currentMinutes <= visibleEnd
  const nowTop = (currentMinutes - visibleStart) * pixelsPerMinute
  if (blocks.length !== prevBlockCountRef.current) {
    prevBlockCountRef.current = blocks.length
  }
  const plannedMinutes = activeBlocks.reduce((total, block) => total + durationMinutes(block), 0)
  const completedMinutes = activeBlocks
    .filter((block) => block.done)
    .reduce((total, block) => total + durationMinutes(block), 0)
  const completionWidth = plannedMinutes ? Math.min(100, Math.round((completedMinutes / plannedMinutes) * 100)) : 0
  const reflectionUnlocked = completedCount > 0 || currentMinutes >= sessionEnd

  const showToast = (msg: string, type: 'error' | 'success' = 'success') => {
    const id = makeId()
    setToasts((t) => [...t, { id, msg, type }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }

  const setError = (msg: string) => {
    if (msg) {
      showToast(msg, 'error')
    }
  }

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
    setRetryAction(null)
  }

  const resetSchedule = () => {
    setBlocks([])
    setSelectedId(null)
    setAiSummary('')
    setReflection('')
    setReplanOpen(false)
    setHappened('')
    setLeftToDo('')
    setTaskList([])
    clearError()
  }

  const chooseMode = (nextMode: Exclude<Mode, null>) => {
    if (mode && mode !== nextMode && blocks.length > 0) {
      const confirmed = window.confirm('This will clear your current schedule. Continue?')
      if (!confirmed) return
    }

    if (mode === nextMode) {
      setSetupOpen(false)
      window.setTimeout(scrollNowIntoView, 0)
      return
    }

    if (mode !== nextMode && blocks.length > 0) {
      resetSchedule()
    }

    setMode(nextMode)

    if (nextMode === 'manual') {
      setSetupOpen(false)
      window.setTimeout(scrollNowIntoView, 0)
      return
    }

    void planSession()
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
      const currentTasks = tasks
      const cm = toMinutes(currentTime)
      const ws = Math.max(0, cm - 90)
      const we = Math.min(1439, cm + 360)
      const planned = await requestPlan({ apiKey, tasks, currentTime })
      const filled = dedupBlocks(fillGaps(planned, ws, we))
      setBlocks(filled)
      setSelectedId(filled[0]?.id ?? null)
      setTaskList(parseTasks(currentTasks))
      setSetupOpen(false)
      setMode('ai')
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
        completed: blocks.filter((block) => block.done),
        currentTime: current,
        happened,
        leftToDo,
      })

      const filledReplanned = fillGaps(replanned, nextCurrentMinutes, visibleEnd)

      setBlocks((existing) => [
        ...existing.map((block) =>
          !block.done && toMinutes(block.endTime) > nextCurrentMinutes ? { ...block, crossedOut: true } : block,
        ),
        ...filledReplanned,
      ])
      setSelectedId(filledReplanned[0]?.id ?? null)
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
    setBlocks((current) => {
      let isNowDone = false
      let blockTitle = ''
      const next = current.map((block) => {
        if (block.id === id) {
          isNowDone = !block.done
          blockTitle = block.title.toLowerCase()
          return { ...block, done: isNowDone }
        }
        return block
      })

      if (isNowDone && blockTitle) {
        setTaskList((prevTasks) =>
          prevTasks.map((task) => {
            const taskText = task.text.toLowerCase()
            if (taskText.includes(blockTitle) || blockTitle.includes(taskText)) {
              return { ...task, done: true }
            }
            return task
          })
        )
      }
      return next
    })
  }, [])

  const resizeBlock = (id: string, direction: 1 | -1) => {
    setBlocks((current) => {
      const updated = current.map((block) => {
        if (block.id !== id) return block
        const end = toMinutes(block.endTime) + direction * 15
        const minEnd = toMinutes(block.startTime) + 15
        return { ...block, endTime: toTime(Math.max(minEnd, Math.min(sessionEnd, end))) }
      })
      return fillGaps(updated, visibleStart, visibleEnd)
    })
  }

  const updateTitle = (id: string, title: string) => {
    setBlocks((current) => current.map((block) => (block.id === id ? { ...block, title } : block)))
  }

  const updateTime = (id: string, field: 'startTime' | 'endTime', value: string) => {
    setBlocks((current) => {
      const updated = current.map((block) => (block.id === id ? { ...block, [field]: value } : block))
      return fillGaps(updated, visibleStart, visibleEnd)
    })
  }

  const updateBlockTimes = (id: string, startTime: string, endTime: string) => {
    setBlocks((current) => {
      const updated = current.map((block) => (block.id === id ? { ...block, startTime, endTime } : block))
      return fillGaps(updated, visibleStart, visibleEnd)
    })
  }

  const updateBlockEndTime = (id: string, endTime: string) => {
    setBlocks((current) => {
      const updated = current.map((block) => (block.id === id ? { ...block, endTime } : block))
      return fillGaps(updated, visibleStart, visibleEnd)
    })
  }

  const updateType = (id: string, type: BlockType) => {
    setBlocks((current) => current.map((block) => (block.id === id ? { ...block, type } : block)))
  }

  const removeBlock = (id: string) => {
    setBlocks((current) => {
      const remaining = current.filter((block) => block.id !== id)
      return fillGaps(remaining, visibleStart, visibleEnd)
    })
    setSelectedId(null)
  }

  const addManualBlock = (type: BlockType, startTimeValue: string, durationMinutesValue: number) => {
    const start = toMinutes(startTimeValue)
    const duration = Math.max(15, durationMinutesValue)
    const end = Math.min(sessionEnd, start + duration)
    const block: ScheduleBlock = {
      id: makeId(),
      title: 'Untitled block',
      type,
      startTime: toTime(start),
      endTime: toTime(Math.max(start + 15, end)),
      notes: 'Manual block created on the timeline.',
    }
    newlyAddedBlockIdRef.current = block.id
    setBlocks((current) => fillGaps([...current, block], visibleStart, visibleEnd))
    setSelectedId(block.id)
  }

  const handleTimelineClick = (event: MouseEvent<HTMLDivElement>) => {
    if (mode !== 'manual' || event.target !== event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    const y = event.clientY - rect.top
    const clickedMinutes = Math.round(y / pixelsPerMinute) + visibleStart
    addManualBlock('deep', toTime(clickedMinutes), 60)
  }

  const exportSummary = () => {
    const lines = [
      'Deep Work Session',
      `Full day | ${score}% completed`,
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
    showToast('Plain text summary copied to clipboard.', 'success')
  }

  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(nowTime()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.code === 'Escape' && selectedRef.current) {
        setSelectedId(null)
        return
      }
      if (event.code !== 'Space' || !selectedRef.current || target?.matches('input, textarea, select, button')) return
      event.preventDefault()
      toggleDone(selectedRef.current)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleDone])

  const currentHour = Math.floor(currentMinutes / 60)
  const selectedBlock = blocks.find((block) => block.id === selectedId) ?? null
  const timeLabels: number[] = []
  const firstLabel = Math.floor(visibleStart / 60) * 60
  for (let minute = firstLabel; minute <= visibleEnd; minute += 60) {
    if (minute >= visibleStart) timeLabels.push(minute)
  }

  const pageVariants = {
    hidden: {},
    show: {
      transition: {
        staggerChildren: 0.08,
      },
    },
  }

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: spring.smooth },
  }

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640
  const panelVariants = {
    initial: isMobile
      ? { opacity: 0, y: '100%', x: 0, scale: 1 }
      : { opacity: 0, x: 24, scale: 0.97 },
    animate: { opacity: 1, x: 0, y: 0, scale: 1 },
    exit: isMobile
      ? { opacity: 0, y: '100%', x: 0, scale: 1 }
      : { opacity: 0, x: 24, scale: 0.97 },
  }

  const toggleTaskDone = (taskId: string) => {
    setTaskList((prev) =>
      prev.map((task) => (task.id === taskId ? { ...task, done: !task.done } : task))
    )
  }

  return (
    <motion.main
      variants={pageVariants}
      initial="hidden"
      animate="show"
      className="min-h-screen bg-[#f4f4f5] text-[#09090b]"
    >
      <div
        className="header-now-pill now-pill"
        style={{
          background: '#ef4444',
          color: 'white',
          fontSize: '11px',
          fontWeight: 700,
          padding: '3px 10px',
          borderRadius: '20px',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        <span className="now-dot" />
        NOW {currentTime}
      </div>

      <div className="relative mx-auto w-full max-w-[680px] overflow-visible px-6">
        <motion.div variants={itemVariants}>
          <header className="page-header">
            <h1 className="hero-title">Today.</h1>
            <p className="date-subtitle">{formatDate()}</p>
          </header>
        </motion.div>

        {/* Toast notifications container */}
        <div
          style={{
            position: 'fixed',
            bottom: '32px',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            zIndex: 100,
            pointerEvents: 'none',
          }}
        >
          <AnimatePresence>
            {toasts.map((toast) => (
              <motion.div
                key={toast.id}
                initial={{ opacity: 0, y: 16, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.95 }}
                transition={spring.snappy}
                className={`${
                  toast.type === 'error' ? 'bg-[#dc2626]' : 'bg-[#09090b]'
                } text-white rounded-xl py-3 px-5 text-sm font-medium shadow-lg pointer-events-auto whitespace-nowrap flex items-center gap-3`}
                role="alert"
                style={{
                  fontSize: '14px',
                  fontWeight: 500,
                  boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{toast.msg}</span>
                {toast.type === 'error' && retryAction && (
                  <button
                    type="button"
                    onClick={retry}
                    className="toast-retry"
                    style={{
                      background: 'rgba(255, 255, 255, 0.15)',
                      border: 'none',
                      color: '#ffffff',
                      borderRadius: '8px',
                      padding: '6px 12px',
                      fontSize: '13px',
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    Retry
                  </button>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <motion.div variants={itemVariants}>
          <section className={setupOpen ? 'setup-card' : ''}>
            {!setupOpen ? (
              <div className="setup-collapsed flex items-center justify-between gap-3">
                <p>
                  Today · {blocks.length} block{blocks.length === 1 ? '' : 's'}
                </p>
                <button type="button" onClick={() => setSetupOpen(true)} className="setup-edit-link">
                  edit
                </button>
              </div>
            ) : (
              <div>
                <label className="block">
                  <span className="section-label">Brain dump</span>
                  <textarea
                    value={tasks}
                    onChange={(event) => setTasks(event.target.value)}
                    className="input-underline textarea-underline mt-3"
                    placeholder="problem set ~90min, reading notes, email professor"
                    style={{ minHeight: 130, resize: 'none', lineHeight: 1.7 }}
                  />
                </label>

                <div className="mt-8">
                  <p className="section-label">Mode</p>
                  <div className="mode-cards" style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                    <motion.button
                      type="button"
                      onClick={() => chooseMode('ai')}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      transition={spring.snappy}
                      animate={{
                        backgroundColor: mode === 'ai' ? '#09090b' : '#fafafa',
                        borderColor: mode === 'ai' ? '#09090b' : '#e4e4e7',
                        color: mode === 'ai' ? '#ffffff' : '#09090b',
                      }}
                      className="mode-card"
                      style={{
                        flex: 1,
                        height: 80,
                        border: '1.5px solid #e4e4e7',
                        borderRadius: 14,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        gap: 4,
                      }}
                    >
                      <span className="mode-card-icon">✦</span>
                      <span className="mode-card-label">AI plan</span>
                      <span className="mode-card-sublabel">let claude schedule it</span>
                    </motion.button>
                    <motion.button
                      type="button"
                      onClick={() => chooseMode('manual')}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      transition={spring.snappy}
                      animate={{
                        backgroundColor: mode === 'manual' ? '#09090b' : '#fafafa',
                        borderColor: mode === 'manual' ? '#09090b' : '#e4e4e7',
                        color: mode === 'manual' ? '#ffffff' : '#09090b',
                      }}
                      className="mode-card"
                      style={{
                        flex: 1,
                        height: 80,
                        border: '1.5px solid #e4e4e7',
                        borderRadius: 14,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        gap: 4,
                      }}
                    >
                      <span className="mode-card-icon">✐</span>
                      <span className="mode-card-label">Manual</span>
                      <span className="mode-card-sublabel">i&apos;ll place blocks myself</span>
                    </motion.button>
                  </div>
                </div>

                <label className="mt-8 block">
                  <span className="section-label">OpenAI API key</span>
                  <div className="api-key-wrap">
                    <span className="api-key-prefix" aria-hidden="true">
                      🔒
                    </span>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      className="input-underline"
                      placeholder="sk-..."
                      style={{ border: 'none', borderBottom: '1.5px solid #e4e4e7', background: 'transparent' }}
                    />
                  </div>
                </label>

                {mode === 'ai' && (
                  <motion.button
                    type="button"
                    onClick={() => void planSession()}
                    disabled={loading}
                    whileHover={{ y: -1, backgroundColor: '#18181b' }}
                    whileTap={{ scale: 0.99, y: 0 }}
                    transition={spring.snappy}
                    className="plan-btn"
                    style={{
                      width: '100%',
                      height: 52,
                      borderRadius: 14,
                      background: '#09090b',
                      color: 'white',
                      fontSize: 15,
                      fontWeight: 700,
                      letterSpacing: '-0.2px',
                      border: 'none',
                      cursor: 'pointer',
                      marginTop: 20,
                    }}
                  >
                    {loading ? (
                      <>
                        <span className="spinner" />
                        Planning...
                      </>
                    ) : (
                      'Plan My Session'
                    )}
                  </motion.button>
                )}

                {mode === 'manual' && (
                  <motion.button
                    type="button"
                    onClick={() => void chooseMode('manual')}
                    whileHover={{ y: -1, backgroundColor: '#18181b' }}
                    whileTap={{ scale: 0.99, y: 0 }}
                    transition={spring.snappy}
                    className="plan-btn"
                    style={{
                      width: '100%',
                      height: 52,
                      borderRadius: 14,
                      background: '#09090b',
                      color: 'white',
                      fontSize: 15,
                      fontWeight: 700,
                      letterSpacing: '-0.2px',
                      border: 'none',
                      cursor: 'pointer',
                      marginTop: 20,
                    }}
                  >
                    Build it myself
                  </motion.button>
                )}
              </div>
            )}
          </section>
        </motion.div>

        {blocks.length > 0 && !setupOpen && (
          <div
            className="sticky-bar"
            style={{
              height: '56px',
              background: 'rgba(255, 255, 255, 0.92)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              borderBottom: '1px solid rgba(0,0,0,0.06)',
              position: 'sticky',
              top: 0,
              zIndex: 50,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div className="flex items-baseline">
              <span
                className="sticky-score"
                style={{
                  fontSize: '26px',
                  fontWeight: 800,
                  letterSpacing: '-1px',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >
                <AnimatedScore score={score} />
              </span>
              <span className="sticky-score-meta" style={{ fontSize: '13px', color: '#a1a1aa', marginLeft: '2px' }}>
                % · {completedCount}/{activeBlocks.length} done
              </span>
            </div>
            <Tooltip.Provider delayDuration={400}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <motion.button
                    type="button"
                    onClick={() => setReplanOpen((open) => !open)}
                    disabled={!blocks.length || loading}
                    whileHover={{ borderColor: '#ef4444', color: '#ef4444', backgroundColor: '#fff1f2' }}
                    whileTap={{ scale: 0.97 }}
                    className="came-up-btn"
                    style={{
                      height: '32px',
                      padding: '0 14px',
                      borderRadius: '8px',
                      border: '1px solid #e4e4e7',
                      background: 'white',
                      fontSize: '13px',
                      fontWeight: 500,
                      color: '#71717a',
                      cursor: 'pointer',
                    }}
                  >
                    Something came up
                  </motion.button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content className="tooltip-content" sideOffset={5}>
                    Replan the rest of your day with AI
                    <Tooltip.Arrow className="tooltip-arrow" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          </div>
        )}

        {/* Replan Accordion panel */}
        <AnimatePresence>
          {replanOpen && (
            <motion.section
              key="replan"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
              style={{ overflow: 'hidden', marginBottom: '16px' }}
            >
              <div
                style={{
                  background: 'white',
                  border: '1px solid #e4e4e7',
                  borderRadius: '16px',
                  padding: '20px',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
                }}
              >
                <p className="section-label">Replan remaining session</p>
                <label className="mt-4 block">
                  <span className="text-sm text-[#52525b]">What happened?</span>
                  <textarea
                    value={happened}
                    onChange={(event) => setHappened(event.target.value)}
                    className="input-underline textarea-underline mt-2"
                    style={{ minHeight: 80, border: 'none', borderBottom: '1.5px solid #e4e4e7', background: 'transparent' }}
                  />
                </label>
                <label className="mt-4 block">
                  <span className="text-sm text-[#52525b]">What&apos;s left to do?</span>
                  <textarea
                    value={leftToDo}
                    onChange={(event) => setLeftToDo(event.target.value)}
                    className="input-underline textarea-underline mt-2"
                    style={{ minHeight: 80, border: 'none', borderBottom: '1.5px solid #e4e4e7', background: 'transparent' }}
                  />
                </label>
                <motion.button
                  type="button"
                  onClick={replanRemaining}
                  disabled={loading}
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.99 }}
                  className="btn-primary mt-4"
                  style={{
                    width: '100%',
                    height: 52,
                    background: '#09090b',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: 14,
                    fontSize: 15,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {loading ? (
                    <>
                      <span className="spinner" />
                      Replanning...
                    </>
                  ) : (
                    'Replan remaining day'
                  )}
                </motion.button>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {mode === 'manual' && !setupOpen && (
          <div className="manual-toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 0 14px' }}>
            {(['deep', 'shallow', 'break', 'buffer'] as BlockType[]).map((type) => {
              const accent = blockAccentColors[type]
              return (
                <motion.button
                  key={type}
                  type="button"
                  onClick={() => addManualBlock(type, currentTime, type === 'break' || type === 'buffer' ? 30 : 60)}
                  whileHover={{ scale: 1.04, y: -1, backgroundColor: accent, color: '#ffffff' }}
                  whileTap={{ scale: 0.95 }}
                  transition={spring.snappy}
                  className="toolbar-btn"
                  style={{
                    height: 30,
                    padding: '0 14px',
                    borderRadius: '20px',
                    fontSize: '12px',
                    fontWeight: 600,
                    border: `1.5px solid ${accent}`,
                    color: accent,
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  + {typeLabels[type]}
                </motion.button>
              )
            })}
          </div>
        )}

        {selectedId && <div className="panel-backdrop" onClick={() => setSelectedId(null)} aria-hidden="true" />}

        <section ref={timelineRef} className="timeline-wrapper">
          <div
            className="timeline-container"
            style={{
              backgroundImage: 'radial-gradient(circle, #e4e4e7 1px, transparent 1px)',
              backgroundSize: `20px ${pixelsPerMinute * 60}px`,
              backgroundPosition: `0 ${(-visibleStart % 60) * pixelsPerMinute}px`,
              opacity: 0.5,
            }}
          />
          {/* Timeline render logic */}
          <div className="timeline-container" style={{ position: 'relative' }}>
            <div
              className="relative grid grid-cols-[52px_minmax(0,1fr)]"
              style={{ minHeight: visibleMinutes * pixelsPerMinute }}
            >
              <div className="relative text-right" style={{ minWidth: '52px' }}>
                {timeLabels.map((minute) => {
                  const isCurrentHour = Math.floor(minute / 60) === currentHour
                  return (
                    <div
                      key={minute}
                      className={`time-label absolute right-0 ${isCurrentHour ? 'time-label-current' : ''}`}
                      style={{
                        top: (minute - visibleStart) * pixelsPerMinute - 6,
                        color: isCurrentHour ? '#ef4444' : '#71717a',
                        fontWeight: isCurrentHour ? 600 : 400,
                        fontFamily: "'JetBrains Mono', 'Courier New', monospace",
                      }}
                    >
                      {toTime(minute)}
                    </div>
                  )
                })}
              </div>

              <div
                className={`relative ${mode === 'manual' ? 'cursor-crosshair' : ''}`}
                onClick={handleTimelineClick}
              >
                {isNowInSession && (
                  <div
                    ref={nowLineRef}
                    className="absolute left-0 right-0 z-20 pointer-events-none"
                    style={{ top: nowTop, scrollMarginTop: '80px' }}
                  >
                    <div className="now-line-row">
                      <div className="now-dot shrink-0" />
                      <span
                        className="now-pill shrink-0"
                        style={{
                          background: '#ef4444',
                          color: 'white',
                          fontSize: '10px',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: '20px',
                          letterSpacing: '0.05em',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontVariantNumeric: 'tabular-nums',
                          display: 'inline-block',
                        }}
                      >
                        NOW {currentTime}
                      </span>
                      <motion.div
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: 1 }}
                        className="now-line"
                        style={{
                          height: '1.5px',
                          flex: 1,
                          background: 'linear-gradient(90deg, #ef4444, transparent)',
                          transformOrigin: 'left',
                        }}
                      />
                    </div>
                  </div>
                )}

                {!blocks.length ? (
                  <div className="empty-timeline">
                    {loading
                      ? 'Planning your session...'
                      : mode === 'manual'
                        ? 'Click empty space or use the toolbar to add blocks.'
                        : 'Choose a mode to begin the full-day timeline.'}
                  </div>
                ) : (
                  blocks.map((block, index) => (
                    <BlockCard
                      key={block.id}
                      block={block}
                      index={index}
                      selected={selectedId === block.id}
                      onClick={() => setSelectedId(selectedId === block.id ? null : block.id)}
                      onUpdateTimes={updateBlockTimes}
                      onUpdateEndTime={updateBlockEndTime}
                      toggleDone={toggleDone}
                      timelineRef={timelineRef}
                      visibleStart={visibleStart}
                      visibleEnd={visibleEnd}
                      pixelsPerMinute={pixelsPerMinute}
                      newlyAddedBlockIdRef={newlyAddedBlockIdRef}
                    />
                  ))
                )}

                <AnimatePresence>
                  {selectedBlock && (
                    <motion.aside
                      key={selectedBlock.id}
                      variants={panelVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      transition={spring.smooth}
                      className="detail-panel open"
                      data-testid="detail-panel"
                      style={{
                        top: Math.min(
                          window.innerHeight - 420,
                          Math.max(96, 160 + (toMinutes(selectedBlock.startTime) - visibleStart) * pixelsPerMinute),
                        ),
                      }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span className={`block-type-badge ${typeLabelClass[selectedBlock.type]}`}>
                        {typeLabels[selectedBlock.type]}
                      </span>

                      <input
                        type="text"
                        defaultValue={selectedBlock.title}
                        onBlur={(event) => updateTitle(selectedBlock.id, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur()
                          }
                        }}
                        className="detail-panel-title"
                        style={{
                          fontSize: '16px',
                          fontWeight: 700,
                          letterSpacing: '-0.3px',
                          color: '#09090b',
                          marginTop: 8,
                          border: 'none',
                          borderBottom: '1.5px solid #e4e4e7',
                          background: 'transparent',
                          width: '100%',
                          outline: 'none',
                        }}
                      />

                      <div className="detail-type-pills">
                        {(['deep', 'shallow', 'break', 'buffer'] as BlockType[]).map((type) => {
                          const isSelected = selectedBlock.type === type
                          const typeAccent = blockAccentColors[type]
                          return (
                            <motion.button
                              key={type}
                              type="button"
                              onClick={() => updateType(selectedBlock.id, type)}
                              whileTap={{ scale: 0.95 }}
                              animate={{
                                backgroundColor: isSelected ? typeAccent : 'transparent',
                                color: isSelected ? '#ffffff' : '#71717a',
                                borderColor: isSelected ? typeAccent : '#e4e4e7',
                              }}
                              transition={{ duration: 0.15 }}
                              className="type-pill"
                              style={{
                                borderWidth: '1.5px',
                                borderStyle: 'solid',
                              }}
                            >
                              {typeLabels[type]}
                            </motion.button>
                          )
                        })}
                      </div>

                      <div className="detail-time-row">
                        <input
                          type="time"
                          value={selectedBlock.startTime}
                          onChange={(event) => updateTime(selectedBlock.id, 'startTime', event.target.value)}
                          aria-label="Start time"
                        />
                        <span className="text-[#a1a1aa]">–</span>
                        <input
                          type="time"
                          value={selectedBlock.endTime}
                          onChange={(event) => updateTime(selectedBlock.id, 'endTime', event.target.value)}
                          aria-label="End time"
                        />
                      </div>

                      <div className="detail-resize-row">
                        <button
                          type="button"
                          onClick={() => resizeBlock(selectedBlock.id, -1)}
                          className="resize-action-btn"
                        >
                          −15m
                        </button>
                        <button
                          type="button"
                          onClick={() => resizeBlock(selectedBlock.id, 1)}
                          className="resize-action-btn"
                        >
                          +15m
                        </button>
                      </div>

                      <p className="detail-notes">{selectedBlock.notes}</p>

                      <motion.button
                        type="button"
                        onClick={() => removeBlock(selectedBlock.id)}
                        whileHover={{ color: '#dc2626' }}
                        className="remove-block-btn"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#a1a1aa',
                          marginTop: '16px',
                          cursor: 'pointer',
                        }}
                      >
                        <span aria-hidden="true" style={{ marginRight: '6px' }}>🗑</span>
                        remove block
                      </motion.button>
                    </motion.aside>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </section>

        {reflectionUnlocked ? (
          <section className="reflection-section">
            <h2 className="reflection-heading">How did it go?</h2>

            <div className="mt-6">
              <div className="flex items-baseline gap-1">
                <span className="reflection-score" style={{ fontSize: '56px', fontWeight: 800, letterSpacing: '-2px', fontFamily: 'JetBrains Mono, monospace' }}>
                  <AnimatedScore score={score} />
                </span>
                <span className="reflection-score-suffix">%</span>
              </div>
              <p className="reflection-score-caption">of blocks completed</p>
              <div className="completion-bar">
                <motion.div
                  className="completion-fill"
                  initial={{ width: 0 }}
                  animate={{ width: `${completionWidth}%` }}
                  transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
                />
              </div>
            </div>

            <div>
              {activeBlocks.map((block) => {
                const status = block.done
                  ? { label: '✓ done', className: 'status-done' }
                  : currentMinutes >= toMinutes(block.startTime) && currentMinutes < toMinutes(block.endTime)
                    ? { label: '→ now', className: 'status-progress' }
                    : currentMinutes > toMinutes(block.endTime)
                      ? { label: '✗ skipped', className: 'status-skipped' }
                      : { label: '· later', className: 'status-planned' }

                return (
                  <div key={block.id} className="status-row">
                    <span className="time-label tabular-nums" style={{ color: '#71717a', fontFamily: "'JetBrains Mono', 'Courier New', monospace" }}>{block.startTime}</span>
                    <span className="text-sm text-[#09090b] flex-1">{block.title}</span>
                    <span className={`status-badge ${status.className}`}>{status.label}</span>
                  </div>
                )
              })}
            </div>

            <label className="mt-10 block">
              <span className="section-label">Reflection</span>
              <textarea
                value={reflection}
                onChange={(event) => setReflection(event.target.value)}
                className="input-underline textarea-underline mt-3"
                placeholder="what worked, what didn't, what tomorrow needs..."
                style={{ minHeight: 80, border: 'none', borderBottom: '1.5px solid #e4e4e7', background: 'transparent' }}
              />
            </label>

            <motion.button
              type="button"
              onClick={summarizeDay}
              disabled={summaryLoading || !reflection.trim()}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.99 }}
              className="btn-primary mt-6"
              style={{
                width: '100%',
                height: 52,
                borderRadius: 14,
                background: '#09090b',
                color: 'white',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {summaryLoading ? (
                <>
                  <span className="spinner" />
                  Reading your day...
                </>
              ) : (
                'Summarize my day'
              )}
            </motion.button>

            <AnimatePresence>
              {aiSummary && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5 }}
                  className="ai-summary-text"
                  style={{ fontSize: '17px', lineHeight: '1.8', color: '#09090b', padding: '20px 0' }}
                >
                  {aiSummary}
                </motion.div>
              )}
            </AnimatePresence>

            <motion.button
              type="button"
              onClick={exportSummary}
              whileHover={{ color: '#09090b' }}
              className="export-link mt-4"
              style={{
                background: 'none',
                border: 'none',
                color: '#a1a1aa',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              Export as plain text →
            </motion.button>
          </section>
        ) : (
          <p className="reflection-locked">Reflection unlocks at end of session.</p>
        )}
      </div>

      {/* Floating Task List Panel */}
      {taskList.length > 0 &&
        createPortal(
        <div className="task-list-panel">
          {!taskPanelOpen ? (
            <motion.button
              type="button"
              onClick={() => setTaskPanelOpen(true)}
              whileHover={{ scale: 1.03, y: -1 }}
              whileTap={{ scale: 0.97 }}
              transition={spring.snappy}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold shadow-sm border cursor-pointer transition-colors ${
                taskList.every((t) => t.done)
                  ? 'bg-[#f0fdf4] border-[#bbf7d0] text-[#16a34a]'
                  : 'bg-white border-[#e4e4e7] text-[#09090b]'
              }`}
            >
              <span>✓</span>
              <span>
                {taskList.every((t) => t.done)
                  ? 'All done ✓'
                  : `Tasks · ${taskList.filter((t) => !t.done).length} left`}
              </span>
            </motion.button>
          ) : (
            <AnimatePresence>
              <motion.div
                initial={{ opacity: 0, y: -8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.97 }}
                transition={spring.smooth}
                className="border rounded-2xl p-4 w-[260px] shadow-lg flex flex-col"
                style={{
                  background: 'rgba(255,255,255,0.96)',
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  borderColor: '#e4e4e7',
                }}
              >
                <div className="flex justify-between items-center mb-3">
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: '#a1a1aa',
                    }}
                  >
                    Today's tasks
                  </span>
                  <button
                    type="button"
                    onClick={() => setTaskPanelOpen(false)}
                    className="cursor-pointer border-none bg-none hover:text-[#09090b]"
                    style={{ fontSize: '14px', color: '#d4d4d8', padding: 0 }}
                  >
                    —
                  </button>
                </div>

                <div
                  className="no-scrollbar flex flex-col gap-0.5 overflow-y-auto"
                  style={{ maxHeight: '320px', scrollbarWidth: 'none' }}
                >
                  {taskList.length === 0 ? (
                    <p className="text-center text-xs text-[#a1a1aa] py-4">
                      Add tasks in setup to see them here
                    </p>
                  ) : (
                    taskList.map((task) => (
                      <motion.div
                        layout
                        key={task.id}
                        onClick={() => toggleTaskDone(task.id)}
                        whileHover={{ backgroundColor: 'rgba(0,0,0,0.02)' }}
                        whileTap={{ scale: 0.99 }}
                        className="flex items-start gap-2.5 p-2 py-1.5 rounded-lg cursor-pointer"
                      >
                        <motion.div
                          animate={{
                            backgroundColor: task.done ? '#4f46e5' : 'transparent',
                            borderColor: task.done ? '#4f46e5' : '#d4d4d8',
                          }}
                          style={{
                            width: '16px',
                            height: '16px',
                            flexShrink: 0,
                            marginTop: '1px',
                            borderRadius: '4px',
                            borderWidth: '1.5px',
                            borderStyle: 'solid',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {task.done && (
                            <span style={{ fontSize: '10px', color: 'white', fontWeight: 'bold' }}>✓</span>
                          )}
                        </motion.div>
                        <span
                          className="text-xs flex-1"
                          style={{
                            lineHeight: '1.4',
                            color: task.done ? '#a1a1aa' : '#09090b',
                            textDecoration: task.done ? 'line-through' : 'none',
                            transition: 'color 200ms ease, text-decoration 200ms ease',
                          }}
                        >
                          {task.text}
                        </span>
                      </motion.div>
                    ))
                  )}
                </div>

                <div
                  className="mt-3 flex justify-between items-center"
                  style={{ borderTop: '1px solid #f4f4f5', paddingTop: '10px' }}
                >
                  <span style={{ fontSize: '11px', color: '#a1a1aa' }}>
                    {taskList.filter((t) => t.done).length}/{taskList.length} done
                  </span>
                  <div
                    style={{
                      width: '80px',
                      height: '3px',
                      background: '#f4f4f5',
                      borderRadius: '2px',
                      overflow: 'hidden',
                    }}
                  >
                    <motion.div
                      animate={{
                        width: taskList.length ? `${(taskList.filter((t) => t.done).length / taskList.length) * 100}%` : '0%',
                      }}
                      transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
                      style={{
                        height: '100%',
                        background: '#4f46e5',
                      }}
                    />
                  </div>
                </div>
              </motion.div>
            </AnimatePresence>
          )}
        </div>,
        document.body,
      )}
    </motion.main>
  )
}

export default App
