import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPrompt,
  describeAiError,
  extractCodeBlock,
  hashPrompt,
  renderContext,
  setAiProvider,
  startAiStream,
  cancelAiStream,
  setAiEmitters,
  type AiProvider
} from '../../src/main/ai-service'
import { applyAiEdit, readAiLog, resetAiLogForTests, revertAiEdit } from '../../src/main/ai-log'
import { resetForTests, setWorkspace } from '../../src/main/fs-service'
import {
  extractCodeBlock as extractInRenderer,
  findEnclosingSymbol,
  collectImports,
  spliceSelection
} from '../../src/renderer/editor/code-context'
import { INVOKE_CHANNEL_NAMES } from '../../src/shared/ipc-contract'
import type { AiContext, AiDone, AiStreamDelta } from '../../src/shared/types'

const CONTEXT: AiContext = {
  filePath: 'C:\\work\\src\\a.ts',
  relativePath: 'src/a.ts',
  languageId: 'typescript',
  selection: {
    text: 'return a + b',
    startLine: 4,
    startColumn: 3,
    endLine: 4,
    endColumn: 15
  },
  enclosingSymbol: { name: 'add', kind: 'function', text: 'function add(a, b) {\n  return a + b\n}' },
  imports: ["import { z } from 'zod'"]
}

/* ------------------------------------------------------------------ *
 * Prompts and context
 * ------------------------------------------------------------------ */

describe('prompt assembly', () => {
  it('renders every part of the context into the message', () => {
    const rendered = renderContext(CONTEXT)

    expect(rendered).toContain('src/a.ts')
    expect(rendered).toContain('typescript')
    expect(rendered).toContain('lines 4-4')
    expect(rendered).toContain("import { z } from 'zod'")
    expect(rendered).toContain('Enclosing function: add')
    expect(rendered).toContain('return a + b')
  })

  /**
   * The transparency claim depends on this exactly: the panel shows what
   * `buildPrompt` produced, so the rendered context and the sent message have
   * to be the same string, not two renderings that agree today.
   */
  it('sends precisely what the Context sent panel is given', () => {
    const { user } = buildPrompt('explain', CONTEXT)
    expect(user).toBe(renderContext(CONTEXT))
  })

  it('omits the sections that have no content', () => {
    const bare = renderContext({ ...CONTEXT, enclosingSymbol: null, imports: [] })
    expect(bare).not.toContain('Enclosing')
    expect(bare).not.toContain('Imports in this file')
    expect(bare).toContain('Selected code:')
  })

  it('gives each mode a different system prompt', () => {
    const explain = buildPrompt('explain', CONTEXT).system
    const bugs = buildPrompt('find-bugs', CONTEXT).system
    const improve = buildPrompt('improve', CONTEXT).system

    expect(new Set([explain, bugs, improve]).size).toBe(3)
  })

  // Without this instruction a model asked for bugs reliably invents them.
  it('tells the reviewer to say "No defects found" rather than invent one', () => {
    const system = buildPrompt('find-bugs', CONTEXT).system
    expect(system).toContain('No defects found.')
    expect(system).toContain('never invent')
  })

  it('tells improve to reply with one fenced block that replaces the selection', () => {
    const system = buildPrompt('improve', CONTEXT).system
    expect(system).toContain('fenced code block')
    expect(system).toContain('replaces the selection')
  })
})

describe('prompt hashing', () => {
  it('is stable for the same prompt and different for a changed one', () => {
    const a = buildPrompt('explain', CONTEXT)
    const b = buildPrompt('explain', CONTEXT)
    expect(hashPrompt(a.system, a.user)).toBe(hashPrompt(b.system, b.user))

    const other = buildPrompt('find-bugs', CONTEXT)
    expect(hashPrompt(a.system, a.user)).not.toBe(hashPrompt(other.system, other.user))
  })

  it('does not embed the source it hashes', () => {
    const { system, user } = buildPrompt('explain', CONTEXT)
    const hash = hashPrompt(system, user)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(hash).not.toContain('return')
  })
})

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

