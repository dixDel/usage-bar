import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { cells, tildePath, usageColor, usageNumberColor } from './register'

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

describe('tildePath', () => {
  test('writes the home directory as ~', () => {
    expect(tildePath('/Users/me/Code/app', '/Users/me')).toBe('~/Code/app')
    expect(tildePath('/Users/me', '/Users/me')).toBe('~')
  })
  test('leaves other paths, and a sibling sharing the prefix, alone', () => {
    expect(tildePath('/Users/meg/app', '/Users/me')).toBe('/Users/meg/app')
    expect(tildePath('/opt/app', undefined)).toBe('/opt/app')
  })
})

type Dollar = Parameters<Parameters<typeof test>[1]>[0]
type Git = Record<string, { exitCode: number; stdout: string }>
type Node = { type?: string; props?: object; children?: (Node | string)[] }

type Place = { cwd?: string; home?: string; model?: string }

/**
 * Fakes the store, git, the usage figures, the folder and model, and the engine's own band. `calls` logs
 * each usage read (`usage`) and git command; `usage`, `git` and `place` are swapped in place for the next
 * measurement. With no `place`, the folder and model cannot be read.
 */
const fakes = (on: On, init: { usage?: unknown; git?: Git; store?: Record<string, unknown>; place?: Place } = {}) => {
  const f = {
    usage: init.usage ?? USAGE,
    git: init.git ?? {},
    place: init.place ?? {},
    store: new Map(Object.entries(init.store ?? {})),
    calls: [] as string[],
  }
  const known = (v: string | undefined) => (v === undefined ? { deny: 'unset' } : { value: v })
  on('session.cwd', () => known(f.place.cwd) as never)
  on('session.model', () => known(f.place.model) as never)
  on('env.get', () => ({ value: f.place.home }) as never)
  on('store.get', (_$, e) => ({ value: f.store.get(e.key) }) as never)
  on('store.set', (_$, e) => (f.store.set(e.key, e.value), { value: undefined }) as never)
  on('session.usage', () => (f.calls.push('usage'), { value: f.usage }) as never)
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    f.calls.push(argv)
    const a = f.git[argv] ?? { exitCode: 128, stdout: '' }
    return { value: { ...a, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return f
}

/** Hides then shows the band, which measures, and mounts it. */
const mount = async ($: Dollar, bodyColumns = 100, surface: 'terminal' | 'desktop' = 'terminal') => {
  await $.command.run({ command: 'usage-bar' } as never) // hide
  await $.command.run({ command: 'usage-bar' } as never) // show, measures
  return $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns } as never })
}

/** The drawing's text as the terminal shows it, pieces joined in order. */
const plain = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(plain).join(''))

/** Every Text holding a single string, with its props. */
const texts = (root: Node) => {
  const out: { text: string; props?: object }[] = []
  const walk = (n: Node) => {
    const only = n.children?.length === 1 && typeof n.children[0] === 'string' ? n.children[0] : undefined
    if (n.type === 'Text' && only !== undefined) out.push({ text: only, props: n.props })
    for (const c of n.children ?? []) if (typeof c === 'object') walk(c)
  }
  walk(root)
  return out
}

/** Each Box row that holds a bar: the bar's glyphs and the row's whole text. */
const barRows = (root: Node) => {
  const out: { bar: string; row: string }[] = []
  const walk = (n: Node) => {
    if (n.type === 'Box') {
      const parts = (n.children ?? []).map(plain)
      const bar = parts.filter(t => /^[█░▒]+$/.test(t)).join('')
      if (bar !== '') out.push({ bar, row: parts.join('') })
    }
    for (const c of n.children ?? []) if (typeof c === 'object') walk(c)
  }
  walk(root)
  return out
}

