import { openQuickPick, type QuickPickItem } from './quick-pick'
import { notifyError } from './notifications'

/**
 * The command registry and `Ctrl+Shift+P`.
 *
 * Commands are registered by the features that own them rather than listed
 * here, so a palette entry cannot describe something the feature no longer
 * does. `when` lets a command be hidden rather than shown and then failing —
 * "Commit" with no repository open is noise, not an option.
 */

export interface Command {
  readonly id: string
  readonly title: string
  /** Shown dimmed, e.g. `Ctrl+Shift+P`. */
  readonly keybinding?: string
  /** Hidden from the palette when this returns false. */
  readonly when?: () => boolean
  readonly run: () => void | Promise<void>
}

const commands = new Map<string, Command>()

export function registerCommand(command: Command): void {
  commands.set(command.id, command)
}

export function registerCommands(list: readonly Command[]): void {
  for (const command of list) registerCommand(command)
}

/** Everything currently applicable, for the palette and for tests. */
export function availableCommands(): Command[] {
  return [...commands.values()]
    .filter((command) => command.when === undefined || command.when())
    .sort((a, b) => a.title.localeCompare(b.title))
}

export async function runCommand(id: string): Promise<void> {
  const command = commands.get(id)
  if (command === undefined) return
  try {
    await command.run()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : `${id} failed`)
  }
}

interface CommandItem extends QuickPickItem {
  readonly command: Command
}

export function openCommandPalette(): void {
  const items: CommandItem[] = availableCommands().map((command) => ({
    id: command.id,
    label: command.title,
    hint: command.keybinding ?? '',
    command
  }))

  openQuickPick<CommandItem>({
    placeholder: 'Type a command name',
    items,
    onAccept: (item) => void runCommand(item.command.id)
  })
}

/** Test hook: the registry is module state shared across views. */
export function resetCommandsForTests(): void {
  commands.clear()
}