describe('error mapping', () => {
  it('turns the status codes that matter into sentences a user can act on', () => {
    expect(describeAiError({ status: 401 })).toContain('Settings')
    expect(describeAiError({ status: 403 })).toContain('not permitted')
    expect(describeAiError({ status: 429 })).toContain('Rate limited')
    expect(describeAiError({ status: 503 })).toContain('server error')
  })

  it('names a network failure as one', () => {
    expect(describeAiError({ name: 'APIConnectionError' })).toContain('network')
    expect(describeAiError({ name: 'APIConnectionTimeoutError' })).toContain('timed out')
  })

  it('never returns an empty message', () => {
    for (const error of [null, undefined, {}, new Error(''), 'boom']) {
      expect(describeAiError(error).length).toBeGreaterThan(0)
    }
  })
})

/* ------------------------------------------------------------------ *
 * Improve: the block, and splicing it back
 * ------------------------------------------------------------------ */

describe('code block extraction', () => {
  it('takes the first fenced block and ignores the rationale after it', () => {
    const answer =
      'Here is the rewrite:\n\n```ts\nconst x = 1\n```\n\n- renamed things\n- ```not code```'
    expect(extractCodeBlock(answer)).toBe('const x = 1')
  })

  it('keeps interior blank lines', () => {
    expect(extractCodeBlock('```\na\n\nb\n```')).toBe('a\n\nb')
  })

  it('returns null when there is no block, so nothing can be applied', () => {
    expect(extractCodeBlock('No defects found.')).toBeNull()
    expect(extractCodeBlock('```\n\n```')).toBeNull()
    expect(extractCodeBlock('')).toBeNull()
  })

  // Two copies exist, one per process; they must agree.
  it('agrees between the main and renderer copies', () => {
    for (const answer of ['```js\nlet a\n```', 'no block', '```\n \n```', '```ts\nx\n```\ntail']) {
      expect(extractInRenderer(answer)).toBe(extractCodeBlock(answer))
    }
  })
})

describe('splicing a rewrite into a file', () => {
  const source = 'const a = 1\nfunction add(a, b) {\n  return a + b\n}\nexport { add }'

  it('replaces exactly the selected range', () => {
    const spliced = spliceSelection(
      source,
      { startLine: 3, startColumn: 3, endLine: 3, endColumn: 15 },
      'return a + b + 0'
    )
    expect(spliced).toBe(
      'const a = 1\nfunction add(a, b) {\n  return a + b + 0\n}\nexport { add }'
    )
  })

  /**
   * The reason this is positional rather than a string replace: `x` occurs
   * three times here, and replacing the wrong one is a silent corruption a diff
   * preview would not obviously reveal.
   */
  it('replaces the selected occurrence, not the first matching one', () => {
    const repeated = 'x\nx\nx'
    const spliced = spliceSelection(
      repeated,
      { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 },
      'y'
    )
    expect(spliced).toBe('x\ny\nx')
  })

  it('handles a multi-line selection', () => {
    const spliced = spliceSelection(
      source,
      { startLine: 2, startColumn: 1, endLine: 4, endColumn: 2 },
      'const add = (a, b) => a + b'
    )
    expect(spliced).toBe('const a = 1\nconst add = (a, b) => a + b\nexport { add }')
  })

  it('clamps a range that runs past the end of the file', () => {
    expect(() =>
      spliceSelection('a', { startLine: 99, startColumn: 99, endLine: 99, endColumn: 99 }, 'b')
    ).not.toThrow()
  })
})

/* ------------------------------------------------------------------ *
 * Context assembly
 * ------------------------------------------------------------------ */

describe('import collection', () => {
  it('finds ES imports and CommonJS requires', () => {
    const source = "import a from 'a'\nconst b = require('b')\nconst c = 1\n"
    expect(collectImports(source, 'javascript')).toEqual([
      "import a from 'a'",
      "const b = require('b')"
    ])
  })

  it('finds python imports in both spellings', () => {
    expect(collectImports('import os\nfrom sys import argv\nx = 1\n', 'python')).toEqual([
      'import os',
      'from sys import argv'
    ])
  })

  it('finds C includes', () => {
    expect(collectImports('#include <stdio.h>\nint main(){}\n', 'c')).toEqual(['#include <stdio.h>'])
  })

  it('returns nothing for a language it does not know', () => {
    expect(collectImports('anything', 'plaintext')).toEqual([])
  })
})

