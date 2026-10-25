# The Last Conflict (tlcr) — Reverse-Engineering Spec

Target: `thelastconflict-win.zip` → `tlcr/tlcr.exe` (18.9 MB, Windows x64), build string `0.9.18`.

Legend: **[OBS]** = observed directly in shipped files · **[INF]** = inferred from names/data, not seen executing · **[UNK]** = unknown.

## 1. Technology

| Fact | Evidence |
|---|---|
| Written in **Rust**, crate name `tlcr` [OBS] | Module paths in exe strings: `tlcr::app::human::Stamina`, `tlcr::app::monster::Tongue`, `src\collision.rs:511` |
| Rendering via a **raylib Rust port on SDL3** [OBS] | `raylib-rust-port\src\rsdl.rs`, `rlgl.rs`; ships `SDL3.dll` |
| Debug/editor UI via **Dear ImGui** (`imgui-rs`) [OBS] | `imgui-rs\imgui\src\*.rs` strings |
| Audio via **FMOD Studio** [OBS] | `fmod.dll`, `fmodstudio.dll`, `Master.bank`, `sfx.bank`, `music.bank`; `sound-events.rktd` is a list of FMOD event GUIDs |
| **ECS** architecture (archetype storage) [INF] | `src\archetype.rs`; components named `Health`, `Move`, `Alive`, `Monster`, `MobKind`, `PrevPos`, `ProcessDeath`, `KillTrack`, `NetInterp` |
| **Multiplayer over QUIC** (quinn + rustls/ring) [OBS] | `connection\streams\state.rs`, `packet_crypto.rs`, `aead\quic.rs`; `tlcr::app::net`, `tlcr::app::sv`, `server_chat.log`/`client_chat.log` |
| Game data in **Racket-style s-expressions** (`.rktd`) read by Rust [OBS] | `assets/*.rktd` paths embedded in exe next to `item_db.rktd<CLIENT DEBUG>` |
| Maps authored in **Tiled** (JSON), stored **zstd-compressed** in `assets/data.db` (SQLite) [OBS] | `maps` table: 115 rows, blob magic `28 b5 2f fd`; decoded JSON has `tiledversion`, `layers`, `tilesets` |
| Sprites packed with **TexturePacker** (JSON hash + PNG) [OBS] | `meta.app = codeandweb.com/texturepacker` |

`data.db` also contains server-side tables (`users`, `clans`, `leaderboards`, `skins`, `votes`, `comments`, `bug_reports`) and NPC bark tables (`say_swarmed`, `say_help_downed`, `say_pilot_noevac`, …). The `users` table was **not** read.

## 2. World & maps

- 32×32 px tiles, orthogonal [OBS]. Each map has `floor_N` groups (multi-floor via `stairs` objects with `tp_x/tp_y/tp_z`) [OBS].
- Per floor: tile layers `bot_0..bot_3` (under actors), `top_0..top_2` (over actors), `markers`; object group `inst` [OBS].
- Tile behaviour comes from the tileset tile `type` [OBS]: `Obstruction`, `Wall`, `WallTop`, `VoidAll`, `Door`/`DoorOpen`, `Cade_100%…Cade_0%`, `HeavyCade_*`, `Fence_*`, `Shutter_*`, `Window`, `Boarded`, `Liquid`, `LiquidWave`, `WebTrap`, `Tree`, `Car`, `PickupItem`, `Switch`, `LightSwitch`, `Candle`, `LightBulb`, `StreetLight`.
- Barricades have 5 damage states laid out as consecutive tile ids (100/75/50/25/0 %) [OBS]; doors are 4 opening frames followed by the closed frame [OBS].
- Map object markers [OBS]: `PlayerSpawn`, `MobSpawn` (large rectangles along map edges), `Soilder` (pre-placed positions), `RanAmmo`, `RanHerb`, `RanMelee`, `Boarded`, `Boards`, `BlockP`/`BlockC`, `Car`, `Survivor`, `EvacZone`, `HeliSpawn`, `HeliWayPoint`, `SpawnTrigger`, `SpawnLocator`, `ScenarioSettings`.
- Map properties: `author`, `desc`, `season`, `time_of_day`, `weather` [OBS]; weather sprites exist for rain/snow [OBS].

## 3. Game modes

String table [OBS]: `Peaceful, Survival, Extermination, Rescue, Evac, BattleRoyale, DeathMatch`; spawn themes `Zeds, Spiders, Chaos, Mechs, BossRush` each backed by `spawn_levels_<theme>.rktd`.

