# Clickless agent guide

For agents (and the people writing them). Clickless is a real browser with the user's logins; you control it with eight tools. Each call does a lot — the goal is to finish a task in as few calls as possible.

## The loop that works

1. **Arrive with `act`.** `{"steps":[{"action":"goto","url":"example.com/login"}]}` returns the full element list of the new page. You don't need a separate `observe`.
2. **Do everything you can in one `act`.** Fill the whole form, tick the boxes, press submit — as one list of steps.
3. **Read the `act` result.** It tells you which steps worked, the new URL, new text (errors like "Incorrect password", toasts), and what changed. Only call `observe` if you need elements you haven't seen.
4. **Use `read` for content** (articles, results, prices, tables) and `search` for research.
5. **`handoff`** when the human must act: their password, 2FA, captchas, payment confirmation.

## Targets

| Form | Example | Notes |
|---|---|---|
| ref | `12`, `"12"`, `"[12]"` | From the latest `observe`/`act` output. Stable while the page stays the same; if the element was re-rendered Clickless finds it again by name. |
| text | `"Sign in"`, `"Email"` | Accessible name, label, placeholder, aria-label, title. Case and accents don't matter; exact > starts with > contains. The action steers the choice (`type` prefers text fields). |
| css | `"css:#search input"` | Obvious selectors (`#id`, `.class`, `a[href*=x]`) work without the prefix. |
| coordinates | `"xy:640,320"` or `{"x":640,"y":320}` | Viewport CSS pixels, e.g. from a screenshot. |

When a target isn't found, the error lists similar elements with their refs, so you can retry without observing.

## Steps

```json
{"action": "click", "target": "Add to cart"}
{"action": "dblclick" | "rightclick" | "hover" | "focus", "target": 12}
{"action": "type", "target": "Search", "text": "usb-c hub", "submit": true}
{"action": "type", "text": "typed into whatever has focus"}
{"action": "fill", "fields": {"Email": "a@b.c", "Password": "…", "Country": "Portugal", "Remember me": true}, "submit": true}
{"action": "select", "target": "Size", "value": "Medium"}
{"action": "check" | "uncheck", "target": "I agree"}
{"action": "press", "key": "Enter" | "Escape" | "Tab" | "ArrowDown" | "Meta+A", "times": 2}
{"action": "scroll", "direction": "down" | "up" | "top" | "bottom", "amount": 2}
{"action": "scroll", "target": "Reviews"}
{"action": "goto", "url": "github.com" }               // search terms work too
{"action": "back" | "forward" | "reload"}
{"action": "wait", "text": "Order confirmed", "timeout": 15000}
{"action": "wait", "gone": "Loading…"} / {"action": "wait", "selector": ".results"} / {"action": "wait", "urlIncludes": "/done"} / {"action": "wait", "ms": 500}
{"action": "upload", "target": "Resume", "files": ["/Users/me/cv.pdf"]}
{"action": "newtab", "url": "news.ycombinator.com"} / {"action": "switchtab", "tab": "t4"} / {"action": "closetab"}
```

`fill` picks the right method per field: typing for text, choosing the option for selects, clicking for checkboxes and radios, setting the value for date/time/colour pickers, attaching for file inputs. Typed values are checked afterwards and repaired if a field ignored them.

Lenient input: `{"click": 5}`, `{"type": "hello", "into": "Search"}`, `{"action": "navigate", "url": …}` are all understood.

### Script form

The same steps as text, separated by `;` or newlines:

```text
goto github.com/login
type Username "ada"
type Password "…" enter
wait "Dashboard"
click "New repository"
fill "Repository name"="browser" "Description"="The browser you own. Any AI can drive it."
check "Add a README file"
```

## Reading `act` results

```text
✓ 1. Typed “ada” into textbox “Username or email address” [2]
✓ 2. Typed “••••••••” into textbox “Password” [3] and pressed Enter
✗ 3. Click “New repository” — No element matching “New repository”. Similar: [41] link “New”, [42] button “Create repository”
(skipped 2 remaining steps)

Now: “Sign in to GitHub · GitHub” — https://github.com/session · tab t3 · 2140ms
Alerts: “Incorrect username or password.”
Changes: 1 new, 0 gone, 1 changed
+ [44] button “Dismiss this message”
~ [3] textbox “Password” required focused
```

- `✓`/`✗` per step; the run stops at the first failure unless `continueOnError` is set.
- `Now:` URL and title after the steps; `(new page)` when it navigated.
- `Alerts:` / `New text:` text that appeared while acting — usually the answer to "did it work?".
- `Changes:` elements added (`+`), changed (`~`), removed (`−`). On a new page you get the full list instead.
- `## Page text` when the new page has almost nothing to click (JSON, confirmations).

## observe output

```text
# GitHub · Sign in
https://github.com/login · 1280×720 · top of page (0/400px)

[1] link “Homepage” → /
## Sign in to GitHub
[2] textbox “Username or email address” focused
[3] textbox “Password” type=password
[4] link “Forgot password?” → /password_reset
[5] button “Sign in”
── below the viewport ──
footer: [6] “Terms”  [7] “Privacy”  [8] “Docs”
```

`⚠ dialog … is open` means a modal blocks the page and only its elements are listed. Use `query` (`"price|buy"`) on big pages, `viewportOnly` for what's on screen, `screenshot: true` for a picture with numbered boxes matching the refs.

## HTTP API

Everything needs `Authorization: Bearer <token>` (in `~/.clickless/control.json`).

| Route | |
|---|---|
| `POST /mcp` | MCP, Streamable HTTP |
| `GET /v1/tools?format=openai\|anthropic\|mcp` | Tool schemas |
| `POST /v1/<tool>` | Call a tool with JSON args; `?format=text` returns plain text |
| `POST /v1/agent` `{"task": "…"}` | Run Clickless's built-in agent to completion |
| `GET /v1/tabs`, `GET /v1/instructions`, `GET /v1/health` | |

Send `X-Clickless-Client: <name>` so the user sees who is driving.

## Rules of the road

- It's the user's real browser and accounts. Ask before buying, sending messages, posting, or deleting.
- If the user pauses agents, every call fails with a message saying so. Stop and tell them.
- Prefer `read`/`observe` over screenshots: they're exact and cheaper.
