**Clickless — the AI-native open-source browser for everybody.** Free, no account; everything stays on your Mac.

### Install
1. Download the DMG for your Mac: `mac-arm64` for Apple silicon (M1 and later), `mac-x64` for Intel.
2. Open it and drag **Clickless** into **Applications**.
3. First launch: macOS can't verify the developer yet (the app isn't notarized). Go to **System Settings → Privacy & Security** and click **Open Anyway** next to Clickless. Once.
4. After updating, macOS may ask to let Clickless use “Clickless Safe Storage” in your keychain: click **Always Allow**.

Check a download: `shasum -a 256 Clickless-*.dmg` and compare with `SHA256SUMS.txt`.

### In this version
- Arc-style spaces, pinned tabs, folders, favourites and Today tabs; split view; command bar (⌘T)
- Ask AI and the agent panel (⌘E) with the model you choose: Claude Code login, Anthropic, OpenAI, OpenRouter, Ollama, LM Studio
- Control API, MCP server and CLI so any agent can drive the browser in a few calls
- Import from Arc, Comet, Chrome, Brave and Edge
- Optional encrypted backups to a folder or a private GitHub repository

Privacy: [docs/PRIVACY.md](https://github.com/antonarnaudov/clickless/blob/main/docs/PRIVACY.md). macOS only for now; Windows and Linux are planned.
