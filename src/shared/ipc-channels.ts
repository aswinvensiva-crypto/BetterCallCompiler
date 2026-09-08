/**
 * The channel name registry — deliberately free of every import.
 *
 * This file exists (it is not in the original target layout) because the
 * preload is the one place that must stay dependency-free: it runs under
 * `sandbox: true`, where the only resolvable module is `electron`. Importing
 * `ipc-contract.ts` would drag zod into the preload bundle, and electron-vite
 * externalises node_modules in its SSR build, so the emitted `require("zod")`
 * would throw at load and take the whole bridge down with it.
 *
 * Splitting names from schemas is not a workaround so much as the right seam:
 * the preload binds *names* to `ipcRenderer`; validating *payloads* is main's
 * job. There is still exactly one list of channels — `ipc-contract.ts` is
 * compile-time forced to supply schemas for every name here, and no others.
 */

/** Renderer → main, request/response, always resolving to a `Result`. */
export const INVOKE_CHANNEL_NAMES = [
  'app:ping',
  'fs:openFolder',
  'fs:getWorkspace',
  'fs:readDir',
  'fs:readFile',
  'fs:writeFile',
  'fs:createFile',
  'fs:createDir',
  'fs:rename',
  'fs:delete',
  'fs:listFiles',
  'fs:languageBreakdown',
  'fs:search',
  'terminal:create',
  'terminal:write',
  'terminal:resize',
  'terminal:dispose',
  'terminal:list',
  'toolchain:list',
  'toolchain:rescan',
  'run:start',
  'run:cancel',
  'git:status',
  'git:diff',
  'git:stage',
  'git:unstage',
  'git:commit',
  'git:branches',
  'git:log',
  'git:stats',
  'github:insights',
  'secrets:setKey',
  'secrets:hasKey',
  'secrets:clearKey',
  'settings:get',
  'settings:set',
  'ai:start',
  'ai:cancel',
  'ai:apply',
  'ai:revert',
  'ai:log',
  'visualizer:openFloating',
  'visualizer:closeFloating',
  'visualizer:pushState',
  'visualizer:requestReveal',
  'compiler:status',
  'compiler:diagnostics',
  'compiler:dependents',
  'compiler:openDocument',
  'compiler:closeDocument',
  'compiler:restart',
  'compiler:passes',
  // Navigation. Deliberately on the `compiler:` namespace rather than a new
  // one: the renderer asks the same question of a `.ts` and a `.bcc` file and
  // main routes by extension, exactly as `compiler:openDocument` already does.
  // A second namespace would put the choice of compiler back in the renderer.
  'compiler:definition',
  'compiler:references',
  'compiler:rename',
  'compiler:documentSymbols',
  'compiler:hover',
  'compiler:codeActions',
  // Keystroke-frequency, and served by the third worker — see
  // `interactive-protocol.ts` for why it is not the one that checks.
  'compiler:completions',
  'compiler:completionDetail',
  'compiler:signatureHelp',
  // The write half of a rename or a quick fix, for the files that have no
  // buffer. Open files are edited through their model so they stay dirty and
  // undoable; a bulk edit spanning CLOSED files would have Monaco create models
  // with no lifecycle owner — exactly the leak `closeSyntaxDocument` exists to
  // prevent — so those cross to main instead.
  'compiler:applyWorkspaceEdit',
  'explain:start',
  'artifact:list',
  'artifact:get',
  'artifact:create',
  'artifact:comment',
  'wasm:read',

  /**
   * External language servers (pyright, clangd, gopls, rust-analyzer) — see
   * `lsp-registry.ts`. Deliberately its own namespace rather than folded onto
   * `compiler:`: those channels route between the BCC and TypeScript daemons,
   * both of which already own the file; these route to a THIRD kind of
   * language support that never touches `.ts` or `.bcc`, and merging the two
   * would put that routing decision back in the renderer.
   */
  'lsp:status',
  'lsp:openDocument',
  'lsp:changeDocument',
  'lsp:closeDocument',
  'lsp:definition',
  'lsp:references',
  'lsp:hover',

  /**
   * A single active debug session — see `dap-service.ts`. `dap:setBreakpoints`
   * is independent of `dap:start`: breakpoints are workspace state the user
   * sets before a session exists and toggles during one, exactly like VS
   * Code's gutter, so it earns its own channel rather than riding on start.
   */
  'dap:adapters',
  'dap:setBreakpoints',
  'dap:start',
  'dap:continue',
  'dap:stepOver',
  'dap:stepIn',
  'dap:stepOut',
  'dap:stepBack',
  'dap:pause',
  'dap:stop',
  'dap:threads',
  'dap:stackTrace',
  'dap:scopes',
  'dap:variables',
  'dap:evaluate'
] as const

export type InvokeChannel = (typeof INVOKE_CHANNEL_NAMES)[number]

/** Main → renderer, fire-and-forget pushes. Exposed as `onX(listener)`. */
export const EVENT_CHANNEL_NAMES = [
  'fs:watchEvent',
  'terminal:data',
  'terminal:exit',
  'run:stdout',
  'run:stderr',
  'run:exit',
  'git:changed',
  'ai:delta',
  'ai:done',
  // The two halves of the pop-out: state goes out to the floating window (the
  // docked panel already holds what it would carry), reveals come back to the
  // window that owns the editor.
  'visualizer:stateChanged',
  'visualizer:revealRequested',
  'compiler:diagnosticsChanged',
  'compiler:statusChanged',
  'compiler:passCompleted',
  // Payload-free, like `git:changed`: the view re-reads the list itself, so the
  // event cannot carry a snapshot that is already stale by the time it renders.
  'artifact:changed',

  // A server that is not installed, exited too many times, or timed out on a
  // request — the same "reported once" notice `lsp-service.ts` already builds
  // for the console, now with somewhere in the UI to land.
  'lsp:notice',

  // The whole session, replacing itself each time — `null` when nothing is
  // debugging. See `dapSessionStatusSchema`.
  'dap:statusChanged',
  'dap:output',
  'dap:notice'
] as const

export type EventChannel = (typeof EVENT_CHANNEL_NAMES)[number]

/** Splits `"fs:readDir"` into `["fs", "readDir"]`. Shared by bridge and tests. */
export function splitChannel(channel: string): { namespace: string; method: string } {
  const separator = channel.indexOf(':')
  if (separator <= 0 || separator === channel.length - 1) {
    throw new Error(`malformed channel name: ${channel}`)
  }
  return {
    namespace: channel.slice(0, separator),
    method: channel.slice(separator + 1)
  }
}

/**
 * `watchEvent` → `onWatchEvent`. Event subscriptions are named distinctly from
 * invoke methods so a namespace can carry both without collision.
 */
export function eventMethodName(method: string): string {
  return `on${method.charAt(0).toUpperCase()}${method.slice(1)}`
}
