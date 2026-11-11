# Dead Line

A top-down zombie survival game that runs in the browser (desktop, controller and phone). No build step.

- **Survival, Extermination, Evac, Rescue, Peaceful** on a growing set of maps, with kill call-ins.
- **Siege:** hold a shelter you keep up between sessions: stockpile, rucksack, facilities, survivors with talents, a partner who follows you, horde nights.
- **Gun mods** (press C) and a cross-server **player market** (press K).
- Phone controls with a sprint button; 3D view (three.js) with a classic 2D fallback in Settings.

## Run it

```
node tools/serve.js 8123
```

Open `http://localhost:8123/next/index.html` for the 3D build (`/` is the classic build).

## Layout

- `next/` the 3D build (its own `index.html`, loads shared assets from the repo root)
- `js/` the classic 2D build
- `assets/` maps, sprites, data tables, audio
- `server/` optional co-op matchmaking server (see `server/README.md`)
- `supabase/` notes on the market database

Co-op uses PeerJS (vendored). Saves live in your browser's local storage.
