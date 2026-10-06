import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { cells, usageColor, usageNumberColor } from './register'

const USAGE = {
  startedAt: 0,
  context: {
    tokens: 60_000,
    window: 200_000,
    percent: 30,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 20_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'Messages', tokens: 40_000, color: 'permission', isDeferred: false, kind: 'used' },
        { name: 'MCP tools (deferred)', tokens: 9_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
        { name: 'Free space', tokens: 117_000, color: 'inactive', isDeferred: false, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 23_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
      ],
      totalTokens: 60_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 30,
    },
  },
  rateLimits: [{ kind: 'five_hour', percentUsed: 42.5 }],
  cost: { usd: 1.23 },
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 }

describe('cells', () => {
  test('fills the bar exactly', () => {
    const segs = USAGE.context.breakdown.categories.filter(c => c.kind !== 'deferred') as never
    expect(cells(segs, 200_000, 50).reduce((a, b) => a + b, 0)).toBe(50)
  })
  test('a tiny used category still gets one cell', () => {
    const segs = [
      { name: 'a', color: 'x', tokens: 10, kind: 'used' },
      { name: 'free', color: 'y', tokens: 199_990, kind: 'free' },
    ] as never
    expect(cells(segs, 200_000, 20)).toEqual([1, 19])
  })
})

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]

describe('usageColor', () => {
  test('is green when unused and red when full', () => {
    const [r0, g0] = rgb(usageColor(0))
    const [r100, g100, b100] = rgb(usageColor(100))
    expect(g0).toBeGreaterThan(r0)
    expect(r100).toBeGreaterThan(g100 * 3)
    expect(r100).toBeGreaterThan(b100 * 3)
  })
  test('grows redder with every step of usage', () => {
    const redness = (pct: number) => {
      const [r, g] = rgb(usageColor(pct))
      return r - g
    }
    for (let pct = 0; pct < 100; pct += 10) expect(redness(pct + 10)).toBeGreaterThan(redness(pct))
  })
  test('faded keeps the hue but is less vivid', () => {
    const vividness = (hex: string) => Math.max(...rgb(hex)) - Math.min(...rgb(hex))
    for (const pct of [0, 50, 100]) {
      expect(vividness(usageColor(pct, true))).toBeLessThan(vividness(usageColor(pct)))
      expect(vividness(usageColor(pct, true))).toBeGreaterThan(0)
    }
    const [r0, g0] = rgb(usageColor(0, true))
    const [r100, g100] = rgb(usageColor(100, true))
    expect(g0).toBeGreaterThan(r0)
    expect(r100).toBeGreaterThan(g100)
  })
  test('stays red past 100% and green below 0%', () => {
    expect(usageColor(140)).toBe(usageColor(100))
    expect(usageColor(-5)).toBe(usageColor(0))
  })
})