Spawn group fields [OBS]: `mob-ids ((id weight)…)`, `delay` (seconds until group unlocks), `per-delay`, `max-mobs`, `execute` (`infinite`/`once`), `selection` (`random`/`sequential`), `advance-on-clear`. Zeds theme unlocks crows at 180 s, dogs 360 s, seekers 540 s, reptiles 720 s, venus plants 900 s, roachmen 1080 s and a random boss at 1260 s [OBS]. Exact meaning of `per-delay` [UNK]; remake treats it as a spawn budget per wave tick [INF].

Evac/Rescue use a helicopter (`tlcr::app::vehicles::Heli`, `heli` sprites, radio lines "head to the evac zone!") [OBS strings].

## 4. Player (`tlcr::app::human`)

- Components: `Human`, `HumanFlags`, `Stamina`, `FlashLight`, `Downed`, `Dead`, `Squad`, `Attract`, `Pathing`, `NPCAI` [OBS].
- Layered paper-doll: `body-nbase0..5`, `head-*`, `pupil`, `pants-*`, `ushirt-*`, `oshirt-*`, `hair-*`, `hat-*` [OBS, core_custom atlas].
- Animations: `walk, run, blink (idle), drawn, hurtidle, hurtwalk, tiredidle, sit, sleep, down, wink`, 4 directions [OBS].
- Downed state + teammate revive (`say_help_downed`, `Downed`) [OBS]; stamina gates running/tired idle [INF].
- Vitals HUD states: `fine, caution, danger, poison, down` [OBS sprites] → infection/poison exists [INF].
- Perk classes [OBS `perkinfo_en.rktd`]: Demo, Pyro, Sniper, Riot, Medic (6 perks each, 2 are "Frenzy" perks). Further class icons exist: Arms-Specialist, Chemist, Cryogenist, Mechanic, Infiltrator, Operator, Scavenger, Technologist, Virologist [OBS].

## 5. Weapons & items (`item_db.rktd`, 188 entries)

- 150 `weapon` records: handgun, smg, lmg, ar, shotgun, rifle, magnum, launcher, thrower, bow, special, rocket-launcher, melee, throwable, consumable, board, mine, key [OBS].
- Fields [OBS]: `damage, fire-rate (ms), fire-mode (normal/charged/chargable), mag/max-mag, speed (px/s), range (px), reload-time (ms), draw-time, weight, ammo-kind, shell-kind, crit-chance/crit-damage, stun-chance/stun-time, pierce, spread (pellets), spread-angle, ricochet, laser-sight, silencer, scope, dual-wield, cut-chance, hp-heal, cure, up-inv-cap`.
- Healing values are fractions of max HP (Herb-G 0.33, Herb-GG 0.66, Herb-RG 1.0) [OBS]; `cure` clears infection levels [INF].
- Crafting [OBS `crafting_recipes.rktd`]: herb mixing (R+G, G+B, G+G, GG+G, RG+B, R+BG) and gunpowder → ammo.
- Weapon upgrades [OBS `wep_upgrades.rktd`]: per weapon, `damage/max-mag/fire-rate/reload-time` levels `(value cost)`; coins come from kills (`CoinVfx`, `coin_pickup` sound) [INF].
- Drop tables [OBS `drop_chances.rktd`]: 4 weighted tables — ammo, on-kill (mostly `None` 4000), guns, melee [mapping to RanAmmo/kill/gun/RanMelee is INF]. `amount` 0.5 = half a full stack [INF].

## 6. Monsters (`tlcr::app::monster`, `mob_db.rktd`, 209 entries)

