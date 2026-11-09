**Clickless 0.3 — the AI-native open-source browser for everybody.** Free, no account; everything stays on your Mac.

### Install
1. Download the DMG for your Mac: `mac-arm64` for Apple silicon (M1 and later), `mac-x64` for Intel.
2. Open it and drag **Clickless** into **Applications** (replace the old one if you have an earlier version).
3. First launch: macOS can't verify the developer yet (the app isn't notarized). Go to **System Settings → Privacy & Security** and click **Open Anyway** next to Clickless. Once.
4. After updating, macOS may ask to let Clickless use “Clickless Safe Storage” in your keychain: click **Always Allow**.

Check a download: `shasum -a 256 Clickless-*.dmg` and compare with `SHA256SUMS.txt`.

### New in 0.3
- **Saved tabs stay saved.** ⌘W or ✕ on a pinned tab, a favourite or a tab in a folder now unloads it, back at the address you saved, instead of deleting it (Today tabs still close). *Delete tab* in its menu removes one for good; ⇧⌘T brings it back.
- **Folders inside folders**, each with its own colour and an optional emoji (right-click a folder). Folders imported as `A / B` become real nested folders.
- **Spaces and Today fold up** like folders. Open tabs get a small dot instead of the rest being greyed out.
- **Saved passwords.** Clickless offers to save after you sign in and offers the login under the field next time; nothing is filled until you pick it. Kept on your Mac, encrypted with your keychain; Touch ID before showing or exporting; import and export CSV from Chrome, Comet, Arc, Edge, Safari or Firefox. Agents never get them.
- **Profiles per space**: be signed in to different accounts in each space (separate cookies, logins and site data).
- **Settings for the usual things**: theme, colour strength, space colours, sidebar size, page zoom, start-up, default browser, download folder, spellcheck; clear browsing data by time range, search history, cookies and site data per site, site permissions, Global Privacy Control, duplicate tabs.
- **Fixed**: back/forward and Ask appeared twice with the address above the page; pages without their own background were dark in dark mode; the large sidebar size overflowed.

Upgrading from 0.2 keeps your spaces, tabs and settings.

Privacy: [docs/PRIVACY.md](https://github.com/antonarnaudov/clickless/blob/main/docs/PRIVACY.md). macOS only for now; Windows and Linux are planned.
