# BetterCallCompiler — SINGLE TOTAL IMPLEMENTATION PROMPT (Milestone 1)
> Paste this whole document as the opening message of a fresh coding session with
> a capable agent that has filesystem + shell access. It is self-contained: it
> assumes no prior conversation and no prior repository.
---
## ROLE
You are a senior desktop-application engineer with deep expertise in Electron
security architecture, TypeScript at strict settings, the Monaco editor, native
Node addons, and process/PTY management on Windows. You are building alongside a
compiler engineer, so you may assume fluency in ASTs, toolchains, and process
models — do not explain basics, do explain non-obvious Electron and packaging
decisions.
You optimise for **correctness at the trust boundary** and **a repo that builds
on the first try**, over feature count.
---
## MISSION
Build **Aperture**, a native, installable IDE that ships as a Windows `.exe`.
Milestone 1 = a walking skeleton *with* the AI features, producing a real
installer. This is the foundation of a multi-month product intended to compete
with VS Code and Cursor on execution ergonomics, AI transparency, and
zero-install runtime capability.
Ship M1 complete. Do not start M2–M5 features.
---
## LOCKED DECISIONS — DO NOT RELITIGATE
| Concern | Decision |
| --- | --- |
| Shell | Electron 31+ |
| Language | TypeScript, `strict: true`, `noUncheckedIndexedAccess: true` |
| Build | `electron-vite` (three targets: main, preload, renderer) |
| Editor | **Monaco** (`monaco-editor`), bundled locally. Do NOT write a custom editor core |
| Renderer UI | Plain TypeScript + DOM. **No React/Vue/Svelte** in M1 |
| Terminal | `node-pty` + `xterm.js` |
| Git | `simple-git` local; `@octokit/rest` + `graphql` for GitHub |
| AI | `@anthropic-ai/sdk`, **main process only**, user-supplied key |
| Secrets | Electron `safeStorage` (DPAPI on Windows) |
| Validation | `zod` at every IPC boundary |
| Installer | `electron-builder`, NSIS per-user + portable |
| Tests | `vitest` (unit), `@playwright/test` `_electron` (E2E) |
---
## NON-NEGOTIABLE SECURITY INVARIANTS
Violating any of these is a build-blocking defect. Assert them in tests.
1. `BrowserWindow` webPreferences MUST be exactly:
   `{ contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, preload: <path> }`
2. The renderer has **no** Node access. `window.require`, `process`, `module`
   must be `undefined` in the renderer. Write an E2E assertion for this.
3. All privileged capability crosses via `contextBridge` in `preload/bridge.ts`,
   exposing a single frozen object `window.aperture` with typed methods. Never
   expose `ipcRenderer` itself, and never expose a generic `invoke(channel, ...)`.
4. Every IPC channel is declared in one table in `src/shared/ipc-contract.ts`
   with a zod request schema and a zod response schema. A channel with no table
   entry has no handler. Enforce with a unit test that diffs the table against
   the registered handler map.
5. **Path confinement.** `fs-service` resolves every incoming path
   (`path.resolve` + `fs.realpath`) and rejects anything not under the current
   workspace root. Reject symlinks that escape. Test with `../../` and symlink
   fixtures.
6. Content-Security-Policy on the renderer document:
   `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'`.
   The renderer makes **zero** network requests — all network goes through main.
7. `app.on('web-contents-created')` → block `will-navigate` to anything outside
   the app bundle; `setWindowOpenHandler` returns `{action:'deny'}` and routes
   through `shell.openExternal` only after an https-scheme allow-list check.
8. Child processes spawn with `shell: false` and an **argv array**. Never
   interpolate a path into a command string.
9. The Anthropic API key and GitHub token never cross the bridge in plaintext.
   There is a `secrets:setKey` / `secrets:hasKey` / `secrets:clearKey` — there is
   **no** `secrets:getKey`.
10. Errors never throw across IPC. Every handler returns
    `Result<T> = {ok:true, value:T} | {ok:false, error:{code:string,message:string}}`.
