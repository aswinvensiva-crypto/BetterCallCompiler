import type { SecretKeyName, SecretsState, Settings } from '../../shared/types'
import { notify, notifyError } from '../workbench/notifications'

/**
 * The settings view.
 *
 * The rule that shapes every control here: **a stored key is never displayed**.
 * The renderer can learn that a key exists and nothing more — there is no
 * `secrets:getKey`, so there is nothing to render even if this file wanted to.
 * Each secret shows presence, a field to replace it, and a way to remove it.
 */

let titleHost: HTMLElement | null = null
let bodyHost: HTMLElement | null = null

let settings: Settings = { aiModel: 'claude-sonnet-5', githubUser: '', telemetry: false }
let secrets: SecretsState = { anthropic: false, github: false, encryptionAvailable: true }

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/* -------------------------------- secrets -------------------------------- */

interface SecretFieldOptions {
  readonly key: SecretKeyName
  readonly label: string
  readonly hint: string
  readonly placeholder: string
  readonly stored: boolean
}

function secretField(options: SecretFieldOptions): HTMLElement {
  const wrap = el('div', 'settings-field')

  const header = el('div', 'settings-field__header')
  header.append(el('label', 'settings-field__label', options.label))

  const state = el(
    'span',
    `settings-badge settings-badge--${options.stored ? 'set' : 'unset'}`,
    options.stored ? 'stored' : 'not set'
  )
  header.append(state)
  wrap.append(header)

  wrap.append(el('p', 'settings-field__hint', options.hint))

  const row = el('div', 'settings-field__row')

  const input = el('input', 'settings-input')
  input.type = 'password'
  input.autocomplete = 'off'
  input.spellcheck = false
  // The stored value is never loaded into this field — it cannot be. The
  // placeholder says what the field would replace, not what is in it.
  input.placeholder = options.stored ? 'Replace stored key…' : options.placeholder
  input.disabled = !secrets.encryptionAvailable
  row.append(input)

  const save = el('button', 'button button--primary', 'Save')
  save.type = 'button'
  save.disabled = !secrets.encryptionAvailable
  save.addEventListener('click', () => {
    const value = input.value.trim()
    if (value === '') return
    // Clear the field immediately: the plaintext should not linger in the DOM
    // any longer than the round trip needs it.
    input.value = ''
    void storeSecret(options.key, value)
  })
  row.append(save)

  if (options.stored) {
    const remove = el('button', 'button', 'Remove')
    remove.type = 'button'
    remove.addEventListener('click', () => void removeSecret(options.key))
    row.append(remove)
  }

  wrap.append(row)
  return wrap
}

async function storeSecret(key: SecretKeyName, value: string): Promise<void> {
  const result = await window.betterCallCompiler.secrets.setKey({ key, value })
  if (!result.ok) {
    notifyError(result.error.message)
    return
  }
  secrets = result.value.secrets
  notify(`${key === 'anthropic' ? 'Anthropic key' : 'GitHub token'} saved.`, 'info')
  render()
}

async function removeSecret(key: SecretKeyName): Promise<void> {
  const result = await window.betterCallCompiler.secrets.clearKey({ key })
  if (!result.ok) {
    notifyError(result.error.message)
    return
  }
  secrets = result.value.secrets
  render()
}

/* ------------------------------- preferences ------------------------------ */

async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const result = await window.betterCallCompiler.settings.set({ patch })
  if (!result.ok) {
    notifyError(result.error.message)
    return
  }
  settings = result.value.settings
}

function textField(
  label: string,
  hint: string,
  value: string,
  placeholder: string,
  commit: (next: string) => void
): HTMLElement {
  const wrap = el('div', 'settings-field')
  wrap.append(el('label', 'settings-field__label', label))
  wrap.append(el('p', 'settings-field__hint', hint))

  const input = el('input', 'settings-input')
  input.type = 'text'
  input.value = value
  input.placeholder = placeholder
  input.spellcheck = false
  // Commit on blur and on Enter rather than per keystroke: writing the file on
  // every character would be a lot of disk churn for no benefit.
  input.addEventListener('change', () => commit(input.value.trim()))
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur()
  })
  wrap.append(input)
  return wrap
}

/* --------------------------------- render -------------------------------- */

function render(): void {
  if (bodyHost === null || titleHost === null) return

  titleHost.replaceChildren(el('span', 'side-bar__heading', 'Settings'))
  bodyHost.replaceChildren()

  if (!secrets.encryptionAvailable) {
    // Never silently store a "secret" in the clear.
    bodyHost.append(
      el(
        'p',
        'insights-notice',
        'This system did not offer a secure credential store, so keys cannot be saved. ' +
          'On Linux this usually means no keyring is running.'
      )
    )
  }

  bodyHost.append(el('h3', 'settings-group', 'Keys'))

  bodyHost.append(
    secretField({
      key: 'anthropic',
      label: 'Anthropic API key',
      hint: 'Used by the assistant. Encrypted with the OS credential store and never shown again.',
      placeholder: 'sk-ant-…',
      stored: secrets.anthropic
    })
  )

  bodyHost.append(
    secretField({
      key: 'github',
      label: 'GitHub personal access token',
      hint: 'Only used when the GitHub CLI is not signed in. Needs the read:user scope for the contribution calendar.',
      placeholder: 'github_pat_…',
      stored: secrets.github
    })
  )

  bodyHost.append(el('h3', 'settings-group', 'Preferences'))

  bodyHost.append(
    textField(
      'GitHub username',
      'Whose contribution calendar to show. Leave blank to use the signed-in account.',
      settings.githubUser,
      'octocat',
      (next) => void patchSettings({ githubUser: next })
    )
  )

  bodyHost.append(
    textField(
      'Assistant model',
      'Claude model used for Explain, Find bugs and Improve.',
      settings.aiModel,
      'claude-sonnet-5',
      (next) => {
        if (next !== '') void patchSettings({ aiModel: next })
      }
    )
  )
}

/* --------------------------------- mount --------------------------------- */

async function load(): Promise<void> {
  const [settingsResult, secretsResult] = await Promise.all([
    window.betterCallCompiler.settings.get({}),
    window.betterCallCompiler.secrets.hasKey({})
  ])

  if (settingsResult.ok) settings = settingsResult.value.settings
  if (secretsResult.ok) secrets = secretsResult.value.secrets
  render()
}

export async function mountSettings(title: HTMLElement, body: HTMLElement): Promise<void> {
  titleHost = title
  bodyHost = body
  await load()
}

export function onSettingsShown(): void {
  void load()
}