describe('enclosing symbol', () => {
  const ts = [
    "import { z } from 'zod'",
    '',
    'export function add(a: number, b: number): number {',
    '  return a + b',
    '}',
    '',
    'export class Widget {',
    '  render() {',
    '    return 1',
    '  }',
    '}'
  ].join('\n')

  it('finds the function containing a line', () => {
    const symbol = findEnclosingSymbol(ts, 'typescript', 4)
    expect(symbol?.name).toBe('add')
    expect(symbol?.kind).toBe('function')
    expect(symbol?.startLine).toBe(3)
    expect(symbol?.endLine).toBe(5)
  })

  // Symbols nest, and the useful context is the tightest one.
  it('prefers the innermost symbol over the class around it', () => {
    const symbol = findEnclosingSymbol(ts, 'typescript', 9)
    expect(symbol?.name).toBe('render')
  })

  it('finds a python def by indentation', () => {
    const python = ['import os', '', 'def boom():', '    raise ValueError()', '', 'x = 1'].join('\n')
    const symbol = findEnclosingSymbol(python, 'python', 4)
    expect(symbol?.name).toBe('boom')
    expect(symbol?.startLine).toBe(3)
    expect(symbol?.endLine).toBe(4)
  })

  it('returns null outside any declaration', () => {
    expect(findEnclosingSymbol(ts, 'typescript', 1)).toBeNull()
  })

  it('returns null for a language it cannot parse', () => {
    expect(findEnclosingSymbol('anything at all', 'plaintext', 1)).toBeNull()
  })

  // A brace inside a string must not unbalance the scan and swallow the file.
  it('ignores braces inside string literals', () => {
    const tricky = ['function f() {', '  const s = "}"', '  return s', '}', 'const after = 1'].join(
      '\n'
    )
    expect(findEnclosingSymbol(tricky, 'typescript', 3)?.endLine).toBe(4)
  })
})

/* ------------------------------------------------------------------ *
 * Streaming, against a stub provider
 * ------------------------------------------------------------------ */