/** Shows the band over these figures and returns its drawing. */
const drawn = async ($: Dollar, on: On, usage: unknown = USAGE, bodyColumns = 100) => {
  fakes(on, { usage })
  return (await (await mount($, bodyColumns)).drawn()) as Node
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws context and limits, /usage-bar hides it (${surface})`, async ($, on) => {
    fakes(on)
    const ui = await mount($, 100, surface)
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

test('a category of a kind the bar does not know is left out', async ($, on) => {
  const categories = [...USAGE.context.breakdown.categories, { name: 'Future thing', tokens: 5_000, color: 'x', isDeferred: false, kind: 'future' }]
  const tree = await drawn($, on, { ...USAGE, context: { ...USAGE.context, breakdown: { ...USAGE.context.breakdown, categories } } })
  expect(plain(tree)).not.toContain('Future thing')
  expect(texts(tree).filter(t => (t.props as { color?: string } | undefined)?.color === 'x')).toEqual([])
})

test('titles the separator rule with the folder, branch and model, across the width', async ($, on) => {
  fakes(on, {
    git: { 'git branch --show-current': { exitCode: 0, stdout: 'feature/301-thing\n' } },
    place: { cwd: '/Users/me/Code/app', home: '/Users/me', model: 'Opus 5.5 (1M context)' },
  })
  const [rule] = lines((await (await mount($)).drawn()) as Node)
  expect(rule).toMatch(/^── ~\/Code\/app {2}⎇ feature\/301-thing {2}Opus 5\.5 \(1M context\) ─+$/)
  expect(rule?.length).toBe(BAND.bodyColumns - 1)
})

test('a detached HEAD shows its short sha', async ($, on) => {
  fakes(on, {
    git: {
      'git branch --show-current': { exitCode: 0, stdout: '\n' },
      'git rev-parse --short HEAD': { exitCode: 0, stdout: 'df04d8e\n' },
    },
  })
  expect(JSON.stringify(await (await mount($)).drawn())).toContain('detached df04d8e')
})

test('outside a git repository the row keeps the folder and model', async ($, on) => {
  fakes(on, { place: { cwd: '/tmp/x', model: 'Sonnet 5.5' } })
  const text = plain((await (await mount($)).drawn()) as Node)
  expect(text).toContain('/tmp/x  Sonnet 5.5')
  expect(text).not.toContain('⎇')
})

test('with nothing to show the rule has no title', async ($, on) => {
  const [rule] = lines(await drawn($, on))
  expect(rule).toBe('─'.repeat(BAND.bodyColumns - 1))
})

test('a prompt picks up a branch, folder or model changed outside the turn', async ($, on) => {
  const f = fakes(on, { git: { 'git branch --show-current': { exitCode: 0, stdout: 'main\n' } }, place: { cwd: '/a', model: 'Opus 5.5' } })
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  const ui = await mount($)
  expect(plain((await ui.drawn()) as Node)).toContain('/a  ⎇ main  Opus 5.5')
  f.git = { 'git branch --show-current': { exitCode: 0, stdout: 'feature/next\n' } }
  f.place = { cwd: '/b', model: 'Haiku 4.5' }
  await $.prompt.submit({ text: 'hi' } as never)
  expect(plain((await ui.drawn()) as Node)).toContain('/b  ⎇ feature/next  Haiku 4.5')
})

describe('session.measure', () => {
  const measured = (on: On) => on('session.measure', (_$, e) => ({ changed: e.changed }) as never)

  test('a limits-only measurement redraws the limits without the breakdown or git', async ($, on) => {
    const f = fakes(on)
    measured(on)
    const ui = await mount($)
    f.calls.length = 0
    await $.session.measure({
      context: USAGE.context, rateLimits: [{ kind: 'five_hour', percentUsed: 81 }], cost: { usd: 2 }, changed: ['rateLimits'],
    } as never)
    expect(f.calls).toEqual([])
    expect(plain((await ui.drawn()) as Node)).toContain('81%')
  })

  test('a moved context measures everything again', async ($, on) => {
    const f = fakes(on)
    measured(on)
    const ui = await mount($)
    f.calls.length = 0
    f.usage = { ...USAGE, context: { ...USAGE.context, breakdown: { ...USAGE.context.breakdown, percentage: 31, totalTokens: 62_000 } } }
    await $.session.measure({ context: USAGE.context, rateLimits: USAGE.rateLimits, cost: USAGE.cost, changed: ['context'] } as never)
    expect(f.calls).toContain('usage')
    expect(f.calls).toContain('git branch --show-current')
    expect(plain((await ui.drawn()) as Node)).toContain('31% 62k/200k')
  })

  test('a hidden band is not measured', async ($, on) => {
    const f = fakes(on)
    measured(on)
    await $.command.run({ command: 'usage-bar' } as never) // hide
    f.calls.length = 0
    await $.session.measure({ context: USAGE.context, rateLimits: USAGE.rateLimits, cost: USAGE.cost, changed: ['context'] } as never)
    expect(f.calls).toEqual([])
  })
})

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

/** Draws the bar rows for any figures and width, the figures swapped between draws. */
const rowsAt = (on: On) => {
  const f = fakes(on)
  return async ($: Dollar, figures: unknown, bodyColumns: number) => {
    f.usage = figures
    return barRows((await (await mount($, bodyColumns)).drawn()) as Node)
  }
}

/** Each row of the band as the terminal shows it, nested pieces joined. */
const lines = (root: Node): string[] => {
  const band = (n: Node): Node | undefined =>
    n.type === 'Box' && (n.props as { flexDirection?: string } | undefined)?.flexDirection === 'column'
      ? n
      : (n.children ?? []).flatMap(c => (typeof c === 'object' ? [band(c)] : [])).find(Boolean)
  return (band(root)?.children ?? []).map(plain)
}

test('5h and 7d share one row, all three bars the same width', async ($, on) => {
  const figures = withFigures(30, 60_000, [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-10-06T14:00:00Z' }, { kind: 'seven_day', percentUsed: 7 }])
  const tree = await drawn($, on, figures)
  const rows = barRows(tree)
  expect(rows.length).toBe(3)
  expect(new Set(rows.map(r => r.bar.length)).size).toBe(1)
  expect(lines(tree).filter(l => l.trimStart().startsWith('5h')).map(l => l.includes('7d'))).toEqual([true])
})

test('the 7d half starts at the same column whatever the 5h figures', async ($, on) => {
  const f = fakes(on)
  const draw = async (figures: unknown) => {
    f.usage = figures
    return lines((await (await mount($)).drawn()) as Node).find(l => l.trimStart().startsWith('5h'))?.indexOf('7d')
  }
  expect(await draw(SHORT)).toBe(await draw(LONG))
})

test('a third limit starts a row of its own, names right-aligned against their bars', async ($, on) => {
  const tree = await drawn($, on, withFigures(9, 9_000, [...SHORT.rateLimits, { kind: 'spend_limit', percentUsed: 12 }]))
  expect(lines(tree).filter(l => /^ *(5h|spend)/.test(l)).map(l => l.slice(0, 8))).toEqual(['     5h ', '  spend '])
})

test('a terminal too narrow for halves draws each limit on its own row', async ($, on) => {
  const tree = await drawn($, on, SHORT, 70)
  const rows = barRows(tree)
  expect(lines(tree).filter(l => /^ *(5h|7d)/.test(l)).length).toBe(2)
  expect(new Set(rows.map(r => r.bar.length)).size).toBe(1)
})

test('the bars keep their width when the figures after them grow or shrink', async ($, on) => {
  const draw = rowsAt(on)
  const short = await draw($, SHORT, 100)
  const long = await draw($, LONG, 100)
  expect(long.map(r => r.bar.length)).toEqual(short.map(r => r.bar.length))
})

test('the bars follow the terminal width', async ($, on) => {
  const draw = rowsAt(on)
  const wide = await draw($, SHORT, 120)
  const narrow = await draw($, SHORT, 100)
  expect((wide[0]?.bar.length ?? 0) - (narrow[0]?.bar.length ?? 0)).toBe(10) // two bars share the 20 columns
})

for (const columns of [100, 70, 30]) {
  test(`the longest figures still fit in ${columns} columns`, async ($, on) => {
    const tree = await drawn($, on, LONG, columns)
    for (const line of lines(tree).filter(l => /^(Context| *5h| *7d)/.test(l))) expect(line.length).toBeLessThanOrEqual(columns)
  })
}

test('without limits the cost row states the cost alone and truncates', async ($, on) => {
  const cost = texts(await drawn($, on, { ...USAGE, rateLimits: [] }, 30)).find(t => t.text.startsWith('Cost'))
  expect(cost).toEqual({ text: 'Cost    $1.23 this session', props: { dimColor: true, wrap: 'truncate-end' } })
})

test('the 7d fill is faded, never greyed by dimColor, the 5h fill is vivid', async ($, on) => {
  const tree = await drawn($, on, { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 90 }, { kind: 'seven_day', percentUsed: 20 }] })
  const fills = texts(tree)
    .filter(t => /^█+$/.test(t.text) && (t.props as { color?: string } | undefined)?.color?.startsWith('#'))
    .map(t => t.props)
  expect(fills).toEqual([{ color: usageColor(90) }, { color: usageColor(20, true) }])
})

const hhmm = (at: Date) => `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
const weekday = (at: Date) => new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(at)

test('a reset shows its local day and time, without the UTC Z', async ($, on) => {
  const resetsAt = '2026-10-08T22:05:00Z'
  const local = `${weekday(new Date(resetsAt))} ${hhmm(new Date(resetsAt))}`
  const text = plain(await drawn($, on, { ...USAGE, rateLimits: [{ kind: 'seven_day', percentUsed: 42.5, resetsAt }] }))
  expect(text).toContain(`43% resets ${local}`)
  expect(text).not.toContain(`${local}Z`)
})

test('the 5h reset shows its local time without the day', async ($, on) => {
  const resetsAt = '2026-10-08T22:05:00Z'
  const text = plain(await drawn($, on, { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt }] }))
  expect(text).toContain(`43% resets ${hhmm(new Date(resetsAt))}`)
  expect(text).not.toContain(`resets ${weekday(new Date(resetsAt))}`)
})