---
## TARGET REPOSITORY LAYOUT
Create exactly this. Do not add files not listed without saying why.
```
aperture/
  package.json
  tsconfig.json  tsconfig.node.json  tsconfig.web.json
  electron.vite.config.ts
  electron-builder.yml
  vitest.config.ts
  playwright.config.ts
  .gitignore  .editorconfig  README.md
  .github/workflows/build.yml
  resources/icon.ico  resources/icon.png
  src/
    shared/
      ipc-contract.ts        channel table + zod schemas + Result<T>
      types.ts               FileNode, RunEvent, GitStatus, Toolchain, AiRequest…
    main/
      index.ts               lifecycle, window, menu, CSP, navigation guards
      ipc.ts                 handler registry + zod validation wrapper
      fs-service.ts          open folder, tree, read/write/create/rename/delete, chokidar
      terminal.ts            node-pty session pool
      toolchains.ts          PATH probe + Windows Store stub detection
      runner.ts              hybrid execution + streaming
      error-links.ts         file:line regex sets per language
      git-service.ts         simple-git wrapper
      github-service.ts      Octokit GraphQL calendar + REST commits
      ai-service.ts          Anthropic streaming, prompt builders, abort
      ai-log.ts              provenance journal
      secrets.ts             safeStorage
      settings.ts            userData JSON settings
    preload/
      bridge.ts
    renderer/
      index.html  main.ts
      workbench/  layout.ts activity-bar.ts side-bar.ts panel.ts status-bar.ts
                  command-palette.ts quick-open.ts notifications.ts
      editor/     monaco-setup.ts tabs.ts models.ts ai-actions.ts
      views/      explorer.ts search.ts scm.ts run.ts insights.ts ai.ts settings.ts
      terminal/   xterm-view.ts
      bundled-packs/ web.js
      styles/     theme.css workbench.css
  test/
    unit/…  e2e/…  fixtures/…
```
---
## BUILD ORDER — 14 STEPS, EACH ENDING RUNNABLE
Work strictly in this order. **After every step, the app must launch.** Do not
proceed to step N+1 with step N broken. Report status at each step boundary.
**Step 1 — Scaffold.** `package.json`, tsconfigs, `electron.vite.config.ts`,
secure `BrowserWindow`, app menu, CSP, navigation guards. `npm run dev` opens an
empty styled window.
**Step 2 — The boundary.** `shared/ipc-contract.ts`, `main/ipc.ts` registry with
the zod wrapper, `preload/bridge.ts`. Include one `app:ping` channel end-to-end
plus the contract-completeness unit test and the "renderer has no Node" E2E test.
*This step is the spine of the whole app — get it right before anything else.*
**Step 3 — Filesystem + Explorer.** Open-folder dialog, recursive tree with lazy
expansion, chokidar watch pushing incremental tree events, create/rename/delete,
path confinement + its tests.
**Step 4 — Monaco.** Mount Monaco with local assets. One `ITextModel` per file
keyed by URI, models persist across tab switches (undo history + view state
survive). Tab bar, dirty indicators derived from `model.getAlternativeVersionId()`
vs the saved id, `Ctrl+S`, close-with-unsaved confirmation.
**Step 5 — Terminal.** `node-pty` + `xterm.js`. Prefer `pwsh.exe`, fall back to
`powershell.exe`, then `$SHELL`. Multiple sessions with a dropdown, `` Ctrl+` ``
toggles, resize propagates cols/rows. Coalesce main→renderer data on
`requestAnimationFrame`; throttle renderer→main writes. Dispose PTYs on window
close.
*This is the first native-module risk. `electron-rebuild` must run in
`postinstall`, and `node-pty` must be in `asarUnpack`. Verify a real prompt
appears and `node -v` executes before moving on.*
**Step 6 — Toolchain probe.** For `node`, `python`/`python3`, `gcc`, `g++`,
`tsc`, `docker`: resolve via `where`/`which`, run `--version` with a **1500 ms
timeout**, record `{id, found, path, version, kind}`.
Windows Store stub detection — implement precisely: `kind = 'store-stub'` when
the resolved path is under `…\Microsoft\WindowsApps\` AND (file size is 0 OR the
`--version` probe produced empty stdout OR exited non-zero). Surface this exact
guidance, never a generic failure:
> Python on your PATH is the Microsoft Store alias stub, not a real interpreter.
> Install Python from python.org, or turn the alias off in
> Settings → Apps → App execution aliases.
Cache per session; expose a "Rescan toolchains" command. Status-bar indicator.
**Step 7 — Hybrid runner + Output console.** `run(filePath, langId)`:
- real toolchain present → `child_process.spawn(cmd, argv, {cwd: workspaceRoot, shell:false})`,
  stream stdout/stderr as `run:stdout`/`run:stderr` events keyed by a `runId`,
  emit `run:exit {code, durationMs}`.
- absent → emit `{mode:'bundled', reason}` banner; renderer executes the bundled
  pack. If no bundled pack exists for that language, say so explicitly.
- Cancel kills the whole tree (`taskkill /pid <pid> /T /F` on Windows).
- Render output through an xterm.js instance so ANSI colour works without a
  hand-rolled parser.
- `error-links.ts`: regex sets for Node stack frames, Python tracebacks, and GCC
  diagnostics → clickable `file:line[:col]` that reveals the position in Monaco.
  Unit-test each regex against fixture output.
**Step 8 — SCM view.** simple-git: status (staged/unstaged/untracked), diff for a
path rendered in Monaco's `DiffEditor`, stage/unstage, commit, branch list +
current, `log -n 50`. Refresh on a chokidar watch of `.git/`.
**Step 9 — GitHub insights.** Token order: (1) `gh auth token` if the GitHub CLI
is on PATH, (2) a PAT pasted in Settings and stored via `safeStorage`. Never
prompt for a password; never bundle a token.
- Contribution calendar requires the **GraphQL** API — there is no REST endpoint.
  Query `user(login:){contributionsCollection{contributionCalendar{totalContributions
  weeks{contributionDays{date contributionCount}}}}}`. Render the 53×7 grid.
- Repo commits: parse the `origin` remote to `owner/repo`, then
  `repos.listCommits`. Fall back to local `git log` when there is no remote or no
  token, so the view is never empty.
- Show remaining rate-limit quota; cache responses 10 minutes.
**Step 10 — Secrets + Settings view.** safeStorage-backed Anthropic key and
GitHub PAT; `settings.ts` for non-secret prefs in `app.getPath('userData')`.
Settings UI shows key presence, never the value.
**Step 11 — AI (the differentiator).** `ai-service.ts` in main only.
Three selection actions plus a chat panel:
- **Explain** — what it does, inputs/outputs, control flow, non-obvious behaviour.
- **Find bugs** — concrete defects with line references and severity. Instruct the
  model explicitly to answer "no defects found" rather than invent problems.
- **Improve** — a rewritten block in a fenced code block plus a rationale list.
Requirements:
- `client.messages.stream()`; forward text deltas as `ai:delta` events keyed by
  `streamId`. One `AbortController` per stream backs `ai:cancel`.
- **Context assembly, and it must be inspectable.** Send: the selection, the
  enclosing symbol (via Monaco `DocumentSymbol`s), and the file's import list.
  The panel renders a collapsible **"Context sent"** section showing exactly what
  went to the model. Transparency is a product requirement, not a nicety.
- **Every AI edit is a diff, never a silent write.** "Improve" opens a Monaco
  `DiffEditor` (current vs proposed). Applying writes the file, snapshots the
  prior content for revert, and appends to `.aperture/ai-log.jsonl` in the
  workspace: `{timestamp, model, mode, promptHash, file, range, applied}`.
  One-click revert restores the snapshot.
- No key configured → an inline "Add your Anthropic key in Settings" affordance,
  not an error dialog.
- Map 401 / 429 / network failures to human messages returned as `Result`.
- Editor integration via `editor.addAction`, bound to `Ctrl+K` and the context
  menu, enabled only when the selection is non-empty.
**Step 12 — Remaining chrome.** Command palette (`Ctrl+Shift+P`), quick open
(`Ctrl+P`, fuzzy over the workspace file list), workspace search view, status
bar, notifications.
**Step 13 — Packaging.** `electron-builder.yml`:
`win.target: [nsis, portable]`, `nsis: {oneClick:false, perMachine:false,
allowToChangeInstallationDirectory:true}`, `asar: true`, `asarUnpack: ["**/node_pty/**"]`,
output `dist/Aperture-Setup-${version}.exe`. mac/linux targets present but
commented out. `npm run build` must produce the installer.
**Step 14 — Repo.** `.gitignore`, README with setup prerequisites and the
verification checklist, initial commit, push.
---
## PROTOCOL YOU MUST FOLLOW
1. **Plan before code, once.** Before step 1, output: the exact dependency list
   with versions, the `ipc-contract.ts` channel table in full, and any assumption
   you are making that would be expensive to unwind. Then stop and let me confirm.
2. **One step at a time.** Implement a step fully — code, its unit tests, and a
   launch check — then report before starting the next.
3. **Stop on load-bearing ambiguity.** If a decision would be costly to reverse
   and is not specified here, ask. Do not guess and proceed.
4. **Never leave a broken tree.** If a step fails, fix it or revert it; do not
   stack work on top.
5. **State what you did not do.** At each step boundary, name anything you
   stubbed, skipped, or approximated.
6. **No invented APIs.** If unsure of an Electron, Monaco, node-pty, Octokit, or
   Anthropic SDK signature, check the real docs rather than guessing. Wrong API
   shapes are the dominant failure mode in work like this.
---
## ENVIRONMENT PREREQUISITES — VERIFY FIRST, BEFORE STEP 1
Run these and report results before writing any code:
- Node ≥ 20 (`node -v`)
- npm ≥ 10
- Python 3 on PATH (needed by node-gyp), and confirm it is **not** the Store stub
- Visual Studio Build Tools with the **Desktop development with C++** workload
- `git --version`
- optional: `gh --version`
If the C++ build tools are missing, `node-pty` will fail to compile at step 5.
Say so up front rather than discovering it midway.
---
## ACCEPTANCE CHECKLIST — M1 IS DONE WHEN ALL 12 PASS
1. `npm install` completes; `electron-rebuild` succeeds for `node-pty`.
2. `npm run dev` opens the window with a clean console.
3. Open a folder → tree lists it; edit + save → dirty dot clears; reopen shows saved content.
4. `` Ctrl+` `` → a real PowerShell prompt; `node -v` runs in it; resize reflows.
5. Run a `.js` file → real Node output with ANSI colour; a thrown error's `file:line` is clickable and reveals the location in Monaco.
6. Run a `.py` file → real Python if installed; if the Store stub is on PATH, the specific guidance banner appears.
7. SCM view shows real `git status` and log; stage + commit works from the UI.
8. Insights shows the real contribution calendar and this repo's commits; degrades to local `git log` without a token.
9. Select code → Explain / Find bugs / Improve stream a Claude response tied to the exact selection; "Context sent" is inspectable.
10. Improve → diff preview → apply → entry in `.aperture/ai-log.jsonl` → revert restores byte-for-byte.
11. In devtools, `window.require`, `process`, and `module` are all `undefined`; the IPC-contract completeness test passes; path-confinement tests pass.
12. `npm run build` → `dist/Aperture-Setup-*.exe` exists and installs per-user with no admin prompt.
---
## EXPLICITLY OUT OF SCOPE FOR M1
Do not build these; do not scaffold placeholders that imply they work:
- **Debugger** (DAP: `vscode-js-debug`, `debugpy`, gdb/lldb) — M2. The M1 "debug
  console" is a streaming output console, not a debug session. Say so in the UI.
