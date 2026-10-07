import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Segment, Snapshot } from '../types'

const snapshot = atom({ plugin: 'usage-bar', key: 'snapshot' } as const, null)
const isVisible = atom({ plugin: 'usage-bar', key: 'isVisible' } as const, true)
const addresses = atom({ plugin: 'usage-bar', key: 'addresses' } as const, {})
const lookupSince = atom({ plugin: 'usage-bar', key: 'lookupSince' } as const, 0)

// The /usage-bar choice, kept across sessions.
const STORE_KEY = 'isVisible'
const LABEL = 8 // "Context " / "5h      " column
const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

export const kTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const contextTail = (percent: number, total: number, max: number) =>
  ` ${Math.round(percent)}% ${kTokens(total)}/${kTokens(max)}`
// Fixed names rather than the locale's, so the day is always three letters wide.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Windows that always reset within the day ahead, where the time alone is unambiguous.
const TIME_ONLY_LIMITS = new Set(['five_hour'])

/** An ISO 8601 instant as local "Ddd HH:MM" (or "HH:MM"), 24-hour, in the host's time zone; undefined when unreadable. */
const localTime = (iso: string, hasDay: boolean): string | undefined => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return undefined
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return hasDay ? `${DAYS[at.getDay()]} ${hhmm}` : hhmm
}
/** A limit's tail in its two parts: the number, which may take a colour, and the reset time, always dim. */
const limitParts = (l: Limit) => {
  const resets = l.resetsAt === undefined ? undefined : localTime(l.resetsAt, !TIME_ONLY_LIMITS.has(l.kind))
  return { number: ` ${Math.round(l.percentUsed)}%`, resets: resets ? ` resets ${resets}` : '' }
}
const limitTail = (l: Limit) => {
  const { number, resets } = limitParts(l)
  return number + resets
}

/**
 * The columns kept after each bar for its figures: the longest each tail can be, written by the same
 * functions, so the bars keep their width as the figures change and only the terminal width moves them.
 */
// Longer than the context's " 100% 1000k/10.0M", so it leaves the context's figures room too.
const LIMIT_TAIL = limitTail({ kind: '', percentUsed: 100, resetsAt: '2000-01-01T00:00:00Z' }).length // " 100% resets Ddd HH:MM"

/** The label column of a limit drawn in the right half: the longest known name and a space. */
const RIGHT_LABEL = Math.max(...Object.values(LIMIT_NAMES).map(n => n.length)) + 1
/** The space between the two limits sharing a row. */
const GAP = 2
/** Below this many cells a halved bar says too little, and each limit takes a row of its own. */
const MIN_HALF_BAR = 8

/**
 * A limit's fill: green when unused through yellow and orange to red when full, the hue alone moving.
 * Raw colours do not follow the theme, so lightness sits in the middle where both light and dark read it.
 */
export const usageColor = (pct: number, isFaded = false): string => {
  const hue = 120 * (1 - Math.min(100, Math.max(0, pct)) / 100)
  // Faded lowers saturation, not lightness: a muted hue reads as quieter on light and dark alike.
  const s = isFaded ? 0.35 : 0.75
  const l = 0.45
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12
    const v = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(v * 255).toString(16).padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

/**
 * A limit's number once it should draw the eye: yellow from 50%, orange from 75%, red from 90%, by the
 * number as shown (rounded), in the bar's own colours; undefined below, where it stays dim.
 */
export const usageNumberColor = (pct: number): string | undefined => {
  const shown = Math.round(pct)
  if (shown >= 90) return usageColor(100)
  if (shown >= 75) return usageColor(75)
  if (shown >= 50) return usageColor(50)
  return undefined
}

/** From this many tokens in context the numbers turn orange and the band suggests /compact. */
const COMPACT_AT = 250_000

/** Splits `width` cells across segments by tokens, largest remainders first, so the bar is exactly `width`. */
export const cells = (segments: Segment[], max: number, width: number): number[] => {
  const exact = segments.map(s => (max > 0 ? (s.tokens / max) * width : 0))
  const out = exact.map(Math.floor)
  let left = Math.min(width, Math.round(exact.reduce((a, b) => a + b, 0))) - out.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest)
  for (const { i } of order) {
    if (left <= 0) break
    out[i] = (out[i] ?? 0) + 1
    left -= 1
  }
  // A used category with tokens always shows at least one cell, taken from free space.
  segments.forEach((s, i) => {
    if (s.kind === 'used' && s.tokens > 0 && out[i] === 0) {
      const free = segments.findIndex((f, j) => f.kind === 'free' && (out[j] ?? 0) > 0)
      if (free >= 0) {
        out[free] = (out[free] ?? 1) - 1
        out[i] = 1
      }
    }
  })
  return out
}

