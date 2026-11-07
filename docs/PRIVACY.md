# Privacy

Clickless is a local app. There is no Clickless account, server, cloud or telemetry. The project never sees your tabs, history, keys or what you do in the browser.

## What stays on your Mac

| What | Where |
|---|---|
| Spaces, tabs, folders, favourites, archive, settings | `~/Library/Application Support/Clickless/state.json` |
| History | `~/Library/Application Support/Clickless/history.json` |
| Cookies, logins, site data | the Chromium profile in the same folder |
| API keys, the backup passphrase, the GitHub backup token | `secrets.json` there, encrypted with your macOS keychain |
| The local control API's address and token | `~/.clickless/control.json` (readable only by you) |

Importing from Arc, Comet, Chrome, Brave or Edge reads those browsers' tab and bookmark files on your Mac and writes them into the files above. Passwords, cookies and history are not read.

## What leaves your Mac, and only when you use it

- **Pages you open**, like any browser.
- **AI features** send what they need (the page you ask about, your question, tab titles for Tidy tabs) to the model *you* configured: Anthropic, OpenAI, OpenRouter, your local Ollama/LM Studio, or your Claude Code login. Nothing goes to an AI until you set one up.
- **AI search** opens the search engine you picked (Brave by default) in a hidden page.
- **Address-bar suggestions** send what you type to DuckDuckGo. Turn them off in Settings → General → Search suggestions.
- **Encrypted backups**, if you turn them on (below).

There are no update checks, crash reports or analytics.

## Encrypted backups (optional, off by default)

Settings → Backup. You choose where backups go (a folder such as iCloud Drive, Google Drive, Dropbox, OneDrive's Personal Vault, a Cryptomator vault or a USB drive, or a private GitHub repository) and a passphrase of at least 10 characters.

- The backup is encrypted **on your Mac** before it's written: scrypt (N=2¹⁷, r=8, p=1) derives a key from your passphrase, AES-256-GCM encrypts and authenticates the data, and the file's header is authenticated too. The destination only ever holds ciphertext.
- Included: spaces, tabs, folders, favourites, archive, history, settings. **Never included:** passwords, logins, cookies, API keys, the control token.
- GitHub: Clickless refuses public repositories and checks the token can write before it uploads. Use a fine-grained token limited to that one repository (Contents: read and write). Every backup is a new commit, so GitHub keeps older versions.
- Folders keep the newest 10 backups (`Clickless backup YYYY-MM-DD HHMMSS.clickless-backup`).
- Restoring replaces this Mac's spaces, tabs and settings and keeps the current ones as `state.before-restore.json`.
- Lose the passphrase and the backups can't be opened by anyone, including you.

## The local control API

Agents connect to `http://127.0.0.1:7734` with a random token. It isn't reachable from the network, and web pages can't call it (Host/Origin checks). Settings → Agents & API can turn it off.

## The source code

The public repository holds only code, docs and synthetic test data: no one's tabs, profiles or screenshots. Release builds are made by GitHub Actions from that source.
