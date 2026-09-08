import { describe, expect, it } from 'vitest'
import {
  createMessageReader,
  encodeMessage,
  MAX_BUFFERED_BYTES,
  type FramedMessage
} from '../../src/shared/jsonrpc-framing'

/**
 * The framing LSP and DAP share.
 *
 * Almost every case here is about a byte stream arriving in pieces the sender
 * chose and the receiver cannot predict. A framer that works when each write
 * happens to be one whole message will pass a naive test suite and fail against
 * a real server within minutes, so the split cases are the point rather than
 * an edge.
 */

const encoder = new TextEncoder()

function bytes(text: string): Uint8Array {
  return encoder.encode(text)
}

function frame(json: string): string {
  return `Content-Length: ${encoder.encode(json).length}\r\n\r\n${json}`
}

function bodiesOf(messages: readonly FramedMessage[]): string[] {
  return messages.map((message) => message.body)
}

describe('encoding', () => {
  it('writes a Content-Length header and the JSON body', () => {
    const framed = new TextDecoder().decode(encodeMessage({ jsonrpc: '2.0', id: 1 }))
    expect(framed).toBe('Content-Length: 24\r\n\r\n{"jsonrpc":"2.0","id":1}')
  })

  it('counts BYTES, not characters', () => {
    /*
     * The bug this exists to prevent. `é` is one character and two bytes; a
     * length taken from `string.length` would be short, the reader would leave
     * the tail in its buffer, and every message after this one would be read
     * from the wrong offset. The failure presents as "the server broke after a
     * while", which is nowhere near the encoding.
     */
    const framed = encodeMessage({ hover: 'café — 日本語' })
    const text = new TextDecoder().decode(framed)
    const declared = Number(/Content-Length: (\d+)/.exec(text)?.[1])
    const body = text.slice(text.indexOf('\r\n\r\n') + 4)

    expect(declared).toBe(encoder.encode(body).length)
    expect(declared).toBeGreaterThan(body.length)
  })

  it('round trips through the reader, multibyte included', () => {
    // Multibyte deliberately: this is the pair that has to agree, and an
    // ASCII-only round trip would pass with the length taken from either.
    const value = { method: 'initialize', id: 7, note: 'café — 日本語 🎉' }
    const reader = createMessageReader()
    const { messages } = reader.push(encodeMessage(value))

    expect(JSON.parse(messages[0]?.body ?? 'null')).toEqual(value)
    expect(reader.buffered()).toBe(0)
  })
})

describe('reading whole messages', () => {
  it('reads one', () => {
    const reader = createMessageReader()
    const { messages, problems } = reader.push(bytes(frame('{"id":1}')))

    expect(bodiesOf(messages)).toEqual(['{"id":1}'])
    expect(problems).toEqual([])
    expect(reader.buffered()).toBe(0)
  })

  it('reads several arriving in one chunk', () => {
    const reader = createMessageReader()
    const { messages } = reader.push(bytes(frame('{"id":1}') + frame('{"id":2}') + frame('{"id":3}')))
    expect(bodiesOf(messages)).toEqual(['{"id":1}', '{"id":2}', '{"id":3}'])
  })

  it('exposes headers lowercased, whatever case they arrived in', () => {
    // Both spellings occur in the wild; a caller should not have to know.
    const reader = createMessageReader()
    const { messages } = reader.push(
      bytes('content-length: 8\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{"id":1}')
    )

    expect(messages[0]?.headers.get('content-length')).toBe('8')
    expect(messages[0]?.headers.get('content-type')).toBe('application/vscode-jsonrpc')
  })
})

describe('messages split across chunks', () => {
  it('waits for a body that has not all arrived', () => {
    const reader = createMessageReader()

    const first = reader.push(bytes('Content-Length: 8\r\n\r\n{"id'))
    expect(first.messages).toEqual([])
    expect(first.problems).toEqual([])
    expect(reader.buffered()).toBeGreaterThan(0)

    const second = reader.push(bytes('":1}'))
    expect(bodiesOf(second.messages)).toEqual(['{"id":1}'])
    expect(reader.buffered()).toBe(0)
  })

  it('waits for a header block split mid-line', () => {
    const reader = createMessageReader()
    expect(reader.push(bytes('Content-Len')).messages).toEqual([])
    expect(reader.push(bytes('gth: 8\r\n')).messages).toEqual([])
    expect(bodiesOf(reader.push(bytes('\r\n{"id":1}')).messages)).toEqual(['{"id":1}'])
  })

  it('survives being fed one byte at a time', () => {
    /*
     * The strongest statement of the property, and the cheapest. Any offset
     * bug, any assumption that a chunk boundary lines up with a field, shows up
     * here and nowhere else.
     */
    const stream = bytes(frame('{"id":1}') + frame('{"method":"café"}') + frame('{"id":3}'))
    const reader = createMessageReader()
    const collected: string[] = []

    for (const byte of stream) {
      collected.push(...bodiesOf(reader.push(new Uint8Array([byte])).messages))
    }

    expect(collected).toEqual(['{"id":1}', '{"method":"café"}', '{"id":3}'])
    expect(reader.buffered()).toBe(0)
  })

  it('handles a multibyte character straddling a chunk boundary', () => {
    const json = '{"s":"日本語"}'
    const stream = bytes(frame(json))
    const reader = createMessageReader()

    // Split inside the three bytes of 日 — a decoder run per chunk would
    // produce a replacement character here.
    const cut = stream.length - 6
    reader.push(stream.slice(0, cut))
    const { messages } = reader.push(stream.slice(cut))

    expect(bodiesOf(messages)).toEqual([json])
  })
})

