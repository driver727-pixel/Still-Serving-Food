# Still-Serving-Food 🍔

> **Find out which bars & restaurants are still serving food — right now.**

The internet is full of open/close hours for venues, but almost nothing tells you when the **kitchen** or **grill** closes. Still Serving Food scrapes venue websites with [Firecrawl](https://firecrawl.dev) and surfaces **food-service hours only** — no liquor hours, no vague "open" times.

---

## Features

- 🔍 **Location search** — enter any city or neighbourhood to find nearby venues
- 🤖 **Firecrawl-powered scraping** — extracts grill hours, kitchen hours, and hot-food hours directly from venue websites
- 🟢 **Live "Serving Now" status** — tells you at a glance whether food is being served at this very moment
- 🕐 **Full weekly schedule** — expandable hour tables for every day of the week
- ⚡ **10-minute result cache** — avoids redundant scrapes on repeat searches
- 🔴 **"Opens at" info** — shows when food service begins if not currently serving

---

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/driver727-pixel/Still-Serving-Food.git
cd Still-Serving-Food
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and add your Firecrawl API key:
# FIRECRAWL_API_KEY=fc-xxxxxxxxxxxxxxxxxxxxxxxx
```

Get a free API key at <https://firecrawl.dev>.

### 3. Start the server

```bash
npm start
```

Then open <http://localhost:3000> in your browser.

---

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/search?location=Brooklyn,NY&limit=10` | Search for food-serving venues |
| `POST` | `/api/scrape` body: `{ "url": "..." }` | Scrape a specific venue URL |
| `GET` | `/api/health` | Health check |

### Example response (`/api/search`)

```json
{
  "venues": [
    {
      "name": "The Crown & Anchor",
      "url": "https://crownandanchor.com",
      "description": "Classic British pub with full kitchen",
      "serving": true,
      "opensAt": null,
      "closesAt": "9:00 PM",
      "hourBlocks": [
        { "day": 1, "open": 720, "close": 1260, "label": "monday", "inFoodSection": true }
      ],
      "scrapedAt": "2024-01-15T19:30:00.000Z"
    }
  ],
  "fromCache": false
}
```

---

## Mobile Builds (Capacitor)

The web frontend can be packaged into an Android APK or iOS IPA using [Capacitor](https://capacitorjs.com/). The Express API stays deployed at `https://letsnarf.com`; the native app talks to it directly.

### Prerequisites

- Node.js 18+
- For Android: Android Studio with an Android SDK installed
- For iOS: macOS with Xcode 14+ installed

### First-time setup

```bash
# Install dependencies (Capacitor packages are already listed in package.json)
npm install
```

### Add / update native platforms

```bash
# Android
npx cap add android        # scaffold the android/ project (first time only)
npx cap sync android       # copy web assets + apply config changes

# iOS (macOS only)
npx cap add ios            # scaffold the ios/ project (first time only)
npx cap sync ios           # copy web assets + apply config changes
```

### Open in native IDE

```bash
npx cap open android       # opens Android Studio
npx cap open ios           # opens Xcode (macOS only)
```

Build and sign the app from within the IDE as you normally would.

### Syncing web changes

After editing anything in `public/`, run:

```bash
npx cap sync
```

This copies the updated web assets into every added native platform.

> **Note:** The `android/` and `ios/` directories are listed in `.gitignore` and are not committed. Re-generate them from scratch with `npx cap add android` / `npx cap add ios` on any machine.

---

## Test Drive (GitHub Actions)

Want to try the app without cloning it locally? Use the **Test Drive 🍔** workflow:

1. Go to the **Actions** tab in this repository.
2. Select **Test Drive 🍔** from the workflow list.
3. Click **Run workflow**, fill in your city/neighbourhood (e.g. `Brooklyn, NY`) and an optional result limit, then click **Run workflow** again.

The workflow will spin up the server, query for food-serving venues in your chosen location, and print a formatted summary — all inside the GitHub Actions runner. No local setup required.

> **Note:** The `FIRECRAWL_API_KEY` repository secret must be set for the scraper to return live results.

---

## Development

```bash
npm test        # Run test suite
npm start       # Start production server
```

### Project structure

```
Still-Serving-Food/
├── functions/
│   ├── server.js        # Express server & API routes
│   ├── scraper.js       # Firecrawl integration
│   ├── hoursParser.js   # Parses food hours from scraped text
│   └── venueStore.js    # In-memory result cache
├── public/
│   ├── index.html       # Frontend UI
│   ├── styles.css       # Dark-theme stylesheet
│   └── app.js           # Client-side JavaScript
├── tests/
│   ├── e2e.test.js
│   ├── hoursParser.test.js
│   ├── scraper.test.js
│   ├── server.test.js
│   └── venueStore.test.js
├── .env.example
└── package.json
```

---

## How it works

1. You enter a location in the search box.
2. The server calls Firecrawl's `/search` API with a query like  
   `bars restaurants grill food hours "Brooklyn, NY"`.
3. For each result Firecrawl returns (up to 12), the markdown content of the page is parsed by `hoursParser.js`.
4. The parser looks for food-section keywords (grill, kitchen, food, dining …) and then extracts day/time patterns from the surrounding text.
5. The current local time is compared against the parsed hour windows to produce a **Serving Now** or **Not Serving** status.
6. Results are displayed on the page and cached for 10 minutes.

---

## License

ISC

