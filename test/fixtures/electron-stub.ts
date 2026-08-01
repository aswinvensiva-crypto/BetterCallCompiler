/**
 * Minimal stand-in for the `electron` module so main-process code can be unit
 * tested in plain Node. `vitest.config.ts` aliases `electron` to this file.
 *
 * It records what was registered rather than faking behaviour, which is what
 * the contract-completeness test needs to inspect.
 */

export type StubInvokeHandler = (event: unknown, request: unknown) => unknown

const handlers = new Map<string, StubInvokeHandler>()

export const ipcMain = {
  handle(channel: string, handler: StubInvokeHandler): void {
    if (handlers.has(channel)) {
      throw new Error(`duplicate handler registration for ${channel}`)
    }
    handlers.set(channel, handler)
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  }
}

/** Test-only accessors; not part of electron's real surface. */
export function registeredChannels(): string[] {
  return [...handlers.keys()]
}

export function invokeRegistered(channel: string, request: unknown): unknown {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`)
  return handler({}, request)
}

export function resetStub(): void {
  handlers.clear()
}

export const app = {
  getVersion: (): string => '0.1.0-test',
  getPath: (): string => 'C:/tmp/aperture-test',
  isPackaged: false
}

export const BrowserWindow = {
  fromWebContents: (): null => null,
  getAllWindows: (): unknown[] => []
}

export const contextBridge = {
  exposeInMainWorld(): void {
    /* no-op */
  }
}

export const ipcRenderer = {
  invoke: async (): Promise<unknown> => undefined
}

export const shell = {
  openExternal: async (): Promise<void> => undefined
}

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  })
}
