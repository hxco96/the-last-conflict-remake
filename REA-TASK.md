# REA task ledger

- **Target:** `thelastconflict-win.zip` → `tlcr/tlcr.exe` (Rust, raylib-port/SDL3, FMOD, QUIC multiplayer), version string `0.9.18`
- **Goal:** understand the features and logic, then rebuild it (option B: my own version) reusing the project's assets
- **Status:** done. Remake in this folder, findings in `SPEC.md`.

## Evidence sources

| Source | Method |
|---|---|
| `assets/*.rktd` | parsed with `tools/rktd.js` (Racket datum reader) → `assets/data/tables.json` |
| `assets/data.db` | REA `inspect_sqlite_database` (evidence `ev_4de4af66…`) for the schema; maps/tilesets read with `node:sqlite`. The `users` table was not read. |
| map blobs | zstd → Tiled JSON (115 maps; 6 exported) |
| atlases | TexturePacker JSON (`all_infecteds`, `core_custom`, `combat_anims`, `all_lights`, `map_editor/all_tilesets-*`) |
| `tlcr.exe` | printable-string scan: Rust module paths (`tlcr::app::*`), crate paths, mode/perk/command string tables |

## Open questions

- Exact meaning of the spawn fields `per-delay` and `execute once` (the remake uses its own spawn pacing)
- Native movement-speed units (the remake scales mob speed ×1.7)
- Damage formulas inside the exe (armor, crit and stun application order). They weren't decompiled; the data values are used directly.
- Multi-floor stairs, evac helicopter, scenario triggers and boss special attacks aren't reproduced
- FMOD event → sound mapping (`sound-events.rktd` holds only GUIDs)

## Verification

Run in the in-app browser against all 6 exported maps × the 4 classes with a scripted autopilot (90 s each). No exceptions were thrown. Mobs spawn per the zeds timeline, path to the player, and break barricades and doors. Kills, coin drops, loot pickups, crafting, upgrades, infection and bleeding, and the death screen all work.