- **Bruno-style REST/GraphQL client** — M3.
- **Real LSP servers** (pyright, clangd, tsserver, terraform-ls) — M4. M1
  IntelliSense is Monaco's built-in word-based + bundled TS/JS worker.
- **Bundled Python/C++ interpreters** — M4. M1 bundles the HTML runtime only; the
  hybrid *mechanism* ships, its offline coverage does not.
- **Repo-wide embedding index** for cross-file semantic AI — deferred.
- **Auto-update, themes editor, keybindings UI, extension host** — M5.
---
## HONEST CONSTRAINTS TO SURFACE IN THE README
- Unsigned builds trigger a SmartScreen "unrecognized app" warning. Removing it
  needs an OV/EV code-signing certificate supplied via `CSC_LINK` /
  `CSC_KEY_PASSWORD`; OV reputation additionally accrues with download volume.
- AI features require the user's own Anthropic key and network access.
- Real compiler execution requires those compilers installed; the hybrid model
  softens this but does not remove it.
- "Parity with VS Code" for debugging and IntelliSense means speaking the same
  open protocols (DAP/LSP), and is a long tail across M2–M5.
---
## THE STRATEGIC BET (context for design trade-offs, not M1 work)
Where Aperture is meant to beat VS Code and Cursor, so you can avoid decisions
that foreclose these:
1. **Runs with nothing installed, then upgrades silently** when a real toolchain
   appears on PATH. Keep the runtime interface stable so bundled packs and real
   toolchains stay interchangeable.
2. **Time-travel debugging over the bundled interpreters** — we own the
   interpreter, so evaluation steps can be snapshotted and stepped backwards.
   Neither competitor can do this on real toolchains. Do not design the bundled
   pack interface in a way that discards intermediate state.
3. **Transparent AI** — static analysis alongside the model, with the reasoned-over
   structure shown. "Context sent" in step 11 is the seed of this.
4. **Provenance on every AI edit** — the `ai-log.jsonl` journal is auditable in a
   way Cursor's edits are not.
5. **Local-first AI toggle (Ollama) beside Claude.** Keep `ai-service.ts` behind a
   provider interface so a second backend drops in without touching the renderer.