test('an unreadable reset time is left out rather than drawn as NaN', async ($, on) => {
  const text = plain(await drawn($, on, { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: 'soon' }] }))
  expect(text).toContain('43%')
  expect(text).not.toContain('resets')
})

test('a limit number past 50% stands out in its colour, the reset time stays dim', async ($, on) => {
  const all = texts(await drawn($, on, {
    ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 91, resetsAt: '2026-10-06T14:05:00Z' }, { kind: 'seven_day', percentUsed: 20 }],
  }))
  expect(all.find(t => t.text.trim() === '91%')?.props).toEqual({ color: usageColor(100) })
  expect(all.find(t => t.text.trim() === '20%')?.props).toEqual({ dimColor: true })
  expect(all.find(t => t.text.includes('resets'))?.props).toEqual({ dimColor: true, wrap: 'truncate-end' })
})

const atContext = (totalTokens: number) => ({
  ...USAGE,
  context: {
    ...USAGE.context,
    window: 1_000_000,
    breakdown: { ...USAGE.context.breakdown, totalTokens, rawMaxTokens: 1_000_000, percentage: Math.round(totalTokens / 10_000) },
  },
})

const contextDrawing = async ($: Dollar, on: On, totalTokens: number) => {
  const tree = await drawn($, on, atContext(totalTokens))
  return { text: plain(tree), tail: texts(tree).find(t => /^ \d+% .+\/.+$/.test(t.text)) }
}

