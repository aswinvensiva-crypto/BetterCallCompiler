import type * as monacoNs from 'monaco-editor'
import * as monaco from 'monaco-editor'
// monaco-editor 0.56 exposes an exports map of `"./*": "./esm/vs/*.js"`, so the
// familiar `monaco-editor/esm/vs/...` specifier resolves to `esm/vs/esm/vs/...`
// and fails. The prefix belongs to the map, not the specifier.
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
// monaco 0.56 moved these off `monaco.languages.typescript`, which is now just
// `{ deprecated: true }`. They live in their own module under `languages`
// (plural) — a different path from the `language` (singular) worker imports
// above, which is easy to mistype into a module that does not exist.
import {
  javascriptDefaults,
  typescriptDefaults
} from 'monaco-editor/languages/features/typescript/register'

/**
 * Monaco worker wiring.
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
  readonly typescriptDefaults: typeof typescriptDefaults
  readonly javascriptDefaults: typeof javascriptDefaults
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
    const ns = monaco
    const register: TsRegister = { typescriptDefaults, javascriptDefaults }

    defineTheme(ns)
    configureLanguageDefaults(register)

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
 * Splits diagnostic duty between Monaco's bundled TS worker and the daemon.
 *
 * Monaco's worker validates every TS/JS model, but it has no tsconfig, no file
 * system and no cross-file resolution — so on a real project every local import
 * yields a false `TS2307 Cannot find module './x'`. Nothing in this app reads
 * those markers, but they are still being drawn.
 *
 * The rule: **syntax for open files is Monaco's, everything else is ours.**
 * Monaco keeps syntactic validation, which is instant and model-local and needs
 * no daemon round trip. Semantic validation is turned off here because the
 * daemon is authoritative — it has the real program, the real config and the
 * whole workspace — and it publishes under its own marker owner, so the two
 * never collide.
 */
function configureLanguageDefaults(register: TsRegister): void {
  if (languageDefaultsConfigured) return

  for (const defaults of [register.typescriptDefaults, register.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({
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

export { monaco }