describe('usageNumberColor', () => {
  test('stays unset below 50%, as it shows', () => {
    expect(usageNumberColor(0)).toBeUndefined()
    expect(usageNumberColor(49.4)).toBeUndefined()
  })
  test('is yellow from 50%, orange from 75%, red from 90%, by the shown number', () => {
    expect(usageNumberColor(49.5)).toBe(usageColor(50))
    expect(usageNumberColor(74)).toBe(usageColor(50))
    expect(usageNumberColor(75)).toBe(usageColor(75))
    expect(usageNumberColor(89)).toBe(usageColor(75))
    expect(usageNumberColor(90)).toBe(usageColor(100))
    expect(usageNumberColor(130)).toBe(usageColor(100))
  })
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws context and limits, /usage-bar hides it (${surface})`, async ($, on) => {
    fakeStore(on)
    on('session.usage', () => ({ value: USAGE }) as never)
    engineBand(on)
    await $.command.run({ command: 'usage-bar' } as never) // hide
    await $.command.run({ command: 'usage-bar' } as never) // show, measures
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: BAND as never })
    const text = JSON.stringify(await ui.drawn())
    expect(text).toContain('Context')
    expect(text).toContain('Messages 40k')
    expect(text).not.toContain('deferred')
    expect(text).toContain('30% 60k/200k')
    expect(text).toContain('43%')

    await $.command.run({ command: 'usage-bar' } as never)
    expect(JSON.stringify(await ui.drawn())).not.toContain('Context')
  })
}

const fakeGit = (on: On, answers: Record<string, { exitCode: number; stdout: string }>) =>
  on('process.run', (_$, e) => {
    const a = answers[e.argv.join(' ')] ?? { exitCode: 128, stdout: '' }
    return { value: { ...a, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })

const drawnAfterMeasure = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  await $.command.run({ command: 'usage-bar' } as never) // hide
  await $.command.run({ command: 'usage-bar' } as never) // show, measures
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
  return JSON.stringify(await ui.drawn())
}

test('shows the current git branch', async ($, on) => {
  fakeStore(on)
  on('session.usage', () => ({ value: USAGE }) as never)
  fakeGit(on, { 'git branch --show-current': { exitCode: 0, stdout: 'feature/301-thing\n' } })
  engineBand(on)
  const text = await drawnAfterMeasure($)
  expect(text).toContain('Branch')
  expect(text).toContain('feature/301-thing')
})

test('a detached HEAD shows its short sha', async ($, on) => {
  fakeStore(on)
  on('session.usage', () => ({ value: USAGE }) as never)
  fakeGit(on, {
    'git branch --show-current': { exitCode: 0, stdout: '\n' },
    'git rev-parse --short HEAD': { exitCode: 0, stdout: 'df04d8e\n' },
  })
  engineBand(on)
  expect(await drawnAfterMeasure($)).toContain('detached df04d8e')
})

test('outside a git repository there is no branch row', async ($, on) => {
  fakeStore(on)
  on('session.usage', () => ({ value: USAGE }) as never)
  fakeGit(on, {})
  engineBand(on)
  const text = await drawnAfterMeasure($)
  expect(text).toContain('Context')
  expect(text).not.toContain('Branch')
})

const fakeStore = (on: On, entries: Record<string, unknown> = {}) => {
  const map = new Map(Object.entries(entries))
  on('store.get', (_$, e) => ({ value: map.get(e.key) }) as never)
  on('store.set', (_$, e) => (map.set(e.key, e.value), { value: undefined }) as never)
  return map
}

const engineBand = (on: On) =>
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

type Node = { type?: string; children?: (Node | string)[] }
/** The drawing's text as the terminal shows it, pieces joined in order. */
const plain = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(plain).join(''))
/** Each Box row's bar: its children that are only bar glyphs, joined. */
const bars = (node: Node): string[] => {
  const out: string[] = []
  const walk = (n: Node) => {
    if (n.type === 'Box') {
      const bar = (n.children ?? [])
        .map(c => (typeof c === 'object' && c.type === 'Text' ? (c.children ?? []).join('') : ''))
        .filter(t => /^[█░▒]+$/.test(t))
        .join('')
      if (bar !== '') out.push(bar)
    }
    for (const c of n.children ?? []) if (typeof c === 'object') walk(c)
  }
  walk(node)
  return out
}

/** Registers the fakes, then draws the bar rows for any figures and width: each row's bar and whole text. */
const barRows = (on: On) => {
  let usage: unknown = USAGE
  fakeStore(on)
  on('session.usage', () => ({ value: usage }) as never)
  engineBand(on)
  return async ($: Parameters<Parameters<typeof test>[1]>[0], figures: unknown, bodyColumns: number) => {
    usage = figures
    await $.command.run({ command: 'usage-bar' } as never) // hide
    await $.command.run({ command: 'usage-bar' } as never) // show, measures
    const ui = await $.ui.mount({
      plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns } as never,
    })
    const text = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(text).join(''))
    const rows: { bar: string; row: string }[] = []
    const walk = (n: Node) => {
      if (n.type === 'Box') {
        const parts = (n.children ?? []).map(text)
        const bar = parts.filter(t => /^[█░▒]+$/.test(t)).join('')
        if (bar !== '') rows.push({ bar, row: parts.join('') })
      }
      for (const c of n.children ?? []) if (typeof c === 'object') walk(c)
    }
    walk((await ui.drawn()) as Node)
    return rows
  }
}

const withFigures = (percent: number, tokens: number, limits: unknown[]) => ({
  ...USAGE,
  context: { ...USAGE.context, breakdown: { ...USAGE.context.breakdown, percentage: percent, totalTokens: tokens } },
  rateLimits: limits,
})
const SHORT = withFigures(9, 9_000, [{ kind: 'five_hour', percentUsed: 3 }, { kind: 'seven_day', percentUsed: 7 }])
const LONG = withFigures(100, 1_000_000, [
  { kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-06T14:00:00Z' },
  { kind: 'seven_day', percentUsed: 100, resetsAt: '2026-10-09T08:00:00Z' },
])

test('the context and limit bars are the same width', async ($, on) => {
  const rows = await barRows(on)($, withFigures(30, 60_000, [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-10-06T14:00:00Z' }, { kind: 'seven_day', percentUsed: 7 }]), 100)
  expect(rows.length).toBe(3)
  expect(new Set(rows.map(r => r.bar.length)).size).toBe(1)
})

test('the bars keep their width when the figures after them grow or shrink', async ($, on) => {
  const draw = barRows(on)
  const short = await draw($, SHORT, 100)
  const long = await draw($, LONG, 100)
  expect(long.map(r => r.bar.length)).toEqual(short.map(r => r.bar.length))
})

test('the bars follow the terminal width', async ($, on) => {
  const draw = barRows(on)
  const wide = await draw($, SHORT, 120)
  const narrow = await draw($, SHORT, 60)
  expect((wide[0]?.bar.length ?? 0) - (narrow[0]?.bar.length ?? 0)).toBe(60)
})

for (const columns of [100, 30]) {
  test(`the longest figures still fit in ${columns} columns`, async ($, on) => {
    for (const { row } of await barRows(on)($, LONG, columns)) expect(row.length).toBeLessThanOrEqual(columns)
  })
}

test('the 7d fill is faded, never greyed by dimColor, the 5h fill is vivid', async ($, on) => {
  fakeStore(on)
  on('session.usage', () => ({
    value: { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 90 }, { kind: 'seven_day', percentUsed: 20 }] },
  }) as never)
  engineBand(on)
  await $.command.run({ command: 'usage-bar' } as never) // hide
  await $.command.run({ command: 'usage-bar' } as never) // show, measures
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
  const fills: { color?: string; dimColor?: boolean }[] = []
  const walk = (n: Node & { props?: { color?: string; dimColor?: boolean } }) => {
    const only = n.children?.length === 1 && typeof n.children[0] === 'string' ? n.children[0] : ''
    if (n.type === 'Text' && /^█+$/.test(only) && n.props?.color?.startsWith('#')) fills.push(n.props)
    for (const c of n.children ?? []) if (typeof c === 'object') walk(c)
  }
  walk((await ui.drawn()) as Node)
  expect(fills).toEqual([
    { color: usageColor(90) },
    { color: usageColor(20, true) },
  ])
})

test('a reset shows its local day and time, without the UTC Z', async ($, on) => {
  const resetsAt = '2026-10-08T22:05:00Z'
  const at = new Date(resetsAt)
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(at)
  const local = `${day} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  fakeStore(on)
  on('session.usage', () => ({ value: { ...USAGE, rateLimits: [{ kind: 'seven_day', percentUsed: 42.5, resetsAt }] } }) as never)
  engineBand(on)
  await $.command.run({ command: 'usage-bar' } as never) // hide
  await $.command.run({ command: 'usage-bar' } as never) // show, measures
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
  const text = plain((await ui.drawn()) as Node)
  expect(text).toContain(`43% resets ${local}`)
  expect(text).not.toContain(`${local}Z`)
})

