# Status — Clickless
_Updated 2026-11-07._

## Live
- **v0.1.0 released 2026-11-08**: github.com/antonarnaudov/clickless/releases/latest (macOS DMG/ZIP, Apple silicon + Intel, built by GitHub Actions, ad-hoc signed, not notarized). Also runs from source (`npm run dev`). Source: github.com/antonarnaudov/clickless (moves to the `clicklessbrowser` org once it exists; GitHub redirects the old links).

## Verified (2026-11-07, Electron 45.2.3, macOS 27)
- Claude Code (Sonnet) over MCP: filled and submitted the httpbin pizza form; HN + form task in 7 tool calls; GitHub-trending research in 3 steps through the built-in agent with the Claude Code provider; side panel shows steps live with glow, Pause/Stop.
- `act` batches: goto + fill (text, time picker, radio, checkboxes) + submit + server JSON in one call; forms inside a cross-origin iframe; multipart file upload; Enter submits search boxes.
- `read`: HN thread (authors/points kept), blog article (Readability), Wikipedia (infobox table).
- `search`: Brave results + top pages read in ~3 s.
- UI: shell, command bar, agent panel checked through `/v1/debug/ui`.
- Encrypted backups (2026-11-08): backup → close a tab → restore from the folder target brought the tab back after the automatic restart, with `state.before-restore.json` kept; the backup file holds no readable text. Unit tests cover wrong passphrase, tampering, public-repo refusal and GitHub create/update/read against a fake API. Not yet run against a real GitHub repo.
- Release build: `dist:release` makes ad-hoc-signed DMG + ZIP (arm64 locally; x64 in CI); the app in the DMG verifies; the CLI is unpacked and runs on the app's own runtime (`ELECTRON_RUN_AS_NODE`), so agents don't need Node. The release workflow built v0.1.0 on GitHub (arm64 + x64); both downloads verified (checksums, signatures, contents) before publishing.
- App bundle: `npm run dist` builds an ad-hoc-signed `Clickless.app` (the `afterPack` hook in `scripts/adhoc-sign.cjs`; without it Electron's broken linker signature fails `codesign --verify`). Installed in /Applications and run on a real profile: tabs, favourites, folders and pages load; Spotlight finds it.
- Import (`clickless import arc|comet`, Settings → Tabs): a real Arc sidebar (2 spaces, folders, favourites, Today) and a real Comet profile (bookmarks + last session's open tabs) imported; most tabs get their icon from the source browser's Favicons DB; a second run adds nothing. Parsers covered by `test/importers.test.mjs` with synthetic fixtures.
- Local model (qwen/qwen3.8-27b in LM Studio, 32k context, OpenAI-compatible provider): the Hacker News comments task succeeded with a correct summary — 5 steps / 218 s with thinking, **3 steps / 155 s** with `/no_think` (now automatic for Qwen 3). The pizza-form task did not finish: LM Studio dropped the model mid-run (memory pressure) and the HTTP call ended at 247 s.

## In flight
| Branch / worktree | State | Next step |
|---|---|---|
| — | | |

## Next tasks
- [ ] Finish the local-model test (form task, smaller 8–14B models) on a machine with a GPU (e.g. Ollama on Windows or Linux)
- [ ] Settings flows end to end in the app (add provider, test, list models) — built against the mock, not yet clicked through in Electron
- [ ] Ask page end to end with a configured model (pipeline tested with a mock server)
- [ ] Organizer end to end with a model (heuristic path tested)
- [ ] Signed, notarized build (needs an Apple developer account): removes the Gatekeeper “Open Anyway” step and the keychain prompt after each update
- [ ] Windows and Linux builds in the release workflow (shell window controls first)
- [ ] Chrome extensions (`session.extensions`), ad blocking, a password manager (Bitwarden / 1Password extension)
- [ ] Import: Chromium profiles other than `Default`; history; Arc split views as Clickless split view (they come in as plain tabs now)
- [ ] Windows/Linux window controls in the shell (only macOS traffic lights are handled)
- [ ] Per-site agent permissions; agent action log per site
- [ ] Unit tests for the step parser and snapshot formatter; e2e test that drives fixture pages

## Known issues
- The CLI's `agent` command can time out on very long local-model runs; stream progress instead of one long HTTP response.
- Google shows its consent page in a fresh profile; until the user accepts or rejects it, Google search results can't be read by the hidden reader (Brave is tried first).
- Electron has no Widevine: DRM video (Netflix, Spotify web) won't play.
- Google sign-in may warn about an unsupported browser on some accounts (the user agent is Chrome's, but Google also checks other signals).
- Status label shows `claude-code` (the MCP client) when the built-in agent runs on the Claude Code provider.

## Waiting on the maintainer
- Domain clicklessbrowser.com (free as of 2026-11-07).

