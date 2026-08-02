import * as monaco from 'monaco-editor'
// monaco-editor 0.56 exposes an exports map of `"./*": "./esm/vs/*.js"`, so the
// familiar `monaco-editor/esm/vs/...` specifier resolves to `esm/vs/esm/vs/...`
// and fails. The prefix belongs to the map, not the specifier.
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

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

const THEME = 'aperture-dark'

let themeDefined = false

/** Matches the workbench palette so the editor does not look bolted on. */
function defineTheme(): void {
  if (themeDefined) return
  monaco.editor.defineTheme(THEME, {
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

/**
 * Language inference from the file extension. Monaco can guess from a model URI
 * for known extensions, but being explicit keeps the status bar honest and lets
 * us cover the extensions the toolchain probe cares about.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  pyw: 'python',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  sql: 'sql',
  tf: 'hcl',
  dockerfile: 'dockerfile'
}

export function languageForFile(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile'
  if (lower === 'makefile') return 'plaintext'

  const dot = lower.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return LANGUAGE_BY_EXTENSION[lower.slice(dot + 1)] ?? 'plaintext'
}

export interface EditorHandle {
  readonly editor: monaco.editor.IStandaloneCodeEditor
}

export function createEditor(host: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  defineTheme()

  return monaco.editor.create(host, {
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
