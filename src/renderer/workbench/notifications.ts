/**
 * Toasts and modal confirmations.
 *
 * Step 12 grows this into the full notification centre; for now it exists so
 * failures surface somewhere visible instead of being swallowed, and so the
 * explorer and the tab bar share one confirmation dialog rather than each
 * hand-rolling their own.
 */

type Severity = 'info' | 'warning' | 'error'

let toastHost: HTMLElement | null = null

function ensureHost(): HTMLElement {
  if (toastHost === null || !toastHost.isConnected) {
    toastHost = document.createElement('div')
    toastHost.className = 'toasts'
    document.body.append(toastHost)
  }
  return toastHost
}

export function notify(message: string, severity: Severity = 'info', timeoutMs = 6000): void {
  const host = ensureHost()

  const toast = document.createElement('div')
  toast.className = `toast toast--${severity}`
  toast.setAttribute('role', severity === 'error' ? 'alert' : 'status')

  const text = document.createElement('span')
  text.className = 'toast__text'
  text.textContent = message
  toast.append(text)

  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'toast__dismiss'
  dismiss.setAttribute('aria-label', 'Dismiss')
  dismiss.textContent = '×'
  dismiss.addEventListener('click', () => toast.remove())
  toast.append(dismiss)

  host.append(toast)
  if (timeoutMs > 0) window.setTimeout(() => toast.remove(), timeoutMs)
}

export function notifyError(message: string): void {
  notify(message, 'error', 8000)
}

export interface ConfirmOptions {
  readonly title: string
  readonly detail: string
  readonly confirmLabel: string
  readonly danger?: boolean
  /** Optional third choice, e.g. "Don't Save". Resolves as `'alternate'`. */
  readonly alternateLabel?: string
}

export type ConfirmChoice = 'confirm' | 'cancel' | 'alternate'

export function confirmAction(options: ConfirmOptions): Promise<ConfirmChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'

    const box = document.createElement('div')
    box.className = 'modal'
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')

    const title = document.createElement('h2')
    title.className = 'modal__title'
    title.textContent = options.title
    box.append(title)

    const detail = document.createElement('p')
    detail.className = 'modal__detail'
    detail.textContent = options.detail
    box.append(detail)

    const actions = document.createElement('div')
    actions.className = 'modal__actions'

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'button'
    cancel.textContent = 'Cancel'
    actions.append(cancel)

    let alternate: HTMLButtonElement | null = null
    if (options.alternateLabel !== undefined) {
      alternate = document.createElement('button')
      alternate.type = 'button'
      alternate.className = 'button'
      alternate.textContent = options.alternateLabel
      actions.append(alternate)
    }

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = `button ${options.danger === true ? 'button--danger' : 'button--primary'}`
    confirm.textContent = options.confirmLabel
    actions.append(confirm)

    box.append(actions)
    overlay.append(box)
    document.body.append(overlay)

    const finish = (choice: ConfirmChoice): void => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve(choice)
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish('cancel')
      } else if (event.key === 'Enter') {
        event.preventDefault()
        finish('confirm')
      }
    }

    cancel.addEventListener('click', () => finish('cancel'))
    alternate?.addEventListener('click', () => finish('alternate'))
    confirm.addEventListener('click', () => finish('confirm'))
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish('cancel')
    })
    document.addEventListener('keydown', onKey, true)

    confirm.focus()
  })
}