/** The lines hanging from the context bar, up to the limits. */
const hanging = async ($: Dollar, on: On, totalTokens: number) =>
  lines(await drawn($, on, atContext(totalTokens))).filter(l => /^ {6}[├└] /.test(l)).map(l => l.slice(0, 10))

test('below 250k the context numbers stay dim and nothing suggests /compact', async ($, on) => {
  const { text, tail } = await contextDrawing($, on, 249_999)
  expect(tail?.props).toEqual({ dimColor: true, wrap: 'truncate-end' })
  expect(text).not.toContain('/compact')
})

test('the legend hangs from the context bar', async ($, on) => {
  expect(await hanging($, on, 60_000)).toEqual(['      └ ■ '])
})

test('from 250k the context numbers turn orange and /compact is suggested', async ($, on) => {
  const { text, tail } = await contextDrawing($, on, 250_000)
  expect(tail?.props).toEqual({ color: usageColor(75), wrap: 'truncate-end' })
  expect(text).toContain('run /compact')
})

test('the /compact hint closes the group under the legend', async ($, on) => {
  expect(await hanging($, on, 250_000)).toEqual(['      ├ ■ ', '      └ Co'])
})

test('hiding is written to the store', async ($, on) => {
  const f = fakes(on)
  await $.command.run({ command: 'usage-bar' } as never) // hide
  expect(f.store.get('isVisible')).toBe(false)
})

for (const stored of [false, true]) {
  test(`a new session reads isVisible=${stored} from the store, and measures only when shown`, async ($, on) => {
    const f = fakes(on, { store: { isVisible: stored } })
    on('session.start', () => ({ cwd: '/' }) as never)
    on('command.register', () => ({ value: undefined }) as never)
    await $.session.start({ cwd: '/' } as never)
    expect(f.calls.includes('usage')).toBe(stored)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
    expect(JSON.stringify(await ui.drawn()).includes('Context')).toBe(stored)
  })
}
