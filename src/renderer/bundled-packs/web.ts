/**
 * Bundled runtime packs.
 *
 * The hybrid model's second half: when no real toolchain is on PATH, the
 * renderer runs the file itself. M1 ships exactly one pack — the web runtime —
 * and the registry beneath it is the seam that keeps bundled packs and real
 * toolchains interchangeable as coverage grows.
 *
 * Written as `.ts` rather than the `web.js` the target layout names, because the
 * renderer is a TypeScript project and a lone `.js` would need `allowJs` turned
 * on for one file.
 *
 * What this pack does NOT do is execute scripts, and that is a deliberate
 * consequence of security invariant 6 rather than an omission. The renderer's
 * CSP is `script-src 'self'`, which forbids `eval`, `new Function` and inline
 * script in any document sharing this origin — including a `srcdoc` iframe,
 * which inherits its parent's policy. Running untrusted workspace code inside
 * the privileged renderer would mean relaxing the one invariant that makes the
 * preload boundary worth anything. Script execution belongs in an
 * out-of-process runtime, which is a later milestone; until then the pack is
 * honest about being a markup-and-styles preview and says so on screen.
 */

export interface PackContext {
  /** Absolute path of the file being run. */
  readonly filePath: string
  readonly relativePath: string
  /** Appends to the output console. `\n` is translated for xterm. */
  readonly write: (stream: 'stdout' | 'stderr', text: string) => void
  /** Element the pack may render visual output into. Hidden when unused. */
  readonly preview: HTMLElement
}

export interface BundledPack {
  readonly id: string
  readonly label: string
  readonly languages: readonly string[]
  /** Resolves with a process-style exit code: 0 is success. */
  run(context: PackContext): Promise<number>
}

const webPack: BundledPack = {
  id: 'web',
  label: 'Web (HTML/CSS)',
  languages: ['html'],

  async run(context: PackContext): Promise<number> {
    const result = await window.betterCallCompiler.fs.readFile({ path: context.filePath })
    if (!result.ok) {
      context.write('stderr', `Could not read ${context.relativePath}: ${result.error.message}\n`)
      return 1
    }

    const frame = document.createElement('iframe')
    frame.className = 'run-preview__frame'
    frame.title = `Preview of ${context.relativePath}`
    // Empty sandbox: no scripts, no same-origin, no forms, no top navigation.
    // Belt and braces alongside the CSP — this frame gets an opaque origin, so
    // even if the policy were loosened, `'self'` would still match nothing here.
    frame.setAttribute('sandbox', '')
    frame.srcdoc = result.value.content

    context.preview.replaceChildren(frame)
    context.preview.hidden = false

    context.write('stdout', `Rendered ${context.relativePath} in the bundled web runtime.\n`)
    context.write(
      'stdout',
      '[2mScripts are not executed: the renderer CSP forbids running workspace ' +
        'code in-process. Markup and styles render normally.[0m\n'
    )
    return 0
  }
}

const PACKS: readonly BundledPack[] = [webPack]

export function packById(id: string): BundledPack | null {
  return PACKS.find((pack) => pack.id === id) ?? null
}

