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
  'ai:log'
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
  'ai:done'
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
