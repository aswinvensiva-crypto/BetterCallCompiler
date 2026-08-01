import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNEL_NAMES,
  INVOKE_CHANNEL_NAMES,
  eventMethodName,
  splitChannel
} from '../shared/ipc-channels'
// Type-only: erased at build time, so no zod reaches the sandboxed preload.
import type { ApertureApi } from '../shared/ipc-contract'

/**
 * The single privileged surface exposed to the renderer.
 *
 * Four properties hold no matter how large the tables grow:
 *
 *   1. `ipcRenderer` is never exposed.
 *   2. There is no generic `invoke(channel, ...)`. Each method closes over a
 *      channel name taken from the registry, so renderer code cannot name a
 *      channel — it can only call a method that already exists.
 *   3. Event listeners receive the payload alone. The `IpcRendererEvent` is
 *      dropped on the floor, because it carries `sender` and would hand the
 *      renderer a route back into main.
 *   4. The exposed object and every namespace on it are frozen.
 *
 * The only runtime import is the zero-dependency channel registry — see
 * `src/shared/ipc-channels.ts` for why the schemas deliberately live elsewhere.
 */
type Namespace = Record<string, unknown>

function buildApi(): ApertureApi {
  const namespaces = new Map<string, Namespace>()

  const groupFor = (namespace: string): Namespace => {
    let group = namespaces.get(namespace)
    if (group === undefined) {
      group = {}
      namespaces.set(namespace, group)
    }
    return group
  }

  for (const channel of INVOKE_CHANNEL_NAMES) {
    const { namespace, method } = splitChannel(channel)
    groupFor(namespace)[method] = (request: unknown) => ipcRenderer.invoke(channel, request)
  }

  for (const channel of EVENT_CHANNEL_NAMES) {
    const { namespace, method } = splitChannel(channel)
    groupFor(namespace)[eventMethodName(method)] = (listener: (payload: unknown) => void) => {
      const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
      ipcRenderer.on(channel, wrapped)
      return () => {
        ipcRenderer.removeListener(channel, wrapped)
      }
    }
  }

  const api: Record<string, unknown> = {}
  for (const [namespace, group] of namespaces) {
    api[namespace] = Object.freeze(group)
  }

  return Object.freeze(api) as ApertureApi
}

contextBridge.exposeInMainWorld('aperture', buildApi())