test('the 5h reset shows its local time without the day', async ($, on) => {
  const resetsAt = '2026-10-08T22:05:00Z'
  const at = new Date(resetsAt)
  const local = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  fakeStore(on)
  on('session.usage', () => ({ value: { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt }] } }) as never)
  engineBand(on)
  await $.command.run({ command: 'usage-bar' } as never) // hide
  await $.command.run({ command: 'usage-bar' } as never) // show, measures
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
  const text = plain((await ui.drawn()) as Node)
  expect(text).toContain(`43% resets ${local}`)
  expect(text).not.toContain(`resets ${new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(at)}`)
})

test('an unreadable reset time is left out rather than drawn as NaN', async ($, on) => {
  fakeStore(on)
  on('session.usage', () => ({ value: { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: 'soon' }] } }) as never)
  engineBand(on)
  await $.command.run({ command: 'usage-bar' } as never) // hide
  await $.command.run({ command: 'usage-bar' } as never) // show, measures
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
  const text = JSON.stringify(await ui.drawn())
  expect(text).toContain('43%')
  expect(text).not.toContain('resets')
})

test('a limit number past 50% stands out in its colour, the reset time stays dim', async ($, on) => {
  fakeStore(on)
  on('session.usage', () => ({
    value: { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 91, resetsAt: '2026-10-06T14:05:00Z' }, { kind: 'seven_day', percentUsed: 20 }] },
  }) as never)
  engineBand(on)
  await $.command.run({ command: 'usage-bar' } as never) // hide
  await $.command.run({ command: 'usage-bar' } as never) // show, measures
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
  const texts: { text: string; props?: object }[] = []
  const walk = (n: Node & { props?: object }) => {
    const only = n.children?.length === 1 && typeof n.children[0] === 'string' ? n.children[0] : undefined
    if (n.type === 'Text' && only !== undefined) texts.push({ text: only, props: n.props })
    for (const c of n.children ?? []) if (typeof c === 'object') walk(c)
  }
  walk((await ui.drawn()) as Node)
  expect(texts.find(t => t.text.trim() === '91%')?.props).toEqual({ color: usageColor(100) })
  expect(texts.find(t => t.text.trim() === '20%')?.props).toEqual({ dimColor: true })
  expect(texts.find(t => t.text.includes('resets'))?.props).toEqual({ dimColor: true, wrap: 'truncate-end' })
})

