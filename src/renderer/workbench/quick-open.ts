import { openQuickPick, type QuickPickItem } from './quick-pick'
import { notifyError } from './notifications'
import { openFile } from '../editor/models'
import type { FileNode } from '../../shared/types'

/**
 * `Ctrl+P` — fuzzy open over the workspace file list.
 *
 * The list is fetched once and filtered in the renderer. Round-tripping to main
 * per keystroke would put IPC latency between the user and every character they
 * type, which is exactly the thing quick open exists to avoid.
 */

let cache: FileNode[] = []
let cachedAt = 0
let loading: Promise<FileNode[]> | null = null

/**
 * The cache is invalidated by the filesystem watcher rather than by a timer, so
 * a file created a moment ago is openable immediately. The age check is only a
 * backstop for changes the watcher cannot see (a folder ignored by the watch,
 * an external tool moving a whole tree).
 */
const MAX_CACHE_AGE_MS = 60_000

export function invalidateFileCache(): void {
  cache = []
  cachedAt = 0
}

async function loadFiles(): Promise<FileNode[]> {
  if (cache.length > 0 && Date.now() - cachedAt < MAX_CACHE_AGE_MS) return cache
  if (loading !== null) return await loading

  loading = window.betterCallCompiler.fs
    .listFiles({})
    .then((result) => {
      loading = null
      if (!result.ok) {
        notifyError(result.error.message)
        return []
      }
      cache = result.value.files
      cachedAt = Date.now()
      return cache
    })
    .catch(() => {
      loading = null
      return []
    })

  return await loading
}

interface FileItem extends QuickPickItem {
  readonly node: FileNode
}

export async function openQuickOpen(): Promise<void> {
  const files = await loadFiles()

  if (files.length === 0) {
    notifyError('Open a folder first.')
    return
  }

  // Matched on the relative path, not just the name: typing `views/run` should
  // find it, and two `index.ts` files are otherwise indistinguishable.
  const items: FileItem[] = files.map((node) => ({
    id: node.path,
    label: node.relativePath,
    node
  }))

  openQuickPick<FileItem>({
    placeholder: 'Go to file',
    items,
    onAccept: (item) => {
      void openFile(item.node)
    }
  })
}

/** Wires the cache to the watcher. Called once at boot. */
export function watchForFileChanges(): void {
  window.betterCallCompiler.fs.onWatchEvent((event) => {
    if (event.type === 'add' || event.type === 'unlink' || event.type === 'addDir' || event.type === 'unlinkDir') {
      invalidateFileCache()
    }
  })
}
