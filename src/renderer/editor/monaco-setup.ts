import type * as monacoNs from 'monaco-editor'
// monaco-editor 0.56 exposes an exports map of `"./*": "./esm/vs/*.js"`, so the
// familiar `monaco-editor/esm/vs/...` specifier resolves to `esm/vs/esm/vs/...`
// and fails. The prefix belongs to the map, not the specifier.
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { registerBccLanguage } from './bcc-language'
import { registerNavigationProviders } from './navigation-providers'

/**
 * Monaco worker wiring.
 *
 * These five imports and the assignment below stay STATIC, and that is
 * load-bearing rather than an oversight now that Monaco itself is dynamic. Vite
 * emits each `?worker` as its own asset, and the imported binding is a small
 * constructor referencing that URL — so they do not drag Monaco's core back into
 * the entry chunk. Making them dynamic risks Vite falling back to a blob: worker,
 * which `script-src 'self'` refuses. MonacoEnvironment must also be installed
 * before Monaco's module body runs, which module scope guarantees and a lazy path
 * does not.
 *
 * Monaco's default loader fetches workers from a CDN or builds them from a blob
 * URL. Both are dead ends here: `connect-src 'none'` forbids the former and
 * `script-src 'self'` forbids the latter, since a blob: worker does not match
 * `'self'`. Vite's `?worker` import instead emits each worker as a real asset
 * inside the bundle, so it loads from our own origin and satisfies the policy
 * untouched. This is the whole reason the renderer is served over `app://`
 * rather than `file://` — see `installAppProtocol` in main.
 */
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

const THEME = 'bettercallcompiler-dark'

/**
 * The subset of `monaco-editor/languages/features/typescript/register` used here.
 *
 * Named structurally rather than as `typeof import(...)` so that
 * `configureLanguageDefaults` states what it needs instead of what module it
 * happens to come from.
 */
interface TsRegister {
  readonly typescriptDefaults: LanguageDefaults
  readonly javascriptDefaults: LanguageDefaults
}

/** Only the two methods this module calls. */
interface LanguageDefaults {
  setDiagnosticsOptions(options: {
    noSemanticValidation: boolean
    noSyntaxValidation: boolean
    noSuggestionDiagnostics: boolean
  }): void
  setModeConfiguration(configuration: ModeConfiguration): void
}

/**
 * Which of Monaco's own TypeScript providers are registered.
 *
 * Every field is required here even though Monaco's type marks them optional,
 * because `setModeConfiguration` REPLACES the object rather than merging into
 * it — an omitted field is `undefined`, which reads as off. Requiring all
 * thirteen turns that trap into a compile error and makes the table below the
 * complete statement of who answers what.
 */
interface ModeConfiguration {
  readonly completionItems: boolean
  readonly hovers: boolean
  readonly documentSymbols: boolean
  readonly definitions: boolean
  readonly references: boolean
  readonly documentHighlights: boolean
  readonly rename: boolean
  readonly diagnostics: boolean
  readonly documentRangeFormattingEdits: boolean
  readonly signatureHelp: boolean
  readonly onTypeFormattingEdits: boolean
  readonly codeActions: boolean
  readonly inlayHints: boolean
}

/**
 * The loaded Monaco namespace, and the promise that is loading it.
 *
 * Two accessors rather than one, because the callers genuinely differ. Anything
 * that can wait uses `loadMonaco`. `markers.ts` cannot: it is driven straight
 * from an IPC event handler, so it asks `monacoRuntime()` and takes its existing
 * not-yet-available path when the answer is null.
 *
 * `loading` is what makes concurrent callers share one load. Without it, an
 * editor mount racing a file open would evaluate Monaco's module body twice.
 */
let runtime: typeof monacoNs | null = null
let loading: Promise<typeof monacoNs> | null = null

/** The runtime if it is already here, and null if it is not. Never waits. */
export function monacoRuntime(): typeof monacoNs | null {
  return runtime
}

/**
 * Loads Monaco, configures it, and remembers it.
 *
 * Idempotent through `loading` rather than through a boolean, so a second caller
 * arriving mid-load waits for the first one's promise instead of starting again.
 */
