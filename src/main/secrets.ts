import { app, safeStorage } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

/**
 * Secret storage, backed by Electron's `safeStorage` (DPAPI on Windows).
 *
 * The security invariant this file exists to hold: **there is no `getKey`**.
 * Nothing here is exported in a shape the preload can reach that returns a
 * plaintext secret, and the IPC table deliberately declares only
 * `secrets:setKey`, `secrets:hasKey` and `secrets:clearKey`. Reading a secret is
 * a main-process-only operation — `readSecret` below is called by ai-service and
 * github-service, never by a handler.
 *
 * That is the whole point: a renderer compromise cannot exfiltrate the user's
 * API key, because there is no code path that would hand it over.
 */

export const SECRET_KEYS = ['anthropic', 'github'] as const
export type SecretKey = (typeof SECRET_KEYS)[number]

export function isSecretKey(value: string): value is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(value)
}

interface SecretsFile {
  /** Base64 of the DPAPI-encrypted blob, per key. */
  readonly [key: string]: string | undefined
}

function secretsPath(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

async function readFile(): Promise<SecretsFile> {
  try {
    const raw = await fsp.readFile(secretsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as SecretsFile
  } catch {
    // Absent or corrupt: an empty store, not an error. A user whose secrets
    // file was damaged should be asked for the key again, not shown a crash.
    return {}
  }
}

async function writeFile(contents: SecretsFile): Promise<void> {
  const path = secretsPath()
  await fsp.mkdir(join(path, '..'), { recursive: true })
  await fsp.writeFile(path, JSON.stringify(contents, null, 2), {
    encoding: 'utf8',
    // Owner-only where the platform honours it. On Windows the real protection
    // is DPAPI: the ciphertext is bound to the user account regardless.
    mode: 0o600
  })
}

/**
 * True when the OS actually offers encryption.
 *
 * On Linux without a keyring this is false, and storing a "secret" would mean
 * writing it in the clear. Refusing is the honest answer — the Settings view
 * surfaces it rather than pretending the key was saved securely.
 */
export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export async function setSecret(key: SecretKey, value: string): Promise<void> {
  const trimmed = value.trim()
  if (trimmed === '') {
    await clearSecret(key)
    return
  }
  if (!isEncryptionAvailable()) {
    throw new Error('the OS did not offer a secure store, so the key was not saved')
  }

  const contents = { ...(await readFile()) }
  contents[key] = safeStorage.encryptString(trimmed).toString('base64')
  await writeFile(contents)
}

export async function hasSecret(key: SecretKey): Promise<boolean> {
  const stored = (await readFile())[key]
  return typeof stored === 'string' && stored !== ''
}

export async function clearSecret(key: SecretKey): Promise<void> {
  const contents = { ...(await readFile()) }
  if (contents[key] === undefined) return
  delete contents[key]
  await writeFile(contents)
}

/**
 * Decrypts a stored secret. **Main process only** — never reachable over IPC.
 *
 * Returns null rather than throwing when the blob cannot be decrypted, which
 * happens legitimately: DPAPI ciphertext is bound to the Windows user account,
 * so a copied profile yields a blob that simply is not readable here.
 */
export async function readSecret(key: SecretKey): Promise<string | null> {
  const stored = (await readFile())[key]
  if (typeof stored !== 'string' || stored === '') return null
  if (!isEncryptionAvailable()) return null

  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null
  }
}
