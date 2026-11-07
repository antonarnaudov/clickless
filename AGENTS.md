# AGENTS.md

Read [CLAUDE.md](CLAUDE.md) — it applies to every coding agent (Codex, Cursor, Gemini, Aider…), not only Claude.

Hard rules, inline:
1. **Outward actions need the maintainer's explicit yes**: pushing to `main`, tags/releases, publishing packages, posting anywhere.
2. **One task = one branch = one worktree.** Never edit a checkout another agent may be using.
3. **Secrets by name only.** API keys live in the app's encrypted store (Settings → AI); never print, commit or paste values. Never commit `~/.clickless/control.json` or tokens.
4. **Verification gate before merging**: `npm run typecheck && npm test && npm run build` pass, and the change was tried in the running app (`npm run dev`).
5. **Keep docs/STATUS.md current** in the same merge.
6. **Personal data stays local.** The repo is public: never commit browsing data, profile files (state.json, Bookmarks, Favicons, sessions), screenshots of a real profile, or anyone's names, places or projects. Tests and mocks use synthetic, generic content.

Using Clickless as a tool (driving the browser) rather than developing it: see [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md).
