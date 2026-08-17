/**
 * Language inference from the file extension.
 *
 * Imports NOTHING — not even a type. That is the point of the file rather than a
 * happy accident: `views/run.ts` needs exactly this lookup and nothing else from
 * the editor, and `workbench/panel.ts` pulls run.ts onto the boot path. While
 * this table lived in monaco-setup.ts, that single call was an edge from the
 * boot path into a module with Monaco statically linked at its first line.
 *
 * Monaco can guess a language from a model URI for known extensions, but being
 * explicit keeps the status bar honest and lets us cover the extensions the
 * toolchain probe cares about.
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
