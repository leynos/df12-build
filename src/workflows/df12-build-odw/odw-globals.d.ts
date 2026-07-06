// Ambient declarations for the primitives the ODW loader injects into the
// workflow body as parameters (see ODW's src/loader.ts and src/primitives.ts).
// The src modules reference these as free identifiers; esbuild leaves them
// untouched and they resolve to the wrapper parameters at run time. Semantics
// worth encoding here: `agent` THROWS on adapter failure (it does not return
// null by itself); `parallel` is a barrier whose failed slots resolve to
// null; `pipeline` has no barrier and a throwing chain yields a null slot.

interface OdwAgentOptions {
  label?: string
  phase?: string
  schema?: Record<string, unknown>
  adapter?: string
  model?: string
  effort?: string
  agentType?: string
  isolation?: 'worktree'
}

interface OdwBudget {
  total: number | null
  spent(): number
  remaining(): number
}

declare function agent(prompt: string, opts?: OdwAgentOptions): Promise<unknown>

declare function parallel<T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<Array<T | null>>

declare function pipeline<T, R>(
  items: readonly T[],
  ...stages: Array<(previous: unknown, item: T, index: number) => unknown>
): Promise<Array<R | null>>

declare function phase(title: string): void

declare function log(message: string): void

declare const args: Record<string, unknown> | undefined

declare const budget: OdwBudget

declare function workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<unknown>

declare function validate(source: string): {
  ok: boolean
  meta: Record<string, unknown> | null
  errors: string[]
  warnings: string[]
}