const atContext = (totalTokens: number) => ({
  ...USAGE,
  context: {
    ...USAGE.context,
    window: 1_000_000,
    breakdown: { ...USAGE.context.breakdown, totalTokens, rawMaxTokens: 1_000_000, percentage: Math.round(totalTokens / 10_000) },
  },
})

const contextDrawing = async ($: Parameters<Parameters<typeof test>[1]>[0], on: On, totalTokens: number) => {
  fakeStore(on)
  on('session.usage', () => ({ value: atContext(totalTokens) }) as never)
  engineBand(on)
  await $.command.run({ command: 'usage-bar' } as never) // hide
  await $.command.run({ command: 'usage-bar' } as never) // show, measures
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
  const drawn = (await ui.drawn()) as Node
  const texts: { text: string; props?: object }[] = []
  const walk = (n: Node & { props?: object }) => {
    const only = n.children?.length === 1 && typeof n.children[0] === 'string' ? n.children[0] : undefined
    if (n.type === 'Text' && only !== undefined) texts.push({ text: only, props: n.props })
    for (const c of n.children ?? []) if (typeof c === 'object') walk(c)
  }
  walk(drawn)
  return { text: plain(drawn), tail: texts.find(t => /^ \d+% .+\/.+$/.test(t.text)) }
}

test('below 250k the context numbers stay dim and nothing suggests /compact', async ($, on) => {
  const { text, tail } = await contextDrawing($, on, 249_999)
  expect(tail?.props).toEqual({ dimColor: true, wrap: 'truncate-end' })
  expect(text).not.toContain('/compact')
})

test('from 250k the context numbers turn orange and /compact is suggested', async ($, on) => {
  const { text, tail } = await contextDrawing($, on, 250_000)
  expect(tail?.props).toEqual({ color: usageColor(75), wrap: 'truncate-end' })
  expect(text).toContain('run /compact')
})

test('hiding is written to the store', async ($, on) => {
  const store = fakeStore(on)
  on('session.usage', () => ({ value: USAGE }) as never)
  await $.command.run({ command: 'usage-bar' } as never) // hide
  expect(store.get('isVisible')).toBe(false)
})

for (const stored of [false, true]) {
  test(`a new session reads isVisible=${stored} from the store`, async ($, on) => {
    fakeStore(on, { isVisible: stored })
    on('session.usage', () => ({ value: USAGE }) as never)
    on('session.start', () => ({ cwd: '/' }) as never)
    on('command.register', () => ({ value: undefined }) as never)
    engineBand(on)
    await $.session.start({ cwd: '/' } as never)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
    expect(JSON.stringify(await ui.drawn()).includes('Context')).toBe(stored)
  })
}
