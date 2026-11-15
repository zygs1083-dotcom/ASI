/**
 * Analyzer-only ambient re-declaration of '@deepseek-ai/dsh-typert-protocol'.
 * The workspace aggregate maps this specifier here via `paths` so Typert's
 * isTypeMetaSymbol finds the meta declarations inside a `declare module`
 * block; the leaf emit tsconfig resolves the real package through
 * node_modules, so runtime behavior is untouched. Declarations mirror the
 * public signatures the spike uses.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void
  export function Remote(name: string): <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
  export function Remote(options: { readonly mode?: 'stream' }): <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
  export abstract class TypertRemoteService<T = never> {
    protected constructor(ctx: import('@deepseek-ai/cordis').Context, serviceKey: string, options?: { readonly namespace?: string })
    readonly name: string
    readonly ctx: import('@deepseek-ai/cordis').Context
    readonly typertRemote: unknown
  }
  export class RemoteError<Code extends string = string> extends Error {
    constructor(code: Code, message: string, details: object, options?: ErrorOptions)
    readonly code: Code
    readonly details: object
  }
  export interface TypertLookup<Host, Wire> {
    readonly host?: Host
    readonly wire?: Wire
  }
  export interface TypertContext<Wire> {
    readonly wire?: Wire
  }
  export interface TypertLookupMap {}
  export interface TypertContextMap {}
  export type RemoteStream<Out, In = never> = AsyncIterable<Out>
  export function bindTypertRemote<Service extends object>(
    service: Service,
    serviceKey: string,
    options?: { readonly namespace?: string },
  ): unknown
}
