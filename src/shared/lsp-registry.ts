/**
 * Which language server to run for which language, and what to say when it is
 * not installed.
 *
 * Pure, so the choice can be tested without spawning anything — the same reason
 * `planRun` in `runner.ts` takes the toolchain list rather than reaching for it.
 * The two are deliberately parallel: one decides how to RUN a file, this decides
 * what can UNDERSTAND it, and both have to answer "you do not have that
 * installed" as a first-class result rather than by failing.
 *
 * ## Why a table and not discovery
 *
 * There is no registry to query. Every editor that supports LSP ships a list
 * exactly like this one, because a language server's command name, its
 * stdio flag and its arguments are conventions rather than anything
 * discoverable. Keeping it small and explicit is the honest version; pretending
 * to auto-detect would mean guessing.
 *
 * ## Adding one
 *
 * A new entry needs a command, the argument that puts it on stdio, and an
 * install hint that names where the binary comes from. It needs no code: the
 * client speaks the protocol, not the server.
 */

export interface LspServerSpec {
  /** Stable id, used in diagnostics codes and in the UI. */
  readonly id: string
  /** Human name for messages. */
  readonly displayName: string
  /** Monaco language ids this server handles. */
  readonly languageIds: readonly string[]
  /** Executable, looked up on PATH. */
  readonly command: string
  /**
   * Arguments. Almost always the flag that selects stdio — servers default to
   * other transports and a missing flag looks exactly like a server that
   * started and said nothing.
   */
  readonly args: readonly string[]
  /** File extensions this server should see, without the dot. */
  readonly extensions: readonly string[]
  /** What to tell someone who does not have it. */
  readonly installHint: string
}

/**
 * The servers this client knows how to start.
 *
 * Four, chosen because they are the four the plan names and because between
 * them they cover the languages this editor can already RUN but could not
 * understand — which is the gap Workstream D exists to close.
 */
export const LSP_SERVERS: readonly LspServerSpec[] = [
  {
    id: 'pyright',
    displayName: 'Pyright',
    languageIds: ['python'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['py', 'pyi'],
    installHint: 'Install Pyright with `npm i -g pyright` to get Python diagnostics.'
  },
  {
    id: 'clangd',
    displayName: 'clangd',
    languageIds: ['c', 'cpp'],
    command: 'clangd',
    // Without a compile_commands.json clangd guesses the flags, and says so on
    // every file. Asking it to fall back quietly keeps the Problems panel about
    // the user's code.
    args: ['--background-index', '--log=error'],
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh'],
    installHint: 'Install clangd from LLVM, or via your package manager, for C and C++ diagnostics.'
  },
  {
    id: 'gopls',
    displayName: 'gopls',
    languageIds: ['go'],
    command: 'gopls',
    args: [],
    extensions: ['go'],
    installHint: 'Install gopls with `go install golang.org/x/tools/gopls@latest`.'
  },
  {
    id: 'rust-analyzer',
    displayName: 'rust-analyzer',
    languageIds: ['rust'],
    command: 'rust-analyzer',
    args: [],
    extensions: ['rs'],
    installHint: 'Install rust-analyzer with `rustup component add rust-analyzer`.'
  }
]

/**
 * The server for a language, or null.
 *
 * First match wins and the table has no overlaps today. If two ever claimed one
 * language the answer would need to be a preference rather than an order, and
 * this is where that would go.
 */
export function serverForLanguage(languageId: string): LspServerSpec | null {
  return LSP_SERVERS.find((server) => server.languageIds.includes(languageId)) ?? null
}

/**
 * The server for a file path, by extension.
 *
 * Separate from the language lookup because the two callers differ: the
 * renderer knows Monaco's language id, and main — which watches the filesystem
 * and never loads Monaco — knows only a path.
 */
export function serverForPath(path: string): LspServerSpec | null {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return null

  const extension = path.slice(dot + 1).toLowerCase()
  return LSP_SERVERS.find((server) => server.extensions.includes(extension)) ?? null
}

/**
 * Whether this client, rather than one of the built-in daemons, should serve a
 * language.
 *
 * TypeScript and JavaScript are excluded even though servers exist for them.
 * The TypeScript daemon here has the real program, the real tsconfig and
 * whole-program references — everything Workstream A built — and a second
 * opinion arriving through LSP would produce duplicate diagnostics and a peek
 * view showing every result twice. The same goes for `.bcc`, which has its own
 * daemon.
 *
 * Stating it as a rule rather than by omission matters: someone adding
 * `typescript-language-server` to the table above would otherwise get a
 * plausible-looking regression with no comment explaining it.
 */
const SERVED_ELSEWHERE = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'bcc'])

export function isServedByLsp(languageId: string): boolean {
  if (SERVED_ELSEWHERE.has(languageId)) return false
  return serverForLanguage(languageId) !== null
}