describe('streaming', () => {
  const deltas: AiStreamDelta[] = []
  const dones: AiDone[] = []

  beforeEach(() => {
    deltas.length = 0
    dones.length = 0
    setAiEmitters(
      (payload) => deltas.push(payload),
      (payload) => dones.push(payload)
    )
  })

  function stubProvider(behaviour: (request: Parameters<AiProvider['stream']>[0]) => Promise<{ stopReason: string | null }>): void {
    setAiProvider({ id: 'stub', stream: behaviour })
  }

  it('reports the prompt and context before any token arrives', async () => {
    stubProvider(async () => new Promise(() => ({ stopReason: null })))

    const started = await startAiStream('explain', CONTEXT)

    expect(started.contextSent).toBe(renderContext(CONTEXT))
    expect(started.systemPrompt.length).toBeGreaterThan(0)
    expect(started.promptHash).toMatch(/^[0-9a-f]{16}$/)
    expect(deltas).toEqual([])
  })

  it('forwards text deltas keyed by the stream id', async () => {
    stubProvider(async (request) => {
      request.onText('hel')
      request.onText('lo')
      return { stopReason: 'end_turn' }
    })

    const started = await startAiStream('explain', CONTEXT)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(deltas.map((d) => d.text).join('')).toBe('hello')
    expect(deltas.every((d) => d.streamId === started.streamId)).toBe(true)
    expect(dones[0]?.stopReason).toBe('end_turn')
    expect(dones[0]?.error).toBeNull()
  })

  it('maps a provider failure to a human message on done', async () => {
    stubProvider(async () => {
      throw Object.assign(new Error('nope'), { status: 401 })
    })

    await startAiStream('explain', CONTEXT)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(dones[0]?.error).toContain('Settings')
    expect(dones[0]?.cancelled).toBe(false)
  })

  it('cancels through the abort signal and reports it as cancelled, not failed', async () => {
    stubProvider(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )

    const started = await startAiStream('explain', CONTEXT)
    expect(cancelAiStream(started.streamId)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(dones[0]?.cancelled).toBe(true)
    expect(dones[0]?.error).toBeNull()
  })

  it('reports nothing to cancel for an unknown stream', () => {
    expect(cancelAiStream('ai-does-not-exist')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * The provenance journal
 * ------------------------------------------------------------------ */

describe('the AI edit journal', () => {
  let workspace = ''

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'aperture-ailog-'))
    await setWorkspace(workspace)
    resetAiLogForTests()
  })

  afterEach(async () => {
    await resetForTests()
    if (workspace !== '') await rm(workspace, { recursive: true, force: true })
  })

  async function seed(name: string, content: string): Promise<string> {
    const path = join(workspace, name)
    await mkdir(join(workspace), { recursive: true })
    await writeFile(path, content, 'utf8')
    return path
  }

  it('writes the file and records the edit', async () => {
    const path = await seed('a.ts', 'before\n')

    const entry = await applyAiEdit({
      path,
      content: 'after\n',
      mode: 'improve',
      model: 'claude-sonnet-5',
      promptHash: 'abc123',
      range: '1-1'
    })

    expect(await readFile(path, 'utf8')).toBe('after\n')
    expect(entry.applied).toBe(true)
    expect(entry.file).toBe('a.ts')
    expect(entry.promptHash).toBe('abc123')
    expect(entry.revertOf).toBeNull()

    const log = await readAiLog()
    expect(log).toHaveLength(1)
    expect(log[0]?.id).toBe(entry.id)
  })

  it('restores the previous contents byte for byte', async () => {
    const original = 'line one\r\nline two\n\ttabbed\n'
    const path = await seed('b.ts', original)

    const entry = await applyAiEdit({
      path,
      content: 'replaced',
      mode: 'improve',
      model: 'm',
      promptHash: 'h',
      range: '1-3'
    })
    expect(await readFile(path, 'utf8')).toBe('replaced')

    await revertAiEdit(entry.id)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  // The journal's value is that it is evidence, so a revert is a second fact
  // rather than an edit to the first.
  it('appends the revert instead of rewriting the original entry', async () => {
    const path = await seed('c.ts', 'x')
    const applied = await applyAiEdit({
      path,
      content: 'y',
      mode: 'improve',
      model: 'm',
      promptHash: 'h',
      range: '1-1'
    })
    const reverted = await revertAiEdit(applied.id)

    const log = await readAiLog()
    expect(log).toHaveLength(2)
    expect(log[0]?.applied).toBe(true)
    expect(log[0]?.id).toBe(applied.id)
    expect(log[1]?.applied).toBe(false)
    expect(log[1]?.revertOf).toBe(applied.id)
    expect(reverted.revertOf).toBe(applied.id)
  })

  it('refuses to revert twice', async () => {
    const path = await seed('d.ts', 'x')
    const applied = await applyAiEdit({
      path,
      content: 'y',
      mode: 'improve',
      model: 'm',
      promptHash: 'h',
      range: '1-1'
    })
    await revertAiEdit(applied.id)
    await expect(revertAiEdit(applied.id)).rejects.toThrow(/already reverted/)
  })

  it('refuses to revert something it never applied', async () => {
    await expect(revertAiEdit('nope')).rejects.toThrow(/no applied AI edit/)
  })

  it('refuses to write outside the workspace', async () => {
    await expect(
      applyAiEdit({
        path: join(workspace, '..', 'escape.ts'),
        content: 'x',
        mode: 'improve',
        model: 'm',
        promptHash: 'h',
        range: '1-1'
      })
    ).rejects.toThrow()
  })

  // The file is append-only text a user may well open; one bad line must not
  // cost the whole history.
  it('survives a malformed line in the journal', async () => {
    const path = await seed('e.ts', 'x')
    await applyAiEdit({
      path,
      content: 'y',
      mode: 'improve',
      model: 'm',
      promptHash: 'h',
      range: '1-1'
    })

    const logFile = join(workspace, '.aperture', 'ai-log.jsonl')
    const existing = await readFile(logFile, 'utf8')
    await writeFile(logFile, `not json\n${existing}{"partial":true}\n`, 'utf8')

    expect(await readAiLog()).toHaveLength(1)
  })

  it('reports an empty journal for a workspace that has none', async () => {
    expect(await readAiLog()).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * The boundary
 * ------------------------------------------------------------------ */

describe('the AI channel surface', () => {
  it('declares exactly the AI channels, and no way to read the key', () => {
    const ai = INVOKE_CHANNEL_NAMES.filter((channel) => channel.startsWith('ai:')).sort()
    expect(ai).toEqual(['ai:apply', 'ai:cancel', 'ai:log', 'ai:revert', 'ai:start'])
  })
})
