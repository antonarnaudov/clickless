**Clickless 0.2 — the AI-native open-source browser for everybody.** Free, no account; everything stays on your Mac.

### Install
1. Download the DMG for your Mac: `mac-arm64` for Apple silicon (M1 and later), `mac-x64` for Intel.
2. Open it and drag **Clickless** into **Applications** (replace the old one if you have 0.1).
3. First launch: macOS can't verify the developer yet (the app isn't notarized). Go to **System Settings → Privacy & Security** and click **Open Anyway** next to Clickless. Once.
4. After updating, macOS may ask to let Clickless use “Clickless Safe Storage” in your keychain: click **Always Allow**.

Check a download: `shasum -a 256 Clickless-*.dmg` and compare with `SHA256SUMS.txt`.

### New in 0.2
- **Agents get their own browser.** Claude Code, Codex, Gemini CLI, Cursor or any MCP agent works in its own profile and window, with its own cookies, logins and tabs. When it needs one of your pages it asks; you pick which tabs to share and copies open in its window. Per agent, switch it to your profile, show its window or reset it (Settings → Agents & API).
- **Split view, drag and drop.** Drag a tab onto the page to split (2–4 panes); drag a pane by its grip to move or swap it, or back onto the sidebar to take it out. Tabs never close by accident.
- **History** (⌘Y): search, delete, clear the last hour / today / everything. ⇧⌘T reopens tabs with their back/forward history, in their old place, even after a restart.
- **Connectors page** with each provider's and agent's logo, and the exact setup for Claude Code, Codex, Gemini CLI, Cursor, Claude Desktop, VS Code, Windsurf, any MCP client, HTTP and the CLI. Installed apps connect agents without Node.
- **Faster, surer agents.** In our Claude Code benchmark (`npm run bench:agent`: signup, shop checkout, a paged table, a form in a cross-origin iframe inside shadow DOM, a task across two tabs, the real web) agents now pass 6/6 in 36 calls and about 3 minutes (0.1: 5/6, 70 calls, 8 minutes). Fixed: pages opened by links weren't reachable, clicks in an off-screen iframe missed, collapsed FAQ text and iframe/shadow DOM content weren't read, confirmations inside widgets went unnoticed.
- **Encrypted backups** (optional) to a folder or a private GitHub repo, and import from Arc, Comet, Chrome, Brave and Edge.

Privacy: [docs/PRIVACY.md](https://github.com/antonarnaudov/clickless/blob/main/docs/PRIVACY.md). macOS only for now; Windows and Linux are planned.
