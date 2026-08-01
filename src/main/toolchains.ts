import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * PATH resolution shared by the terminal (step 5) and the toolchain probe
 * (step 6).
 *
 * Deliberately not `where`/`which`: shelling out to resolve a program costs a
 * process spawn per lookup, and on Windows `where` returns *every* match
 * including non-executable ones. Walking PATH with PATHEXT is both faster and
 * gives us the resolved path we need for Store-stub detection.
 */
export function findOnPath(command: string): string | null {
  const pathVar = process.env['PATH'] ?? process.env['Path'] ?? ''
  if (pathVar === '') return null

  const extensions =
    process.platform === 'win32'
      ? [
          '',
          ...(process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .filter((ext) => ext !== '')
        ]
      : ['']

  for (const directory of pathVar.split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      try {
        accessSync(candidate, constants.F_OK)
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Not here; keep looking.
      }
    }
  }

  return null
}

/**
 * Resolves the shell to run in a terminal, preferring PowerShell 7 over Windows
 * PowerShell over anything else. `$SHELL` is respected on POSIX.
 */
export function resolveShell(): { file: string; name: string } {
  if (process.platform === 'win32') {
    for (const candidate of ['pwsh.exe', 'powershell.exe']) {
      const found = findOnPath(candidate)
      if (found !== null) return { file: found, name: candidate.replace(/\.exe$/i, '') }
    }
    const comspec = process.env['ComSpec']
    if (comspec !== undefined && comspec !== '') return { file: comspec, name: 'cmd' }
    return { file: 'cmd.exe', name: 'cmd' }
  }

  const shell = process.env['SHELL']
  if (shell !== undefined && shell !== '') {
    const name = shell.slice(shell.lastIndexOf('/') + 1)
    return { file: shell, name }
  }
  return { file: '/bin/bash', name: 'bash' }
}
