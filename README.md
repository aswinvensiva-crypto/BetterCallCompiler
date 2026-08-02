# Aperture

A native, installable IDE that ships as a Windows `.exe`. Monaco for editing, a
real PTY for the terminal, real toolchains for running code, and Claude wired in
with the prompt visible and every edit reversible.

This is **Milestone 1**: a walking skeleton with the AI features, producing a
real installer. It is not a VS Code replacement yet — see
[What M1 is not](#what-m1-is-not).

---

## Prerequisites

| Requirement | Why |
| --- | --- |
| **Node ≥ 20**, npm ≥ 10 | Build toolchain. `electron-vite`, `vitest`, `electron-builder` all run on it. |
| **Git** | The SCM view shells out to it, and `electron-builder` reads the repo. |
| Python 3 *(optional)* | Only to run `.py` files from the IDE. Not needed to build. |
| GCC / G++ *(optional)* | Only to compile and run `.c` / `.cpp` files. |
| GitHub CLI *(optional)* | Insights uses `gh auth token` before falling back to a stored PAT. |

**Visual Studio Build Tools are not required.** The one native dependency,
`node-pty`, is a Node-API addon shipping prebuilt binaries, and Node-API is
ABI-stable across Node and Electron versions. `npmRebuild` is off in
`electron-builder.yml` for exactly that reason. If a native module *without*
prebuilds is ever added, that flag has to come back on and the "Desktop
development with C++" workload becomes a real prerequisite.

---

## Getting started

```bash
npm install
```

```bash
npm run dev
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server + Electron, with HMR on the renderer. |
| `npm run build` | Typechecks both projects, then bundles main, preload and renderer into `out/`. |
| `npm run build:win` | `build`, then produces the installer and portable exe in `dist/`. |
| `npm test` | Unit tests (vitest). |
| `npm run test:e2e` | End-to-end tests against the **built** app, so run `npm run build` first. |
| `npm run typecheck` | `tsc --noEmit` over the node and web projects. |

---

## Verification checklist

The twelve things that have to be true for M1 to be done.

| # | Check | How |
| --- | --- | --- |
| 1 | `npm install` completes; no native rebuild needed | `npm install` |
| 2 | `npm run dev` opens the window with a clean console | Watch devtools; `launch.spec.ts` asserts zero console errors |
| 3 | Open a folder → tree lists it; edit + save clears the dirty dot; reopen shows the saved content | `explorer.spec.ts`, `editor.spec.ts` |
| 4 | `` Ctrl+` `` → a real PowerShell prompt; `node -v` runs; resize reflows | `terminal.spec.ts` |
| 5 | Run a `.js` file → real Node output with ANSI colour; a thrown error's `file:line` is clickable and reveals it in Monaco | `run.spec.ts`, `error-links.test.ts` |
| 6 | Run a `.py` file → real Python; if the Store stub is on PATH, the specific guidance appears | `run.spec.ts`, `toolchains.spec.ts` |
| 7 | SCM shows real `git status` and log; stage + commit works from the UI | `scm.spec.ts` (drives a real repository) |
| 8 | Insights shows the contribution calendar and this repo's commits; degrades to local `git log` without a token | `insights.spec.ts` |
| 9 | Select code → Explain / Find bugs / Improve stream a response tied to the selection; "Context sent" is inspectable | `ai.spec.ts`, `ai.test.ts` |
| 10 | Improve → diff → apply → entry in `.aperture/ai-log.jsonl` → revert restores byte-for-byte | `ai.spec.ts`, `ai.test.ts` |
| 11 | `window.require`, `process` and `module` are `undefined` in devtools; contract-completeness and path-confinement tests pass | `no-node-in-renderer.spec.ts`, `ipc-contract.test.ts`, `path-confinement.test.ts` |
| 12 | `npm run build:win` → `dist/Aperture-Setup-*.exe`, installing per-user with no admin prompt | Both binaries carry `requestedExecutionLevel=asInvoker` |

---

## Keyboard

| Key | Action |
| --- | --- |
| `Ctrl+P` | Go to file (fuzzy over the workspace) |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+F` | Search the workspace |
| `Ctrl+S` | Save |
| `Ctrl+F5` | Save and run the active file |
| `` Ctrl+` `` | Toggle the terminal |
| `Ctrl+K` | Ask the assistant to explain the selection |

`Ctrl+K` only fires when something is selected. With an empty selection it falls
through to Monaco, which treats it as a chord leader — the same as VS Code.

---

## Architecture

```
src/
  shared/    ipc-contract.ts — the channel table, zod schemas, Result<T>
  main/      services: fs, terminal, toolchains, runner, git, github, ai, secrets
  preload/   bridge.ts — the one privileged surface, frozen
  renderer/  plain TypeScript + DOM; Monaco, xterm; no framework
```

### Security invariants

These are enforced by tests, not by convention.

1. **The renderer has no Node.** `contextIsolation: true`, `nodeIntegration: false`,
   `sandbox: true`. An E2E test asserts `window.require`, `process` and `module`
   are all `undefined`.
2. **One privileged surface.** `window.aperture`, frozen, built from the channel
   registry. `ipcRenderer` is never exposed and there is no generic
   `invoke(channel, …)` — renderer code cannot name a channel, only call a
   method that already exists.
3. **Every channel is declared once**, with a zod request and response schema. A
   unit test diffs the table against the registered handler map in both
   directions, so a channel with no entry has no handler.
4. **Paths are confined.** Every incoming path is `resolve`d *and* `realpath`ed
   and rejected if it leaves the workspace, which is what defeats symlinks and
   Windows junctions that point outside while looking like they are inside.
5. **CSP is `connect-src 'none'`.** The renderer makes zero network requests;
   all network access is in main. An E2E test asserts the renderer issues no
   external request while the GitHub view loads.
6. **Secrets are one-way.** `safeStorage` (DPAPI on Windows), with
   `secrets:setKey` / `hasKey` / `clearKey` and deliberately **no** `getKey` —
   and no secret channel declares a response that *could* carry a value. Tests
   assert this against both the table and the live bridge.
7. **Errors never throw across IPC.** Every handler resolves to
   `Result<T> = {ok:true, value} | {ok:false, error:{code, message}}`.

### The AI edit journal

Every applied AI edit appends a line to `.aperture/ai-log.jsonl` in the
workspace, and the prior file contents are snapshotted beside it. The journal is
append-only: a revert adds a second entry naming the first rather than amending
it, because a log you can edit is not evidence of anything.

```json
{"id":"...","timestamp":"...","model":"claude-sonnet-5","mode":"improve","promptHash":"…","file":"src/a.ts","range":"3-5","applied":true,"revertOf":null}
```

`.aperture/` is git-ignored by default. It contains your snapshots — do not
commit it.

---

## Honest constraints

- **SmartScreen.** These builds are unsigned, so Windows will show an
  "unrecognized app" warning. Removing it needs an OV or EV code-signing
  certificate supplied through `CSC_LINK` and `CSC_KEY_PASSWORD`; with OV,
  reputation additionally accrues with download volume, so the warning persists
  for a while even once you are signing.
- **AI needs your own key and network access.** There is no proxy and no hosted
  tier. Without a key the assistant shows an affordance pointing at Settings,
  not an error.
- **Real compiler execution requires real compilers.** The hybrid runner softens
  this — it says exactly what is missing and what to install — but it does not
  remove it. M1 bundles the HTML runtime only; the *mechanism* ships, its
  offline coverage does not.
- **The bundled web runtime does not execute scripts.** That is invariant 5, not
  an omission: `script-src 'self'` forbids running workspace code in the
  renderer's origin, and a `srcdoc` iframe inherits its parent's policy. Script
  execution needs an out-of-process runtime.
- **"Parity with VS Code" on debugging and IntelliSense means speaking the same
  open protocols** — DAP and LSP — and that is a long tail across M2–M5. M1
  IntelliSense is Monaco's word-based completion plus the bundled TS/JS worker.

---

## What M1 is not

Not built, and deliberately not stubbed to look like they work:

- **Debugger.** The output console is a streaming console, not a debug session.
  DAP (`vscode-js-debug`, `debugpy`, gdb/lldb) is M2.
- **REST/GraphQL client.** M3.
- **Real language servers** (pyright, clangd, tsserver, terraform-ls). M4.
- **Bundled Python and C++ interpreters.** M4.
- **Repo-wide embedding index** for cross-file semantic AI. Deferred.
- **Auto-update, themes editor, keybindings UI, extension host.** M5.

The activity bar renders anything not yet built as disabled rather than
silently inert.
