# Status — Clickless
_Updated 2026-11-07._

## Live
- Nothing released yet. Runs from source on macOS (`npm run dev`). Source: github.com/antonarnaudov/clickless (moves to the `clicklessbrowser` org once it exists; GitHub redirects the old links).

## Verified (2026-11-07, Electron 45.2.3, macOS 27)
- Claude Code (Sonnet) over MCP: filled and submitted the httpbin pizza form; HN + form task in 7 tool calls; GitHub-trending research in 3 steps through the built-in agent with the Claude Code provider; side panel shows steps live with glow, Pause/Stop.
- `act` batches: goto + fill (text, time picker, radio, checkboxes) + submit + server JSON in one call; forms inside a cross-origin iframe; multipart file upload; Enter submits search boxes.
- `read`: HN thread (authors/points kept), blog article (Readability), Wikipedia (infobox table).
- `search`: Brave results + top pages read in ~3 s.
- UI: shell, command bar, agent panel checked through `/v1/debug/ui`.
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
- [ ] `npm run dist` app bundle smoke test; DMG; app icon
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

