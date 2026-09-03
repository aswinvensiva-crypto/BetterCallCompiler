import type * as monacoNs from 'monaco-editor'

/**
 * The one place that knows how a workspace-relative path becomes a model URI.
 *
 * Both directions live here because both are used and they must agree. Monaco
 * keys models by URI, so the forward direction is what dedupes tabs; the
 * navigation providers need the reverse, to tell the daemon which file a model
 * is. Two hand-rolled copies of `bettercallcompiler:///${encodeURI(path)}` would
 * work until the first path containing a space or a `#`, at which point the
 * provider would ask about a file that does not exist and F12 would silently do
 * nothing.
 *
 * The custom scheme is deliberate rather than `file:`. A `file:` model makes
 * Monaco's bundled TypeScript worker try to resolve imports against a file
 * system it does not have, and the renderer has no file system at all.
 */
const SCHEME = 'bettercallcompiler'

export function documentUri(ns: typeof monacoNs, relativePath: string): monacoNs.Uri {
  return ns.Uri.parse(`${SCHEME}:///${encodeURI(relativePath)}`)
}

/**
 * The workspace-relative path a model URI names, or null for a URI this app did
 * not create — Monaco makes its own models for the diff widget and for
 * `inmemory:` scratch buffers, and asking the daemon about one of those would
 * be a query for a file that has never existed.
 */
export function relativePathFromUri(uri: monacoNs.Uri): string | null {
  if (uri.scheme !== SCHEME) return null
  const path = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path
  if (path === '') return null
  try {
    return decodeURI(path)
  } catch {
    // A malformed percent-escape cannot have come from `documentUri`, so there
    // is no file behind it to ask about.
    return null
  }
}
