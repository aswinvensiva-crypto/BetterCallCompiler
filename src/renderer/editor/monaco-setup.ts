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
    rules: [],
    colors: {
      'editor.background': '#1b1d23',
      'editor.foreground': '#d7dae0',
      'editorLineNumber.foreground': '#5b6270',
      'editorLineNumber.activeForeground': '#9aa1ad',
      'editor.selectionBackground': '#2d3b52',
      'editor.lineHighlightBackground': '#21242b',
      'editorCursor.foreground': '#4c9df3',
      'editorIndentGuide.background1': '#2b2f38',
      'editorWidget.background': '#22252c',
      'editorWidget.border': '#3d434f',
      'editorGutter.background': '#1b1d23'
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
    fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
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
