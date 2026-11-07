# CLAUDE.md — working on Clickless

## What this is
Clickless is an open-source desktop browser (Electron 45 + React) built for sharing with AI agents: Arc-style spaces/tabs for the human, and a local control API (MCP, HTTP, CLI) designed so agents finish tasks in few calls. Using the browser as an agent: [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md). Current state and next tasks: [docs/STATUS.md](docs/STATUS.md).

## Commands
| | |
|---|---|
| Install | `npm install` (downloads Electron; if `node_modules/electron/dist` is missing run `node node_modules/electron/install.js`) |
| Run | `npm run dev` (build + start) · `npm start` (start the last build) |
| Fast rebuild | `npm run build:main` (main, preloads, CLI) · `npm run build:ui` (React UI) |
| UI alone | `npm run ui:dev` → http://localhost:5199/shell.html, `/overlay.html?overlay=palette|settings|organize|space`, `/internal.html?page=ask` (mock backend in `src/renderer/mock.ts`) |
| Typecheck | `npm run typecheck` |
| Tests | `npm test` |
| Package | `npm run dist` → `release/mac-*/Clickless.app` (unsigned) |
| Brand assets | `python3 scripts/make-brand.py` → `assets/` icon, mark, logos (palette and rules: docs/BRAND.md) |

Test profile: `CLICKLESS_USER_DATA=/tmp/clickless-test npm start`. `CLICKLESS_DEBUG=1` adds `/v1/debug/ui` (PNG captures of shell/tab/overlay) and `/v1/debug/cmd` (POST any UI `Command`) to the API — that's how to check UI changes without screen access.

Drive it from a shell while it runs: `node dist/cli/clickless.js observe`, `… act 'goto example.com; click "More"'`, `… read`, `… search "q"`.

## Architecture (where to change what)
- `src/shared/` — contracts. `types.ts` (UI state), `ipc.ts` (commands/queries between UI and main), `steps.ts` (the action language + DSL parser), `engine.ts` (main ↔ content-engine RPC), `settings.ts` (defaults, provider presets).
- `src/preload/content.ts` + `engine/` — runs in **every frame** of every page, isolated world: `snapshot.ts` (element list), `resolve.ts` (finding a target by ref/text/css/xy + click point), `readable.ts` (page → markdown), `overlay.ts` (agent cursor, marks), `watch.ts` (mutations, new text, waiting).
- `src/main/page.ts` — `PageController` per tab: RPC to frames, global refs, CDP input, settle/auto-wait, capture.
- `src/main/act.ts` — runs step batches and writes the result text. `format.ts` — snapshot and diff text (every token here is paid by agents on every call: keep it dense).
- `src/main/browser.ts` — window, views, spaces/tabs/folders, layout, banners, activity/pause, the `Browser` interface. `ipc.ts` — UI commands. `menu.ts` — shortcuts. `server.ts` — HTTP + MCP. `tools.ts` — tool schemas/handlers + agent instructions. `headless.ts` — hidden pages. `store.ts` — persistence, secrets, `~/.clickless/control.json`.
- `src/main/ai/` — providers (Anthropic SDK, OpenAI-compatible fetch, Claude Code CLI), agent loop, AI search, organizer. No Electron imports: everything comes through `AIDeps` (`src/main/contracts.ts`).
- `src/renderer/` — `shell/` (sidebar, viewport rects, agent panel), `overlay/` (palette, settings, organizer, space editor), `internal/` (clickless://newtab, clickless://ask).

Layering: tab pages are native `WebContentsView`s stacked **above** the shell. The shell can't draw over a page; it reports where pages go (`ui.viewports`). Anything that must float over pages lives in the overlay view (added on top only while `overlay != null`).

## How changes land
Base branch `main`. Branch per task (`feat/…`, `fix/…`), one worktree per task. Merge to `main` after the gate passes. Nothing deploys automatically; releases are manual (`npm run dist`) and need the maintainer's yes.

## Parallel work
Several agents may work on this repo at once.
- **One task = one branch = one worktree:** `git worktree add ../clickless-<topic> -b <type>/<topic> main`.
- **Check before you start:** `git worktree list`, `git branch -a --sort=-committerdate | head`, and "In flight" in docs/STATUS.md. If another branch already changes the files your task needs, pick another task or ask.
- **Never two writers on the same files.** Never stash, reset, switch branches or delete worktrees you didn't create.
- **Hand back:** rebase on `main`, pass the gate, merge, update docs/STATUS.md in the same merge, remove your worktree.
- Only one Clickless instance can run per user (single-instance lock, port 7734). Use `CLICKLESS_USER_DATA` for a separate profile, but stop the other instance first.

## Verification gate
`npm run typecheck && npm test && npm run build` pass, **and** the change works in the running app: for engine/tool changes, drive a real page through the CLI or MCP and read the output; for UI changes, look at it (`/v1/debug/ui` or `npm run ui:dev`).

## Outward actions
Pushing to `main`, tags, GitHub releases, publishing to npm/Homebrew, and posting about the project need the maintainer's explicit yes, each time. Agents prepare everything and ask.

## Secrets
None in the repo or env. Provider API keys are entered in Settings → AI and stored with Electron `safeStorage` (`<userData>/secrets.json`). The control token is in `~/.clickless/control.json` (0600). Never print or commit either.

## Personal data stays local
This repo is public. Nobody's browsing data, profile files, screenshots of a real profile, names, places or personal projects go in it — not the maintainer's, not a tester's. Real profiles live in `<userData>` (`~/Library/Application Support/Clickless`) and are never copied into the repo. Tests use synthetic fixtures on `example.*` domains; mock and demo content in `src/renderer/mock.ts` and the docs use generic sites and names. Screenshots for the README come from a throwaway demo profile filled with generic content.

## Releases
Push a `v*` tag (with the maintainer's yes): `.github/workflows/release.yml` builds the DMGs/ZIPs on GitHub's macOS runner and attaches them to a **draft** release; the maintainer publishes it. Never upload builds made on a personal machine.

## Gotchas
- **Key events need a focused page.** CDP key events are dropped while the window is in the background; `PageController.focusForKeys()` focuses the page's webContents first. Text goes through `Input.insertText` (works unfocused).
- **Navigation waits** follow `did-start-navigation` → `did-navigate` (commit) → engine ping on the *new* document (`settle()`); pinging too early hits the old page.
- **Preloads are sandboxed**: one bundled file, only `require('electron')`. Rebuild with `npm run build:main` after engine changes.
- **Search engines change their markup.** Extractors live in `src/main/ai/search.ts`; DuckDuckGo's HTML endpoint often serves a captcha to hidden pages, Google shows a consent page in a fresh EU profile — Brave is first in the chain.
- **Readability** is only used when a page signals it is an article; threads and listings use the main region so usernames/points survive.
- `capturePage()` fails when the window is occluded — use CDP `Page.captureScreenshot` (already the default).
- `Cmd+S` toggles the sidebar (Arc), so web apps don't get Cmd+S.

## Docs map
README (users) · docs/BRAND.md (logo, colours, names, voice) · docs/AGENT-GUIDE.md (agents using the API) · CLAUDE.md (this) · AGENTS.md (pointer + hard rules) · docs/STATUS.md (live state).
