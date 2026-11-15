/**
 * Analyzer-only ambient re-declaration of '@deepseek-ai/dsh-agent'. The
 * aggregate `paths` maps the specifier here so `Agent` and the `agents`
 * registry resolve inside the registered workspace package without loading
 * the real package graph. Remote signatures take plain `string` session ids;
 * `Agent` appears only in method bodies, so no TypertLookupMap entry exists.
 */
import type { SessionId } from './types.ts'

declare module '@deepseek-ai/dsh-agent' {
  export interface Agent {
    readonly id: SessionId
    readonly session: import('@deepseek-ai/dsh-session').Session
    readonly status: string
    readonly model: {
      current(): { readonly provider: string, readonly model: string } | undefined
    }
    inject(message: import('@deepseek-ai/dsh-llm').UserMessage): void
    followup(message: import('@deepseek-ai/dsh-llm').UserMessage): void
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: {
      get(id: SessionId): import('@deepseek-ai/dsh-agent').Agent | undefined
    }
  }
}
