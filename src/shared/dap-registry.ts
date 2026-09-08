/**
 * Which debug adapter to run for which language, and what to say when it is
 * not installed.
 *
 * Deliberately parallel to `lsp-registry.ts`: a table rather than discovery,
 * for the same reason — a debug adapter's command name and the flag that puts
 * it on stdio are conventions, not anything a client can query for.
 *
 * ## Two adapters, chosen for what they do NOT need
 *
 * `dap-client.ts` speaks the wire protocol against any DAP-compliant adapter
 * reachable over stdio. That is a wider set than what is registered here.
 * `vscode-js-debug` (Node/TypeScript) and `dlv dap` (Go) both exist, but
 * neither is a single stdio-speaking process the way the two below are —
 * `vscode-js-debug` is a multi-session CDP-to-DAP bridge normally launched as
 * a TCP server with a parent/child session dance, and `dlv dap` listens on a
 * TCP port rather than stdio. Registering either would mean guessing at
 * behaviour this client has no way to verify. Two real, stdio-native adapters
 * beat four where two are invented.
 *
 * `commands` is a list, tried in order — `findOnPath` again, not a shell
 * lookup — because `python`/`python3` already has exactly this ambiguity in
 * `toolchains.ts`'s own probe table, and repeating that list here rather than
 * guessing one name is what keeps the two probes agreeing with each other.
 *
 * ## Adding one
 *
 * A new entry needs the candidate commands, the arguments that select stdio
 * DAP mode, the adapter id `initialize` announces, and an install hint. It
 * needs no code: `dap-service.ts` builds the launch config per adapter id,
 * not per entry here.
 */

export interface DapAdapterSpec {
  /** Stable id, used in the UI and to pick a launch-config shape. */
  readonly id: string
  /** Human name for messages. */
  readonly displayName: string
  /** Monaco language ids this adapter can debug. */
  readonly languageIds: readonly string[]
  /** Candidate executable names, most-preferred first — see `findOnPath`. */
  readonly commands: readonly string[]
  /** Arguments that put the adapter on stdio in DAP mode. */
  readonly args: readonly string[]
  /** The `adapterID` sent in `initialize`. */
  readonly adapterId: string
  /** File extensions this adapter should see, without the dot. */
  readonly extensions: readonly string[]
  /** What to tell someone who does not have it. */
  readonly installHint: string
}

/**
 * The adapters this client knows how to start.
 *
 * `python3` before `python`: on a machine with both, `python` is more likely
 * to be a `py2` alias or a Store stub than `python3` is, and there is no cost
 * to trying the more specific name first — the same ordering rationale
 * `toolchains.ts` uses, without repeating its platform branch here since this
 * file is shared with the renderer and stays free of `process`.
 */
export const DAP_ADAPTERS: readonly DapAdapterSpec[] = [
  {
    id: 'debugpy',
    displayName: 'debugpy',
    languageIds: ['python'],
    commands: ['python3', 'python'],
    // Speaks DAP on stdin/stdout with no listen socket — the same shape every
    // other adapter here uses.
    args: ['-m', 'debugpy.adapter'],
    adapterId: 'debugpy',
    extensions: ['py', 'pyi'],
    installHint: 'Install debugpy with `pip install debugpy` to debug Python files.'
  },
  {
    id: 'gdb',
    displayName: 'GDB',
    languageIds: ['c', 'cpp'],
    commands: ['gdb'],
    // GDB 14+ speaks DAP directly over stdio in this mode — no MI translation
    // layer, and no separate `gdbserver` process to manage.
    args: ['--interpreter=dap'],
    adapterId: 'gdb',
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh'],
    installHint:
      'Install GDB 14 or newer (MSYS2, MinGW-w64, or your package manager) to debug C and C++ files.'
  }
]

/**
 * The adapter for a language, or null.
 *
 * First match wins, exactly like `serverForLanguage` in `lsp-registry.ts`;
 * the table has no overlaps today.
 */
export function adapterForLanguage(languageId: string): DapAdapterSpec | null {
  return DAP_ADAPTERS.find((adapter) => adapter.languageIds.includes(languageId)) ?? null
}

/**
 * The adapter for a file path, by extension.
 *
 * Separate from the language lookup for the same reason `serverForPath` is:
 * main watches the filesystem and never loads Monaco, so it knows a path
 * rather than a language id.
 */
export function adapterForPath(path: string): DapAdapterSpec | null {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return null

  const extension = path.slice(dot + 1).toLowerCase()
  return DAP_ADAPTERS.find((adapter) => adapter.extensions.includes(extension)) ?? null
}
