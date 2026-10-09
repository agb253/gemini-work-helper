# Gemini Work Helper

A Chrome extension plus a small local bridge that lets you hand queued tasks to the **Gemini web app**
(gemini.google.com) and file the answers back on disk, without an API key. It is meant for using the
larger quota of a Gemini web account to take on part of a workload.

**You stay in control.** The extension loads a batch of tasks into the Gemini prompt box. *You* click
"Paste & Run" (the extension never sends on its own). When Gemini finishes, the reply is saved to the
bridge, split per task, and checked.

```
workqueue/todo/*.md  ->  bridge (127.0.0.1:8765)  ->  extension panel on gemini.google.com
                                                          you click Send
workqueue/done|failed <-  bridge splits + checks   <-  reply captured from the page
```

## Setup

Requires Python 3.8+ and Chrome/Chromium. No dependencies.

```bash
git clone https://github.com/agb253/gemini-work-helper && cd gemini-work-helper
python3 bridge/bridge.py --write-config      # creates a token, writes extension/config.js
cp -r examples/workqueue .                   # optional: an example task
python3 bridge/bridge.py                     # leave running
```

Then open `chrome://extensions`, enable Developer mode, **Load unpacked**, choose `extension/`.
Open gemini.google.com; a "Work helper" panel appears.

## Task cards

A card is a Markdown file in `workqueue/todo/` with front matter:

```
---
worker: gemini-web
output: out/my-task.json                       # where the JSON result is written (relative to GEMINI_HELPER_ROOT)
check: python3 verify.py {output}              # optional; exit 0 = pass. {output} is replaced with the path
---
Your prompt. Ask for JSON only.
```

Gemini is told to answer each task with a line `RESULT <card id>` followed by one JSON block. Cards
pass to `done/` if the JSON parses and `check` exits 0, otherwise to `failed/`. Cards loaded but never
saved return to `todo/` after 24 hours.

Environment: `GEMINI_HELPER_ROOT` (default: cwd), `GEMINI_HELPER_QUEUE` (default: `$ROOT/workqueue`),
`GEMINI_HELPER_TOKEN_FILE` (default: `~/.config/gemini-bridge.token`), `GEMINI_HELPER_PORT` (default 8765; if you change it, also edit `BASE` in `extension/bg.js` and `host_permissions` in `manifest.json`).

## Security notes

- The bridge binds to `127.0.0.1` only and requires the `X-Bridge-Token` header on every request.
  The token is in `~/.config/gemini-bridge.token` and in `extension/config.js`. **Never commit
  `config.js`** (it is gitignored).
- A card's `check:` line is run as a **shell command**. Only put cards in the queue that you wrote or
  reviewed.
- The extension only has access to `gemini.google.com` and `127.0.0.1:8765`.

## Caveats

- It drives the Gemini web UI by DOM selectors (prompt box, Send button, response elements). Google
  can change those at any time and break it; the selectors are at the top of `extension/content.js`.
- Using the web app this way may be subject to Google's terms for Gemini. Check them for your account.
- Gemini can ignore the format or invent content. The `check` step is the only validation; write one.

## License

MIT