export function loadMonaco(): Promise<typeof monacoNs> {
  if (runtime !== null) return Promise.resolve(runtime)
  if (loading !== null) return loading

  loading = (async () => {
    // Both in parallel: the register module pulls Monaco's TypeScript language
    // support, which is the largest single part of the payload, and serialising
    // the two would add its latency to the editor's first paint for nothing.
    const [ns, register] = await Promise.all([
      import('monaco-editor'),
      // `languages` plural here, and `language` singular in the worker imports
      // above. Different modules; the wrong one does not exist.
      import('monaco-editor/languages/features/typescript/register') as Promise<TsRegister>
    ])

    defineTheme(ns)
    configureLanguageDefaults(register)
    registerBccLanguage(ns)
    // After the language is registered, necessarily: a provider registered for
    // an unknown language id binds to nothing and never fires again.
    registerNavigationProviders(ns)

    runtime = ns
    return ns
  })()

  return loading
}

let themeDefined = false

/** Matches the workbench palette so the editor does not look bolted on. */
function defineTheme(ns: typeof monacoNs): void {
  if (themeDefined) return
  ns.editor.defineTheme(THEME, {
    base: 'vs-dark',
    inherit: true,
    // `rules: []` inherited vs-dark's syntax colours wholesale, which is half of
    // why the editor read as VS Code however the chrome was painted. These are
    // IntelliJ New UI Dark's token colours, taken from expUI_darkScheme.xml.
    // They are NOT Darcula's — the two palettes differ deliberately (New UI
    // keyword #cf8e6d vs Darcula #cc7832) and mixing them never quite lands.
    rules: [
      { token: '', foreground: 'bcbec4' },
      { token: 'keyword', foreground: 'cf8e6d' },
      { token: 'keyword.control', foreground: 'cf8e6d' },
      { token: 'keyword.operator', foreground: 'bcbec4' },
      { token: 'string', foreground: '6aab73' },
      { token: 'string.escape', foreground: 'cf8e6d' },
      { token: 'string.invalid', foreground: 'db5c5c' },
      { token: 'number', foreground: '2aacb8' },
      { token: 'number.hex', foreground: '2aacb8' },
      { token: 'regexp', foreground: '6aab73' },
      // Only the doc comment is italic in IntelliJ; ordinary comments are not.
      { token: 'comment', foreground: '7a7e85' },
      { token: 'comment.doc', foreground: '5f826b', fontStyle: 'italic' },
      // Darcula and New UI both leave class names at the plain text colour —
      // there is no DEFAULT_CLASS_NAME override in either scheme.
      { token: 'type', foreground: 'bcbec4' },
      { token: 'type.identifier', foreground: 'bcbec4' },
      { token: 'identifier', foreground: 'bcbec4' },
      { token: 'variable', foreground: 'bcbec4' },
      { token: 'variable.predefined', foreground: 'c77dbb' },
      { token: 'constant', foreground: 'c77dbb', fontStyle: 'italic' },
      { token: 'function', foreground: '56a8f5' },
      { token: 'delimiter', foreground: 'bcbec4' },
      { token: 'operator', foreground: 'bcbec4' },
      { token: 'tag', foreground: 'cf8e6d' },
      { token: 'metatag', foreground: 'cf8e6d' },
      { token: 'attribute.name', foreground: 'bcbec4' },
      { token: 'attribute.value', foreground: '6aab73' },
      { token: 'key', foreground: 'c77dbb' },
      { token: 'invalid', foreground: 'db5c5c' }
    ],
    colors: {
      'editor.background': '#121314',
      'editor.foreground': '#bcbec4',
      'editorLineNumber.foreground': '#4b5059',
      'editorLineNumber.activeForeground': '#a1a3ab',
      'editor.selectionBackground': '#214283',
      'editor.lineHighlightBackground': '#1a1c1f',
      'editorCursor.foreground': '#ced0d6',
      'editorIndentGuide.background1': '#26292d',
      'editorIndentGuide.activeBackground1': '#5a5d63',
      'editorWidget.background': '#1a1c1e',
      'editorWidget.border': '#0e0f10',
      'editorSuggestWidget.background': '#1a1c1e',
      'editorSuggestWidget.border': '#0e0f10',
      'editorSuggestWidget.selectedBackground': '#2c2f33',
      'editorHoverWidget.background': '#1a1c1e',
      'editorHoverWidget.border': '#0e0f10',
      'editorGutter.background': '#141517',
      // IntelliJ renders a deleted-line marker in grey, not red.
      'editorGutter.addedBackground': '#549159',
      'editorGutter.modifiedBackground': '#375fad',
      'editorGutter.deletedBackground': '#868a91',
      'editorOverviewRuler.border': '#0e0f10',
      'minimap.background': '#121314',
      'scrollbarSlider.background': '#2f333880',
      'scrollbarSlider.hoverBackground': '#3f444b',
      'scrollbarSlider.activeBackground': '#4e535a',
      'editorBracketMatch.background': '#2c2f33',
      'editorBracketMatch.border': '#5a5d63',
      'diffEditor.insertedTextBackground': '#54915926',
      'diffEditor.removedTextBackground': '#db5c5c26'
    }
  })
  themeDefined = true
}

