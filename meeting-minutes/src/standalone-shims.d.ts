// Ambient stand-ins for the Harness packages this plugin reaches only through types or through the
// Host's module table, so the package typechecks on its own without a Harness checkout. At run time
// the Host answers every one of these from its own installation.
declare module '@deepseek-ai/cordis' { export type Context = any }
declare module '@deepseek-ai/dsh-invariants' { export type InvariantInstaller = any }
declare module '@deepseek-ai/dsh-brand' { export type Branded<B extends string> = string & { readonly __brand: B } }
declare module '@deepseek-ai/schemastery' { type z<T = any> = any; const z: any; export default z }
declare module '@deepseek-ai/dsh-home-paths' { export const dshHomePath: any; export const expandHomePath: any }
declare module '@deepseek-ai/dsh-timeout' { export const MAX_TIMER_DELAY_MS: number; export const deadline: any }
declare module '@deepseek-ai/dsh-atomic-write' { export const writeFileAtomic: any }
declare module '@deepseek-ai/dsh-agent-default-model' {}
declare module '@deepseek-ai/dsh-host-webserver' {}
declare module '@deepseek-ai/dsh-subprocess' {}
declare module '@deepseek-ai/dsh-llm' {
  export class BlockAssembler {
    push(chunk: unknown): void
    readonly finish: any
    blocks(): Array<{ type: 'text'; text: string } | { type: 'tool-call' } | { type: 'reasoning' }>
  }
  export const createUserMessage: any
  export type FinishReason = any; export type GenerateOptions = any; export type ReasoningEffortId = any
}
declare module '@deepseek-ai/dsh-client-store' {
  export interface SnapshotStore<T> {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
    update(mutator: (draft: T) => void): void
    set(next: T): void
  }
  export const createSnapshotStore: <T>(init: T, opts?: any) => SnapshotStore<T>
}
declare module '@deepseek-ai/dsh-client-locale/client' {}
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {}
declare module '@deepseek-ai/dsh-client-ui-settings-plugins/client' {}
declare module '@deepseek-ai/dsh-client-ui-settings/client' {
  export interface SettingsScopeSnapshot<T> { readonly value: T; readonly user?: unknown; readonly [key: string]: any }
  export interface SettingsScope<T> {
    getSnapshot(): SettingsScopeSnapshot<T>
    subscribe(listener: () => void): () => void
    mutate(ops: readonly any[], expectedRevision?: number): Promise<void>
    set(field: string, value: unknown): Promise<void>
    unset(field: string): Promise<void>
  }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
  /** Slot runtime props (owner, surface, open state, …) the Host passes to a slot occupant. */
  export type PropsRuntime<K = any> = { readonly [key: string]: any }
  /** The translator bound to the occupant's locale namespace. */
  export type PropsLocale<N = any> = { t: (key: string, params?: Record<string, unknown>) => string }
  /** A registrant face with its `hooks` compartment bound to `use<Name>(selector)` props. */
  export type InjectFace<I extends object> = I extends { hooks: infer H }
    ? Omit<I, 'hooks'> & {
      [K in keyof H & string as `use${Capitalize<K>}`]: H[K] extends { getSnapshot(): infer S }
        ? <R>(selector: (snapshot: S) => R, equal?: (a: R, b: R) => boolean) => R
        : never
    }
    : I
}
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export const Button: any; export const ChoiceRow: any; export const Modal: any; export const StateDot: any
  export const Tooltip: any; export const IconChevronDownOutline14: any; export const IconDownloadOutline16: any
  export const IconMicrophoneOutline16: any; export const IconStopFill16: any
}
