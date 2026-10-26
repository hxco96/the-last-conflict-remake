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

## Install as an app (PWA)

The game is an installable Progressive Web App (`manifest.webmanifest` + `sw.js`):

- **Android (Chrome):** open the hosted https link → menu **Install app** (or the **⬇ Install app** button on the title screen). It gets a home-screen icon and launches fullscreen in landscape.
- **iPhone (Safari):** Share → **Add to Home Screen**.
- **Offline:** the core game is cached on first load; maps and music are cached as you play them, or all at once via Settings → *Download everything for offline* (~30 MB).
- Installing needs **https** (any static host) or `localhost`. A plain `http://192.168…` LAN address will run but won't install.
- After changing any game files, bump `VERSION` in `sw.js` so installed copies pick up the update.

## Rebuild the assets from the original zip

`assets/` is generated. To regenerate it, unzip `thelastconflict-win.zip` somewhere and run this (needs Node 24+ for `node:sqlite` and zstd):

```bash
node tools/extract.js path/to/tlcr
```

This converts the `.rktd` s-expression tables to JSON. It also decompresses 6 Tiled maps out of `data.db`, packs the tileset metadata, and copies the needed atlases.

## Round cycle, lobby & economy

- **Flow:** title → pick survivor & class → **the base** (lobby, the Base map cleaned up). A timer counts down to the next round (60 s first, 45 s after).
- **Mission board:** host-pick or vote the next map, mode, spawn theme and difficulty; *Join & deploy at start* or *Join — I'll walk in*. If nobody joined, the round is skipped. A started round runs even if you stay behind: spectate it, or walk out a green **DEPLOY** door to teleport in. A round nobody deploys into ends after 150 s.
- **Class & survivor are remembered**: the title shows one ENTER LOBBY button; "Change class / survivor" (also in the pause menu) reopens the picker. Classes differ only by perks: everyone starts with the basic Beretta92.
- **Weapon tiers (T1 Scrap → T5 Legendary)** come from each weapon's stats (sustained DPS, time-to-kill on a 200 HP zed, range, mag, reload). Hover a table weapon in the lobby to see its card. Maps only spawn T1–T2 weapons at the start; the ceiling rises by one tier every 6 minutes (max T4) and bosses drop one tier higher.
- **Inventory persists between runs**: weapons you buy or pick up stay with you, even if you die. Spares go in the **storage locker** in the lobby (4 slots, upgradable to 12 at the merchant). Buying with a full inventory sends the weapon to storage.
- **Tables:** every weapon and item (162) is on display, grouped by category. Weapons are unlocked permanently with coins and are free to re-pick each round; ammo, throwables, mines and meds cost coins per purchase.
- **Merchant:** permanent weapon upgrades (original wep_upgrades levels) and inventory upgrades: weapon slots 3→5, ammo slots 2→6, throwables pouch.
- **Coins** are paid at the end of a match: kills ×3 + 2 per 10 s alive + 150 objective bonus, × difficulty (Easy 0.6, Normal 1, Hard 1.6, Nightmare 2.4). Saved in the browser.
- **Inventory:** generic weapon slots; ammo lives in typed slots (auto top-up only for a type you already carry, new types need Use); grenades/mines/molotovs are a separate counted pouch, switched with Toggle throwable (T / △ / hold NADE).
- **Shooting** is hitscan: no visible bullets, impacts show on the zombie or wall; recoil bloom and range falloff. Explosives and flamethrowers stay projectiles.
- **Spawns** follow the original MobSpawn rects (map edges), never on screen or within 480 px; floors without reachable rects use the outer ring of the playable area. Infected climb through windows.
- Networking is not part of this build: votes tally the local player only.

## Game modes & original features

- **Modes** (from the exe's mode table): Survival (endless), Extermination (kill 120), Evac (helicopter arrives at 3:00, stand in the landing ring to escape), Rescue (find every survivor, then evac), Peaceful (no infected). Battle Royale / Death Match are PvP and not included.
- **Spawn themes** from `spawn_levels_*.rktd`: Zeds, Spiders, Chaos, Mechs (original DRAUGR / LOKI / SKJOLD robot sprites), Boss Rush.
- **Evac helicopter**: flies in to the map's `EvacZone`/`HeliSpawn` marker with the original radio line, rotor loop and landing wind; an arrow points to it when off-screen.
- **Boss / mob abilities** from `mob_db`: tongue attacks grab and reel you in (attack or jump to struggle free), spiders lay webs that slow you (plus the maps' WebTrap tiles), the spider queen spawns minions.
- **Mines** (Mine, Incendiary, Nitro, Acid): place with **N** or from the inventory; they arm after 1 s and trigger on infected.
- **Fire**: Molotovs, incendiary grenades/mines and fire explosions leave burning ground (Pyro *Scorched* / *Inferno* apply).
- **Weather**: rain with thunder flashes, or snow, with the original ambience loops (toggle in Settings).

## Controls

Every action can be rebound in **Settings** (main menu or pause): keyboard/mouse (two bindings each, conflicts flagged red), controller buttons, and touch (size, opacity, left-handed mirror, and which action each on-screen button performs). Settings persist in `localStorage`.

- **PS5 DualSense / gamepads** (standard mapping): left stick move (L3 run), right stick aim, R2 fire, L1 throw, ✕ use-or-jump (contextual), ○ jump, □ reload (hold: place mine), △ next throwable (hold: heal), R1 next weapon, L2 last weapon, D-pad weapon slots, R3 frenzy, Create inventory, Options pause. Rumble on shots, hits and explosions. Menus: ✕ select, ○ back.
- **Mobile / touch**: floating move and aim sticks, large JUMP / NADE (hold to switch throwable) buttons; USE, RELOAD and HEAL appear only when they apply; ≡ holds pause, bag, mine, flashlight. Separate portrait layout; tactical auto-reload when it's quiet.
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
| T | Toggle throwable |
| N | Place mine |
| Space | Jump |
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