/** The branch of the session's working directory, `detached <sha>` on a detached HEAD, undefined outside git. */
const gitBranch = async ($: EngineInterface): Promise<string | undefined> => {
  const head = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 2000 })
  if (head.exitCode !== 0) return undefined
  if (head.stdout.trim() !== '') return head.stdout.trim()
  const sha = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], { timeoutMs: 2000 })
  return sha.exitCode === 0 && sha.stdout.trim() !== '' ? `detached ${sha.stdout.trim()}` : undefined
}

/** `dir` with the home directory written `~`. */
export const tildePath = (dir: string, home: string | undefined): string =>
  home && (dir === home || dir.startsWith(`${home}/`)) ? `~${dir.slice(home.length)}` : dir

/** `text` without C0, DEL or C1 control characters, so a folder name can never move the cursor or restyle the terminal. */
export const printable = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

/** Where the session is: its folder, branch and model, each undefined when it cannot be read. */
const place = async ($: EngineInterface) => {
  const [cwd, home, branch, model] = await Promise.all([
    $.session.cwd().catch(() => undefined),
    $.env.get('HOME').catch(() => undefined),
    gitBranch($).catch(() => undefined),
    $.session.model().catch(() => undefined),
  ])
  const shown = (s: string | undefined) => (s === undefined ? undefined : printable(s))
  return { folder: shown(cwd === undefined ? undefined : tildePath(cwd, home)), branch: shown(branch), model: shown(model) }
}

/** The categories the bar draws; deferred ones and any kind the engine adds later are left out. */
const SEGMENT_KINDS = new Set<string>(['used', 'free', 'buffer'] satisfies Segment['kind'][])

const toLimits = (limits: readonly Limit[]): Limit[] =>
  limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))

/** Everything: the context breakdown, the limits, the cost, the folder, the branch and the model. */
const measure = async ($: EngineInterface) => {
  const [usage, where] = await Promise.all([$.session.usage({ breakdown: 'summary' }), place($)])
  const b = usage.context.breakdown
  const segments: Segment[] = (b?.categories ?? []).flatMap(c =>
    SEGMENT_KINDS.has(c.kind) ? [{ name: c.name, color: c.color, tokens: c.tokens, kind: c.kind as Segment['kind'] }] : [],
  )
  const next: Snapshot = {
    segments,
    totalTokens: b?.totalTokens ?? usage.context.tokens ?? 0,
    maxTokens: b?.rawMaxTokens ?? usage.context.window,
    percent: b?.percentage ?? usage.context.percent ?? 0,
    limits: toLimits(usage.rateLimits),
    usd: usage.cost?.usd,
    ...where,
  }
  await update($, snapshot, () => next)
}

/** The folder, branch and model alone, for when they may have moved without the context moving. */
const refreshPlace = async ($: EngineInterface) => {
  const where = await place($)
  await update($, snapshot, s => (s === null ? s : { ...s, ...where }))
}

