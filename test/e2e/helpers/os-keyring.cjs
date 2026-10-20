/**
 * Puts the OS keyring back under Playwright.
 *
 * Playwright's Electron loader appends `--password-store=basic` to every app it
 * launches. Windows and macOS ignore that switch, but on Linux it pins
 * safeStorage to its plain-text backend, so `isEncryptionAvailable()` reports
 * false even with a keyring running. Settings then disables key entry, and the
 * key-storage specs fail on a switch the app never asked for.
 *
 * Preloaded with `-r` after Playwright's own loader, this drops the switch
 * before safeStorage first reads it, so Chromium picks the backend it would in
 * a normal launch. Where no keyring exists that is still the plain-text
 * backend, and the specs fail exactly as they should.
 */
require('electron').app.commandLine.removeSwitch('password-store')