- Fields [OBS]: `hp, max-hp, armor, speed, collision, sounds, mutate, attacks[], dismem, body-id, legs-id, layers, eye-colors, death-attack`.
- Attack kinds [OBS]: `basic`, `rush` (dash within range), `tongue`/`tongue-ult` (grab: `Grabbed` component), `acid-spit`, `acid-h-spray`, `lay-web`, `spawn`.
- Zombies: `zed-{m,f,fm}-rand-d0..2` 200 HP, speed 24, bite 16 dmg / 1.5 s, rush 20 dmg range 96 [OBS]. Negative `sprite-id`/`body-id`/`legs-id` index parallel outfit groups in `outfits.rktd`: -1 fat bodies, -2 male, -3/-4 male dismembered (d1/d2), -5 female, -6/-7 female dismembered [OBS]. `legs-id 0` = legs matching the head outfit; `fat-*-rand` = zombie head on a fat body+legs (`body-id -1`, `legs-id -1`) [INF from data + atlas names, confirmed by rendering].
- Others: dogs (spd 128), crows, spiders (web, tongue), reptiles, seekers, venus plant, rats, roaches, bees, chickens, mechs (`DRAUGR-MK-II`, `LOKI-MARK-I`, `SKJOLD-MK-III` with Aseprite sources), bosses `gaia`, `abyss`, `t001–t008`, `chimera`, `corvus` (15k–60k HP) [OBS].
- Rendering layers `legs, body, head, eyes`, anims `walk, battack, rush, death, idle, mutate, whip, spit, run` [OBS].
- AI: navigation component `MonsterAINav`, pathfinding tile updates `PfindUpdateTile` (barricade state changes) [OBS names] → flow-field/grid pathing that re-plans when cades break [INF].

## 7. Interactables (`tlcr::app::tilemap`)

`Door, Cade, Boardable, Cage, Switch, Linkage, DeathTile, DeathItem, GlobalFlame, GlobalMolotov, GlobalRocketLauncher, SfxHit/Open/Close/Death` [OBS]. Boards are carried and nailed onto `Boarded` windows [INF from items + types]. Switch objects carry `links/link_id` to drive doors/elevators [OBS].

## 8. Lighting

`FlashLight`, `LightAnim`, `LightPat` components; `lightpats.rktd` holds flicker brightness sequences (0–255) [OBS]; light textures `light-256`, `light-spin`, `light-street` [OBS]. Maps place `LightBulb`, `Candle`, `StreetLight` objects [OBS].

## 9. Admin/debug commands [OBS strings]

`spawnzed, edit_light, dbg_spectate, skip_stage, skip_level, killm, start_vote, spawn_heli, change_map, set_interp, edit_weps, save_weps, edit_perks, setname, host_panel, dbg_minfo`.

## 10. What the remake reproduces (design choices marked)

| Feature | Remake |
|---|---|
| Real maps rendered from original Tiled data + atlases | Yes (6 maps, floor 0) |
| Tile collision from tile types | Yes |
| Doors (E to toggle), barricades with 5 damage states | Yes |
| Layered player paper-doll, 4-dir walk/run/idle/drawn | Yes |
| Stamina-limited sprint, flashlight + darkness lighting | Yes (light falloff values are design choices) |
| Weapons with original damage/fire-rate/mag/reload/range/pellets/pierce | Yes (subset loadout + pickups) |
| Melee, grenades with explosion | Yes |
| Zombies with random outfits, original HP/speed/attacks, rush | Yes |
| Grid flow-field pathing, attacking barricades | Yes (algorithm is a design choice) |
| Survival waves from `spawn_levels_zeds` timeline | Yes (time scaled; `per-delay` interpretation is INF) |
| Pickups from RanAmmo/RanHerb/RanMelee + kill drops | Yes |
| Herb mixing recipes, healing fractions, infection | Yes |
| Coins + weapon upgrades from `wep_upgrades` | Yes |
| Perk class choice (subset of perks) | Yes |
| Original audio: 349 SFX + 28 music tracks from the FMOD banks (FSB5, Vorbis codec 15, 256/2048 blocksizes) | Yes, mapped to events by sample name |
| Multi-floor maps: one `floor_N` group per floor; stairs are `STAMPS` objects with `tp_x/tp_y` (arrival) and `tp_z/32` (target floor) [OBS]. The trigger cell often sits on the void/door at the stairwell edge, so travel fires on touch [INF, verified on all 10 exported multi-floor maps] | Yes (zeds close behind and your squad follow you) |
| Friendly NPCs: `Soilder` markers (object name "Soldier") = soldiers, `Survivor` = civilians [INF from `NPCAI`/`Squad`/`Downed` components and `say_*` bark tables]. Names from `boy_names`/`girl_names` [OBS] | Yes: soldiers join your squad and fight, survivors call for help (`say_caged_help`) until rescued (`say_caged_free`), both can be downed and revived (`say_help_downed`, `quick_thanks`, `leader_down`) |
| Zed `rush` lunge attack | Present in data, **disabled** by design choice |
| Multiplayer, map editor, FMOD event graph, elevators (switch `link_id`), evac heli, bosses' special attacks | **Not reproduced** |