/** Where the public address is asked, as plain text. */
const PUBLIC_IP_URL = 'https://api.ipify.org'
/** How long a lookup may take before the address is left out. */
const LOOKUP_MS = 3000
/** Longer than a lookup can take: up to six commands in turn, each held to LOOKUP_MS, the fetch alongside. */
const LOOKUP_STALE_MS = 30_000
/** How often the addresses are asked again, so a VPN or network switched while idle shows. */
const ADDRESSES_EVERY_MS = 60_000
const isIpv4 = (s: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every(n => Number(n) <= 255)

/** A dotted IPv4 or an IPv6 address, nothing else, so an error page is never drawn. */
export const isIp = (s: string): boolean => {
  if (isIpv4(s)) return true
  const halves = s.split('::')
  if (halves.length > 2) return false
  // Groups of one to four hex digits, the last of them maybe an embedded IPv4 counting for two.
  const groups = halves.map(h => (h === '' ? [] : h.split(':')))
  const all = groups.flat()
  const last = all.at(-1)
  const v4 = last !== undefined && last.includes('.') ? 1 : 0
  if (v4 === 1 && !isIpv4(last ?? '')) return false
  if (!all.slice(0, all.length - v4).every(g => /^[\da-f]{1,4}$/i.test(g))) return false
  const count = all.length + v4
  return halves.length === 2 ? count <= 7 : count === 8
}

/** A command's output, undefined when it fails or cannot run. */
const output = async ($: EngineInterface, argv: string[]): Promise<string | undefined> => {
  const run = await $.process.run(argv, { timeoutMs: LOOKUP_MS }).catch(() => undefined)
  return run?.exitCode === 0 ? run.stdout : undefined
}

/**
 * The machine's address on its network, where its default route leaves: on macOS that route's interface,
 * on Linux its source (never a container bridge); then Wi-Fi, Ethernet and the first address as a last
 * resort. Undefined when none answers. Asking the route sends nothing.
 */
const localIp = async ($: EngineInterface): Promise<string | undefined> => {
  const routes: (() => Promise<string | undefined>)[] = [
    async () => {
      const ifname = (await output($, ['route', '-n', 'get', 'default']))?.match(/interface:\s*(\S+)/)?.[1]
      return ifname === undefined ? undefined : (await output($, ['ipconfig', 'getifaddr', ifname]))?.trim()
    },
    async () => (await output($, ['ip', 'route', 'get', '1.1.1.1']))?.match(/\bsrc\s+(\S+)/)?.[1],
    ...[['ipconfig', 'getifaddr', 'en0'], ['ipconfig', 'getifaddr', 'en1'], ['hostname', '-I']].map(
      argv => async () => (await output($, argv))?.trim().split(/\s+/)[0],
    ),
  ]
  for (const route of routes) {
    const ip = await route()
    if (ip !== undefined && isIp(ip)) return ip
  }
  return undefined
}

/** The address the internet sees, through the host; undefined offline, refused or past the timeout. */
const publicIp = async ($: EngineInterface): Promise<string | undefined> => {
  const answer = await Promise.race([
    $.http.fetch(PUBLIC_IP_URL).catch(() => undefined),
    $.clock.sleep(LOOKUP_MS).then(() => undefined, () => undefined),
  ])
  const ip = answer?.ok ? answer.text.trim() : undefined
  return ip !== undefined && isIp(ip) ? ip : undefined
}

/**
 * Both addresses, asked apart from the measurement so a slow network never holds the band. A call made
 * while a lookup is under way is dropped, so lookups never pile up or land out of order. A claim older
 * than any lookup can take, left by a reload mid-lookup, is stale and taken over.
 */
const refreshAddresses = async ($: EngineInterface) => {
  if (!(await read($, isVisible))) return
  const now = Date.now()
  let isClaimed = false
  await update($, lookupSince, since => ((isClaimed = now - since > LOOKUP_STALE_MS), isClaimed ? now : since))
  if (!isClaimed) return
  try {
    const [local, pub] = await Promise.all([localIp($), publicIp($)])
    await update($, addresses, () => ({ local, public: pub }))
  } finally {
    await update($, lookupSince, since => (since === now ? 0 : since))
  }
}

// East Asian wide and fullwidth blocks: Hangul Jamo, CJK and Yi, Hangul, compatibility, fullwidth forms, the supplementary ideographs.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The columns a terminal gives `text`: two for a wide character or an emoji, none for a lone combining mark. */
export const cellWidth = (text: string): number => {
  let width = 0
  for (const { segment } of graphemes.segment(text)) {
    if (/^\p{M}+$/u.test(segment)) continue
    width += /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u.test(segment) || WIDE.test(segment) ? 2 : 1
  }
  return width
}

/**
 * The separator's title and its right end, the addresses, each part a string to colour. The dashes give
 * way first; then the addresses, public alone before none; then the title is cut from its end.
 */
export const ruleParts = (title: string, local: string | undefined, pub: string | undefined, columns: number) => {
  const left = title === '' ? 0 : cellWidth(title) + 4 // "── " title " "
  for (const right of [[local, pub], [pub], []].map(a => a.filter((x): x is string => x !== undefined).join(' → '))) {
    const fill = columns - 1 - left - (right === '' ? 0 : right.length + 4) // " " right " ──"
    if (fill >= 1 || right === '') return { fill: Math.max(0, fill), right }
  }
  return { fill: 0, right: '' }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'usage-bar', description: 'Toggle the context and usage bar above the prompt' })
    const stored = await $.store.get(STORE_KEY)
    if (typeof stored === 'boolean') await update($, isVisible, () => stored)
    if (await read($, isVisible)) await measure($).catch(() => undefined)
    void refreshAddresses($).catch(() => undefined)
    $.clock.every(ADDRESSES_EVERY_MS, () => void refreshAddresses($).catch(() => undefined))
    return started
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (!(await read($, isVisible))) return result
    // Only a moved context needs the breakdown and git again; limits and cost come with the event.
    if (e.changed.includes('context') || (await read($, snapshot)) === null) await measure($).catch(() => undefined)
    else await update($, snapshot, s => (s === null ? s : { ...s, limits: toLimits(e.rateLimits), usd: e.cost?.usd }))
    return result
  })

  // A checkout in a `!` command or another terminal, or a /model or /cd, shows at the next prompt rather than after its turn.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (await read($, isVisible)) await refreshPlace($).catch(() => undefined)
    void refreshAddresses($).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'usage-bar' }, async $ => {
    const now = await update($, isVisible, v => !v)
    await $.store.set(STORE_KEY, now)
    if (now) await Promise.all([measure($), refreshAddresses($)]).catch(() => undefined)
    return { text: now ? 'Usage bar shown.' : 'Usage bar hidden.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const ips = await read($, addresses)
    if (e.props.hasSurvey || snap === null || !(await read($, isVisible))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    // One width for every bar, from the terminal width alone: half a row when two limits share one.
    const halfWidth = Math.floor((e.props.bodyColumns - LABEL - RIGHT_LABEL - 2 * LIMIT_TAIL - GAP - 1) / 2)
    const isPaired = halfWidth >= MIN_HALF_BAR
    const width = isPaired ? halfWidth : Math.max(0, e.props.bodyColumns - LABEL - LIMIT_TAIL - 1)
    const limitRows = isPaired
      ? snap.limits.flatMap((l, i) => (i % 2 === 0 ? [snap.limits.slice(i, i + 2)] : []))
      : snap.limits.map(l => [l])
    const widths = cells(snap.segments, snap.maxTokens, width)
    const used = snap.segments.filter(s => s.kind === 'used' && s.tokens > 0)
    const isLarge = snap.totalTokens >= COMPACT_AT
    const folder = snap.folder ?? ''
    const branch = snap.branch === undefined ? '' : `${folder !== '' ? '  ' : ''}⎇ ${snap.branch}`
    const model = snap.model === undefined ? '' : `${folder !== '' || branch !== '' ? '  ' : ''}${snap.model}`
    const title = folder + branch + model
    const rule = ruleParts(title, ips.local, ips.public, e.props.bodyColumns)
    // The lines under the context bar hang from it, the last one closing the group.
    const branchOff = (isLast: boolean) => <Text dimColor>{`${isLast ? '└' : '├'} `.padStart(LABEL)}</Text>

    return (
      // A blank row above, so the chat's last line never sits against the rule.
      <Box flexDirection="column" marginTop={1}>
        {/* The separator from the chat, titled with the folder, branch and model, the addresses at its right end. */}
        <Text wrap="truncate-end">
          <Text dimColor>{title === '' ? '' : '── '}</Text>
          {folder !== '' && <Text bold>{folder}</Text>}
          {branch !== '' && <Text color="suggestion">{branch}</Text>}
          {model !== '' && <Text dimColor>{model}</Text>}
          <Text dimColor>{`${title === '' ? '' : ' '}${'─'.repeat(rule.fill)}`}</Text>
          {rule.right !== '' && <Text dimColor>{' '}</Text>}
          {rule.right !== '' && <Text>{rule.right}</Text>}
          {rule.right !== '' && <Text dimColor>{' ──'}</Text>}
        </Text>
        <Box>
          <Text bold>{'Context'.padEnd(LABEL)}</Text>
          {snap.segments.map((s, i) => {
            const n = widths[i] ?? 0
            return n > 0 ? (
              <Text key={s.name} color={s.color} dimColor={s.kind !== 'used'}>
                {(s.kind === 'used' ? '█' : s.kind === 'buffer' ? '▒' : '░').repeat(n)}
              </Text>
            ) : null
          })}
          <Text {...(isLarge ? { color: usageColor(75) } : { dimColor: true })} wrap="truncate-end">
            {contextTail(snap.percent, snap.totalTokens, snap.maxTokens)}
          </Text>
        </Box>
        <Text wrap="truncate">
          {branchOff(!isLarge)}
          {used.map(s => (
            <Text key={s.name}>
              <Text color={s.color}>■</Text>
              <Text dimColor>{` ${s.name} ${kTokens(s.tokens)}  `}</Text>
            </Text>
          ))}
        </Text>
        {isLarge && (
          <Text wrap="truncate-end">
            {branchOff(true)}
            <Text color={usageColor(75)}>{`Context above ${kTokens(COMPACT_AT)}: run /compact to free space`}</Text>
          </Text>
        )}
        {limitRows.map(row => (
          <Box key={row.map(l => l.kind).join(' ')}>
            {row.map((l, i) => {
              // Right-aligned, so each name sits against its bar; a name the bar does not know is cut to the column.
              const column = i === 0 ? LABEL : RIGHT_LABEL
              const label = `${(LIMIT_NAMES[l.kind] ?? l.kind).slice(0, column - 1)} `.padStart(column)
              const fill = Math.round((Math.min(100, Math.max(0, l.percentUsed)) / 100) * width)
              const { number, resets } = limitParts(l)
              const alert = usageNumberColor(l.percentUsed)
              // A left half keeps its full tail, so the right half starts at the same column whatever the figures.
              const tail = i === 0 && row.length > 1 ? resets.padEnd(LIMIT_TAIL - number.length + GAP) : resets
              return (
                <Box key={l.kind}>
                  <Text bold>{label}</Text>
                  {/* Faded, to sit quietly beside the chat; dimColor would grey a raw colour out. */}
                  <Text color={usageColor(l.percentUsed, true)}>{'█'.repeat(fill)}</Text>
                  <Text dimColor>{'░'.repeat(width - fill)}</Text>
                  <Text {...(alert ? { color: alert } : { dimColor: true })}>{number}</Text>
                  {tail !== '' && (
                    <Text dimColor wrap="truncate-end">
                      {tail}
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
        ))}
        {snap.limits.length === 0 && snap.usd !== undefined && (
          // Also drawn on a subscription until its first response reports the limits, so it claims nothing about them.
          <Text dimColor wrap="truncate-end">{`${'Cost'.padEnd(LABEL)}$${snap.usd.toFixed(2)} this session`}</Text>
        )}
      </Box>
    )
  })
}
