export type Segment = { name: string; color: string; tokens: number; kind: 'used' | 'free' | 'buffer' }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Snapshot = {
  segments: Segment[]
  totalTokens: number
  maxTokens: number
  percent: number
  limits: Limit[]
  usd?: number
  /** The session's git branch, `detached <sha>` on a detached HEAD; absent outside a repository. */
  branch?: string
  /** The session's working directory, the home directory written `~`. */
  folder?: string
  /** The main loop's model, as /model shows it. */
  model?: string
}

/** The machine's addresses, each absent until read or when it cannot be. */
export type Addresses = { local?: string; public?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { snapshot: Snapshot | null; isVisible: boolean; addresses: Addresses; lookupSince: number }
  }
}