describe('junk in the stream', () => {
  /*
   * Servers write things to stdout that are not protocol: a deprecation warning
   * from the runtime, a log line, a crash trace. Dying on the first one would
   * take the session down for something the server considers harmless.
   */

  it('skips a log line before a message', () => {
    const reader = createMessageReader()
    const { messages, problems } = reader.push(
      bytes(`[info] starting up\n${frame('{"id":1}')}`)
    )

    expect(bodiesOf(messages)).toEqual(['{"id":1}'])
    expect(problems.map((problem) => problem.reason)).toEqual(['skipped-non-protocol-bytes'])
  })

  it('skips a header block that is not a message', () => {
    const reader = createMessageReader()
    const { messages, problems } = reader.push(
      bytes(`X-Something: 1\r\n\r\n${frame('{"id":1}')}`)
    )

    expect(bodiesOf(messages)).toEqual(['{"id":1}'])
    expect(problems.map((problem) => problem.reason)).toEqual(['skipped-non-protocol-bytes'])
  })

  it('refuses a Content-Length with no value rather than reading it as zero', () => {
    /*
     * `Number('')` is 0, so a lenient parse takes this as a legitimate empty
     * body and frames every following message from the wrong offset — silent,
     * and the damage starts one message later than the cause.
     */
    const reader = createMessageReader()
    const { messages, problems } = reader.push(
      bytes(`Content-Length:\r\n\r\n${frame('{"id":1}')}`)
    )

    expect(bodiesOf(messages)).toEqual(['{"id":1}'])
    expect(problems.map((problem) => problem.reason)).toEqual(['invalid-content-length'])
  })

  it('discards a frame whose Content-Length is not a number', () => {
    // A header that parses and lies has no safe interpretation: believing it
    // would misalign every message after it.
    const reader = createMessageReader()
    const { messages, problems } = reader.push(
      bytes(`Content-Length: banana\r\n\r\n${frame('{"id":1}')}`)
    )

    expect(bodiesOf(messages)).toEqual(['{"id":1}'])
    expect(problems.map((problem) => problem.reason)).toEqual(['invalid-content-length'])
  })

  it('recovers the rest of the stream after junk between two messages', () => {
    const reader = createMessageReader()
    const { messages } = reader.push(
      bytes(`${frame('{"id":1}')}Warning: deprecated\n${frame('{"id":2}')}`)
    )
    expect(bodiesOf(messages)).toEqual(['{"id":1}', '{"id":2}'])
  })

  it('does not discard a partial header that could still complete', () => {
    /*
     * `Content-Le` at the end of a chunk is half a header, not junk. A reader
     * that threw it away would break against any server that happens to flush
     * mid-header — which is a property of the server's buffering, so it would
     * look intermittent.
     */
    const reader = createMessageReader()
    const first = reader.push(bytes('Content-Le'))

    expect(first.problems).toEqual([])
    expect(reader.buffered()).toBe(10)
    expect(bodiesOf(reader.push(bytes('ngth: 8\r\n\r\n{"id":1}')).messages)).toEqual(['{"id":1}'])
  })

  it('drops trailing bytes that cannot become a header', () => {
    const reader = createMessageReader()
    const { problems } = reader.push(bytes('total nonsense with no header in it'))

    expect(problems.map((problem) => problem.reason)).toEqual(['skipped-non-protocol-bytes'])
    expect(reader.buffered()).toBe(0)
  })
})

describe('bounds and lifecycle', () => {
  it('drops the buffer rather than growing without limit', () => {
    /*
     * A server emitting a bogus enormous Content-Length, or a stream with no
     * terminator, would otherwise grow this until the process dies in the
     * allocator — nowhere near anything that names the cause.
     */
    const reader = createMessageReader()
    const huge = new Uint8Array(MAX_BUFFERED_BYTES + 1)
    huge.fill(65)

    const { messages, problems } = reader.push(huge)
    expect(messages).toEqual([])
    expect(problems.map((problem) => problem.reason)).toEqual(['buffer-overflow'])
    expect(reader.buffered()).toBe(0)
  })

  it('forgets a half-read message on reset', () => {
    // After a restart the old server's half-message must not be read as the
    // new one's header.
    const reader = createMessageReader()
    reader.push(bytes('Content-Length: 8\r\n\r\n{"id'))
    expect(reader.buffered()).toBeGreaterThan(0)

    reader.reset()
    expect(reader.buffered()).toBe(0)
    expect(bodiesOf(reader.push(bytes(frame('{"id":9}'))).messages)).toEqual(['{"id":9}'])
  })

  it('reads a zero-length body', () => {
    const reader = createMessageReader()
    const { messages } = reader.push(bytes('Content-Length: 0\r\n\r\n'))
    expect(bodiesOf(messages)).toEqual([''])
  })
})