export interface EditorHandle {
  readonly editor: monacoNs.editor.IStandaloneCodeEditor
}

let languageDefaultsConfigured = false

/**
 * Splits the work between Monaco's bundled TS worker and our daemon, and says
 * so in one table instead of leaving it to whatever node_modules defaults to.
 *
 * **The rule: anything answerable from one model's own text is Monaco's;
 * anything needing the whole program is ours.**
 *
 * Monaco's worker has no tsconfig, no file system and no cross-file resolution,
 * so on a real project every local import yields a false
 * `TS2307 Cannot find module './x'`. That makes its SEMANTIC answers wrong by
 * construction for anything that crosses a file, and it is why semantic
 * validation is off below. It makes its single-file answers perfectly good, and
 * instant, and never queued behind a check — which is why the outline and the
 * formatter stay with it rather than crossing to the daemon.
 *
 * ## A correction to the audit that started this
 *
 * The grep that opened Workstream A — zero hits for
 * `registerDocumentSymbolProvider`, `registerDocumentFormattingEditProvider`
 * and their siblings — covered `src/` only, and was over-read as "this IDE has
 * no outline and no formatting". It does, for TypeScript and JavaScript:
 * Monaco's TS contribution registers them from inside node_modules the first
 * time a `.ts` model appears. What genuinely had none was BCC, which is a
 * language Monaco learned about at runtime and has no worker for — so A1 built
 * those providers and this file is where the boundary between the two is
 * written down.
 *
 * Stating the whole table explicitly costs thirteen lines and buys two things.
 * The current split is visible in our source rather than inherited from a
 * dependency's defaults, and moving a feature to the daemon later — A3 takes
 * `definitions` and `references`, A5 takes `hovers`, `completionItems` and
 * `signatureHelp` — is a one-word diff a reviewer can see, instead of a second
 * provider silently answering the same question and Monaco merging both.
 */
function configureLanguageDefaults(register: TsRegister): void {
  if (languageDefaultsConfigured) return

  const modeConfiguration: ModeConfiguration = {
    // Single-file and syntactic. Monaco's, and instant.
    documentSymbols: true,
    documentRangeFormattingEdits: true,
    onTypeFormattingEdits: true,
    documentHighlights: true,
    // Syntactic validation only — see `setDiagnosticsOptions` below. Turning
    // this off would take the squiggles for a missing brace with it.
    diagnostics: true,

    // Correct only with the program, but keystroke-frequency: an IPC round trip
    // per character is not affordable until A5 gives them their own worker.
    // Monaco's answers are single-file and therefore right about local code and
    // wrong about anything imported, which is the better of the two failures
    // while the alternative is nothing at all.
    completionItems: true,
    hovers: true,
    signatureHelp: true,
    inlayHints: true,

    // Ours. The daemon has the real program, so its answers cross files and
    // Monaco's cannot — and leaving Monaco's on as well would have it merge
    // both lists and turn a clean F12 jump into a peek showing the same line
    // twice. `rename` and `codeActions` follow in A4 for the same reason.
    definitions: false,
    references: false,
    rename: true,
    codeActions: true
  }

  for (const defaults of [register.typescriptDefaults, register.javascriptDefaults]) {
    defaults.setModeConfiguration(modeConfiguration)
    defaults.setDiagnosticsOptions({
      // The daemon is authoritative: it has the real program, the real config
      // and the whole workspace, and it publishes under its own marker owner so
      // the two can never collide.
      noSemanticValidation: true,
      // `noSyntaxValidation`, not `noSyntacticValidation` — the option is
      // spelled differently from the LanguageService method it mirrors, and a
      // typo here is silently ignored rather than rejected.
      noSyntaxValidation: false,
      noSuggestionDiagnostics: true
    })
  }

  languageDefaultsConfigured = true
}

export async function createEditor(
  host: HTMLElement
): Promise<monacoNs.editor.IStandaloneCodeEditor> {
  const ns = await loadMonaco()

  return ns.editor.create(host, {
    theme: THEME,
    model: null,
    automaticLayout: true,
    // JetBrains Mono is IntelliJ's default and is used when present; the rest
    // of the stack is the fallback for a machine that does not have it.
    fontFamily: 'JetBrains Mono, Cascadia Code, Cascadia Mono, Consolas, monospace',
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: true, renderCharacters: false },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    tabSize: 2,
    fixedOverflowWidgets: true,
    padding: { top: 8 }
  })
}

