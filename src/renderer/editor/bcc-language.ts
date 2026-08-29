import type * as monacoNs from 'monaco-editor'
import { KEYWORDS } from '../../lang/token'

/**
 * Registers BCC with Monaco.
 *
 * Without this the editor still works — an unknown language id gives an
 * unstyled model rather than an error — but a `.bcc` file renders as grey text
 * in an IDE that is claiming to understand the language. The squiggle is the
 * milestone; this is what makes the file look like source code underneath it.
 *
 * ## The keyword list is imported, not copied
 *
 * `KEYWORDS` comes from `src/lang/token.ts`, so adding a keyword to the
 * language colours it here automatically. A hand-maintained copy would drift,
 * and drift in a highlighter is the kind of bug nobody files: the word simply
 * stops being blue and everyone assumes it was always that way.
 *
 * This is a Monarch tokenizer rather than a bridge to the real lexer. Monarch
 * runs per visible line on the UI thread and must be re-entrant from any line
 * start; `tokenize` scans a whole file from offset zero and returns spans. They
 * answer different questions, and the honest cost of that is this table having
 * to agree with the lexer about what an operator is. Only the keyword list is
 * shared because only the keyword list is a list.
 */

const LANGUAGE_ID = 'bcc'

let registered = false

export function registerBccLanguage(ns: typeof monacoNs): void {
  if (registered) return
  registered = true

  ns.languages.register({ id: LANGUAGE_ID, extensions: ['.bcc'], aliases: ['BCC', 'bcc'] })

  ns.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['(', ')']
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' }
    ]
  })

  ns.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    keywords: [...KEYWORDS.keys()],
    // `int` and `bool` are not keywords — the parser accepts any identifier as
    // a type name and lets Part 4 decide which ones exist. They are coloured as
    // types because that is what they are to a reader, not to the grammar.
    typeKeywords: ['int', 'bool', 'unit'],
    tokenizer: {
      root: [
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@typeKeywords': 'type',
              '@default': 'identifier'
            }
          }
        ],
        [/\d+/, 'number'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/->/, 'operator'],
        [/[=!<>]=|&&|\|\|/, 'operator'],
        [/[-+*/%=!<>]/, 'operator'],
        [/[{}()]/, '@brackets'],
        [/[,;:]/, 'delimiter'],
        [/\s+/, 'white']
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment']
      ]
    }
  })
}
