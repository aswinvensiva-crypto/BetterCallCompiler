/**
 * The wire format LSP and DAP both speak.
 *
 * A message is HTTP-shaped: `Content-Length: <n>` and any other headers, a
 * blank line, then exactly `n` BYTES of JSON.
 *
 *     Content-Length: 42\r\n
 *     \r\n
 *     {"jsonrpc":"2.0","id":1,"method":"initialize"}
 *
 * Both protocols use it unchanged, which is why this is one module rather than
 * a copy in each. LSP is JSON-RPC 2.0 over it; DAP is its own request/response
 * shape over it. Neither difference reaches down here.
 *
 * ## Bytes, not characters
 *
 * `Content-Length` counts BYTES. A server replying with a hover containing `é`
 * or a CJK identifier sends a length that does not match `string.length`, and a
 * reader that sliced by character would take too few bytes, leave the tail in
 * the buffer, and then read that tail as the next message's headers. Every
 * message after that one is garbage, and the failure looks like "the language
 * server broke after a while" rather than like an encoding bug. So this module
 * works on `Uint8Array` throughout and decodes only once the exact byte count
 * is in hand.
 *
 * `Uint8Array` rather than `Buffer` because `src/shared` may not import node —
 * and it costs nothing, since a `Buffer` IS a `Uint8Array` and can be pushed in
 * directly.
 *
 * ## It resynchronises rather than dying
 *
 * Language servers write things to stdout that are not protocol. A stray log
 * line, a deprecation warning from the runtime, a crash trace — any of these
 * arrive in the same stream as the messages. A reader that threw on the first
 * unparseable byte would take the whole session down for something the server
 * itself considers harmless.
 *
 * So unrecognised bytes are skipped up to the next plausible header, and
 * reported as a `problem` rather than raised. The caller logs them; the session
 * survives. What is NOT tolerated is a header that parses and lies — a
 * `Content-Length` that is not a number has no safe interpretation, so the
 * frame it introduces is discarded too.
 */

const CONTENT_LENGTH = 'content-length'

/** `\r\n\r\n`, the end of the header block. */
const HEADER_TERMINATOR = new Uint8Array([13, 10, 13, 10])

/**
 * A cap on how much unparsed data may sit in the buffer.
 *
 * Without one, a server that emits an enormous bogus `Content-Length` — or one
 * that writes a stream with no terminator at all — grows this buffer until the
 * process dies, and it dies in the allocator rather than anywhere that names
 * the cause. 32 MB is far past any real message: the largest thing either
 * protocol sends is a completion list or a variables tree, and those are
 * kilobytes.
 */
export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024

export interface FramedMessage {
  /** Lowercased header names; values as sent. */
  readonly headers: ReadonlyMap<string, string>
  /** The body, decoded as UTF-8. Not parsed — the caller owns that. */
  readonly body: string
}

/** Something wrong that did not justify ending the session. */
export interface FramingProblem {
  readonly reason: 'skipped-non-protocol-bytes' | 'invalid-content-length' | 'buffer-overflow'
  readonly detail: string
}

export interface ReadResult {
  readonly messages: readonly FramedMessage[]
  readonly problems: readonly FramingProblem[]
}

export interface MessageReader {
  /** Feed bytes as they arrive; get back whatever completed. */
  push(chunk: Uint8Array): ReadResult
  /** Bytes held pending more input. For tests and for a stall diagnosis. */
  buffered(): number
  /** Drop everything held, after a restart. */
  reset(): void
}

/* -------------------------------------------------------------------------- */
/*  Encoding                                                                   */
/* -------------------------------------------------------------------------- */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

/**
 * A value as a complete framed message.
 *
 * The length is taken from the ENCODED bytes, never from the string, for the
 * reason in the module comment — and getting it wrong on the write side is
 * worse than on the read side, because the server on the other end is not ours
 * to debug.
 */
