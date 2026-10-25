# The Last Conflict — browser remake

A from-scratch HTML5/JavaScript rebuild of **The Last Conflict (tlcr 0.9.18)** Survival mode. It's based on reverse-engineering the shipped Windows build, and it runs on that build's own assets and data tables: maps, sprites, weapon stats, mob stats, spawn waves, perks, recipes and upgrades.

See **[SPEC.md](SPEC.md)** for what was found in the original and how sure each finding is. It says which parts are reproduced and which are design choices.

**21 maps**, 10 of them multi-floor (Basement, Apartment with 4 floors, Castle, The Building, Sewers, Subway Station, The Docks, Riverbank Village, Sosas Mansion, Underground Bunker). Walk into a stairwell to change floors; zeds right behind you follow, and so does your squad. Each floor keeps its own zeds, loot and NPCs.

**NPCs:** soldiers stand guard at the map's original soldier posts and join your squad when you reach them. They follow you, shoot zeds and call out. Survivors shout for help until you press Use to rescue them, then they follow you. Anyone can go down: get to them within 30 s and press Use to revive.

## Run

```bash
node tools/serve.js 8123
```

Then open http://localhost:8123. You need Node 18 or newer. There's no build step and no dependencies.

## Rebuild the assets from the original zip

`assets/` is generated. To regenerate it, unzip `thelastconflict-win.zip` somewhere and run this (needs Node 24+ for `node:sqlite` and zstd):

```bash
node tools/extract.js path/to/tlcr
```

This converts the `.rktd` s-expression tables to JSON. It also decompresses 6 Tiled maps out of `data.db`, packs the tileset metadata, and copies the needed atlases.

## Controls

Every action can be rebound in **Settings** (main menu or pause): keyboard/mouse (two bindings each, conflicts flagged red), controller buttons, and touch (size, opacity, left-handed mirror, and which action each on-screen button performs). Settings persist in `localStorage`.

- **PS5 DualSense / gamepads** (standard mapping): left stick move (full tilt or L3/L2 runs), right stick aim, R2 fire, L1 grenade, □ reload, ✕ use, ○ heal, △ frenzy, R1 / D-pad ←→ switch weapon, D-pad ↑ flashlight, Create inventory, touchpad upgrades, Options pause. Rumble on shots, hits and explosions. Menus: D-pad/left stick to move, ✕ select, ○ back. Xbox pads get Xbox labels.
- **Mobile / touch**: floating left move stick, floating right aim stick that fires past half tilt, remappable buttons, tap weapon icons to switch, BAG / SHOP / II on top. Starting a game goes fullscreen landscape where allowed.
- **Legacy shooting mode** (menu or Settings → Gameplay): hold **F** on PC, **R2** on a controller, or the **FIRE** button on mobile to lock onto the closest visible zed in weapon range and keep firing. Each shot rolls a weighted hit chance (weapon class, distance vs. range, standing/walking/running, target size, rushing, Frenzy, and a pity bonus after misses), shown on the lock-on reticle. Frenzy moved to **V** so F is free.

Default keyboard/mouse:

| Key | Action |
|---|---|
| WASD / Shift | move / run (uses stamina) |
| Mouse / LMB | aim / attack (auto weapons fire while held) |
| RMB or G | throw grenade |
| R | reload |
| E | open/close doors, pick up weapons, board up windows |
| 1-4, Q | weapon slots (melee, sidearm, primary, throwable), last weapon |
| H | quick heal |
| Tab | inventory, herb mixing, gunpowder → ammo crafting |
| B | weapon upgrades (paid with coins from kills) |
| F | Legacy auto-fire (legacy mode) |
| V | Frenzy when the meter is full (activates the class's Frenzy perks) |
| L / M / Esc | flashlight / mute / pause |

## Code map

- `js/assets.js`: asset loader and a TexturePacker atlas reader (`base_anim_dir_frame_duration` naming)
- `js/data.js`: indexes over item_db, mob_db, outfits, drops, upgrades and recipes
- `js/map.js`: Tiled map decoding (`floor_0` bot/top/inst layers), prerendering, collision from tile types, doors, barricades, pickups and lights
- `js/nav.js`: Dijkstra flow field. Barricades and doors are passable at a high cost, so mobs break through them.
- `js/actors.js`: layered player paper-doll and data-driven mobs with outfit groups
- `js/combat.js`: weapons (fire-rate, mag, reload, pellets, pierce, crit, stun), projectiles, grenades, effects
- `js/game.js`: game loop, survival spawner from `spawn_levels_zeds`, AI, items, perks, lighting, HUD
- `js/npc.js`: soldier and survivor NPCs (random paper-doll looks, names and barks from the original data, squad following, shooting, down/revive)
- `js/input.js`: rebindable action layer for keyboard/mouse, gamepads (DualSense labels, rumble), touch sticks and buttons, and persisted settings
- `js/sfx.js`: plays the original FMOD sounds (positional SFX, music playlist, boss/menu/death themes, volume settings)
- `tools/fsb5.js`: converts FMOD `sfx.bank` / `music.bank` (FSB5 Vorbis) into standalone `.ogg` files in pure Node. FMOD strips the Vorbis setup headers, so they are restored from vgmstream's table (`tools/vendor/vorbis_codebooks_fsb.h`).

## Audio

`tools/extract.js` exports all 349 sound effects and 28 music tracks from the original banks to `assets/audio/` (≈29 MB) with a manifest. Gunshots are matched to each weapon by name (e.g. `spas-12-fire`, `ak47-fire`), mobs use their family's moan/attack/pain/death sets, and the player's hurt/death sounds follow the survivor's gender. Music: *Save Room (RE0)* on the menu, a shuffled playlist in game, *Plant 42 – Boss Theme* when a boss appears, *Secure Place* on death. Volumes are in Settings → Gameplay; M mutes.

Event-to-sample mapping is by sample name. The original FMOD event graph (`sound-events.rktd` GUIDs) was not decoded. Ogg Vorbis plays in Chrome, Edge, Firefox and Android; older iOS Safari versions may not decode Ogg.
