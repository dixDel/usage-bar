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
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { snapshot: Snapshot | null; isVisible: boolean }
  }
}