export function encodeMessage(value: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(value))
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`)

  const framed = new Uint8Array(header.length + body.length)
  framed.set(header, 0)
  framed.set(body, header.length)
  return framed
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** Index of `needle` in `haystack` at or after `from`, or -1. */
function indexOfSequence(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const limit = haystack.length - needle.length
  outer: for (let start = Math.max(0, from); start <= limit; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) continue outer
    }
    return start
  }
  return -1
}

/**
 * Header names are case-insensitive per both specs, and servers do vary —
 * `Content-Length` from most, `content-length` from some. Lowercasing once here
 * means no caller has to remember.
 */
function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>()

  for (const line of block.split('\r\n')) {
    if (line === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }

  return headers
}

/**
 * Where a header block plausibly starts, at or after `from`.
 *
 * Used only to resynchronise after junk. Looking for the literal header name is
 * the strongest signal available in a byte stream that has no other structure,
 * and being wrong is recoverable: a false positive fails to parse and skips
 * again.
 */
function findHeaderStart(buffer: Uint8Array, from: number): number {
  const marker = encoder.encode('Content-Length:')
  const lowered = encoder.encode('content-length:')

  const upper = indexOfSequence(buffer, marker, from)
  const lower = indexOfSequence(buffer, lowered, from)

  if (upper === -1) return lower
  if (lower === -1) return upper
  return Math.min(upper, lower)
}

export function createMessageReader(): MessageReader {
  let buffer = new Uint8Array(0)

  function append(chunk: Uint8Array): void {
    const grown = new Uint8Array(buffer.length + chunk.length)
    grown.set(buffer, 0)
    grown.set(chunk, buffer.length)
    buffer = grown
  }

  function consume(bytes: number): void {
    buffer = buffer.slice(bytes)
  }

  return {
    push(chunk: Uint8Array): ReadResult {
      const messages: FramedMessage[] = []
      const problems: FramingProblem[] = []

      append(chunk)

      if (buffer.length > MAX_BUFFERED_BYTES) {
        const held = buffer.length
        buffer = new Uint8Array(0)
        return {
          messages,
          problems: [
            {
              reason: 'buffer-overflow',
              detail: `dropped ${held} buffered bytes without finding a complete message`
            }
          ]
        }
      }

      for (;;) {
        if (buffer.length === 0) break

        /*
         * Resynchronise BEFORE parsing, not after.
         *
         * The first version looked for the header terminator first and only
         * then checked what it had found. Junk BETWEEN two messages then
         * swallowed the message after it: `Warning: deprecated\n` has no
         * terminator of its own, so the search ran on and found the terminator
         * belonging to the NEXT message's headers, parsed the junk and that
         * header together as one block, decided the block had no
         * Content-Length, and skipped past the body start of a message it had
         * never read. Two tests caught it. Establishing "the buffer begins with
         * a header" first is what lets the rest of the loop assume it.
         */
        const start = findHeaderStart(buffer, 0)

        if (start === -1) {
          // Nothing that could be a header. Keep a tail that might still become
          // one once more arrives; discard the rest.
          if (!mightBecomeHeader(buffer)) {
            problems.push({
              reason: 'skipped-non-protocol-bytes',
              detail: `discarded ${buffer.length} bytes that cannot begin a header`
            })
            buffer = new Uint8Array(0)
          }
          break
        }

        if (start > 0) {
          problems.push({
            reason: 'skipped-non-protocol-bytes',
            detail: `skipped ${start} bytes before the next header`
          })
          consume(start)
          continue
        }

        const terminator = indexOfSequence(buffer, HEADER_TERMINATOR, 0)
        // The header block has not finished arriving. Wait rather than guess.
        if (terminator === -1) break

        const headers = parseHeaders(decoder.decode(buffer.slice(0, terminator)))
        const bodyStart = terminator + HEADER_TERMINATOR.length
        const raw = headers.get(CONTENT_LENGTH)

        /*
         * The buffer began with the header name, so the header is there; what
         * it can still be is unusable. `Content-Length:` with no value is the
         * one that would do real damage quietly — `Number('')` is 0, so a
         * lenient parse reads it as a legitimate empty body and frames every
         * message after it from the wrong offset. Requiring digits refuses it.
         */
        if (raw === undefined || !/^\d+$/.test(raw)) {
          problems.push({
            reason: 'invalid-content-length',
            detail: `Content-Length was ${JSON.stringify(raw ?? null)}`
          })
          // Past this header block; the resync above finds the next real one.
          consume(bodyStart)
          continue
        }

        const length = Number(raw)

        // The body has not all arrived. Leave the headers buffered too, so this
        // same parse repeats and stays idempotent.
        if (buffer.length < bodyStart + length) break

        messages.push({ headers, body: decoder.decode(buffer.slice(bodyStart, bodyStart + length)) })
        consume(bodyStart + length)
      }

      return { messages, problems }
    },

    buffered(): number {
      return buffer.length
    },

    reset(): void {
      buffer = new Uint8Array(0)
    }
  }
}

/**
 * Whether these bytes could still BECOME a header once more arrive.
 *
 * `Content-Le` split across two chunks is not junk, it is half a header, and
 * discarding it would break every message from a server that happens to flush
 * mid-header. Only a buffer that contains no prefix of the header name at its
 * tail can be thrown away safely.
 */
function mightBecomeHeader(buffer: Uint8Array): boolean {
  const name = 'content-length:'
  const tail = decoder.decode(buffer.slice(Math.max(0, buffer.length - name.length))).toLowerCase()

  for (let take = Math.min(tail.length, name.length); take > 0; take--) {
    if (tail.slice(tail.length - take) === name.slice(0, take)) return true
  }
  return false
}
