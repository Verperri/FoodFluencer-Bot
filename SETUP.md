# FoodFluencer Bot — Setup Guide

FoodFluencer Bot is a Chrome extension that finds top restaurant photos and
auto-posts them to Instagram, Facebook, and TikTok.

---

## Prerequisites

Install these before anything else.

| Tool | Version | Download |
|---|---|---|
| **Google Chrome** | Any current release | [chrome.com](https://www.google.com/chrome/) |
| **Node.js (LTS)** | 20 or higher | [nodejs.org](https://nodejs.org) |
| **Git** | Any current release | [git-scm.com](https://git-scm.com) |

> Node.js bundles **npm**. After installing, verify both are available:
> ```bash
> node --version
> npm --version
> ```

---

## 1. Clone the repository

```bash
git clone https://github.com/Verperri/FoodFluencer-Bot.git
cd FoodFluencer-Bot
```

---

## 2. Install dependencies

```bash
npm install
```

This installs Jest and all test dependencies. Run this once after cloning and
again after any `package.json` change.

---

## 3. Configure your Google Places API key (optional)

A Google Places API key is **not required** to use the bot. All core features —
automatic business discovery, photo retrieval, and scheduled auto-posting —
work without one using free scraping sources (Google Maps, DuckDuckGo, Yelp).

The API key unlocks a fourth photo source (Google Places API) as an additional
fallback when all three scraping sources return fewer photos than needed.

To add one later:

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in.
2. Create a new project (or select an existing one).
3. Go to **APIs & Services → Library**, search for and enable **Places API (New)**.
4. Go to **APIs & Services → Credentials → + Create Credentials → API key**.
5. Paste the key into the extension's settings panel (gear icon in the popup).

> The free tier includes $200/month credit — more than enough for occasional
> use as a supplemental photo source.

---

## 4. Load the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the root folder of this repository.
4. The FoodFluencer Bot icon will appear in your Chrome toolbar.

The extension reloads automatically when you edit source files — just click
the refresh icon on `chrome://extensions` if changes don't appear.

---

## 5. Run the test suite

```bash
npm test
```

This runs all Jest test suites under `test/`. All tests must pass before
merging or opening a pull request (enforced automatically — see below).

---

## Development workflow

### Branching

Branches follow the version naming convention: `V2.3`, `V2.4`, etc.

```bash
git checkout main
git checkout -b V2.x        # start a new feature branch
```

### Pre-merge / pre-PR test gate

A Claude Code hook in `.claude/settings.local.json` automatically runs
`npm test` before every `git merge` or `gh pr create` command. If any test
fails the operation is blocked with a clear error message. **There are no
exceptions** — fix failing tests before merging.

### Pull requests

Always create a PR against `main` rather than merging locally:

```bash
gh pr create --base main --title "V2.x — short description" --body "..."
```

The test gate runs automatically before the PR is created.

---

## Project structure

```
FoodFluencer-Bot/
├── background.js        # Service worker — photo waterfall, auto-post logic
├── popup.js             # Extension popup — manual post flow, UI
├── popup.html / .css    # Popup UI
├── manifest.json        # Chrome extension manifest (MV3)
├── config.js            # Shared constants
├── diagnostics.html/js  # Built-in diagnostic tool
├── test/
│   ├── injectors/       # Jest tests for Facebook, Instagram, TikTok injectors
│   └── setup/           # Jest environment mocks (Chrome API, WebCodecs)
├── jest.config.js       # Jest configuration
├── package.json         # npm scripts and dev dependencies
├── legacy/              # Deprecated Flask prototype (reference only — see legacy/README.md)
└── SETUP.md             # This file
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm: command not found` | Install Node.js from [nodejs.org](https://nodejs.org), then reopen your terminal |
| `npm install` fails | Delete `node_modules/` and `package-lock.json`, then re-run `npm install` |
| Extension not updating | Click the refresh icon on `chrome://extensions` |
| API key errors | Confirm `Places API (New)` is enabled in Google Cloud Console and the key is saved in the extension's Settings panel (gear icon) |
| Tests blocked by hook | Run `npm test` locally, fix all failures, then retry the merge/PR |
