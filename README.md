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
- **Mission board:** host-pick or vote the next map, mode, spawn theme, difficulty and **zombie count** (Few ×0.5, Normal, Many ×1.5, Swarm ×2, Apocalypse ×3: scales the starting zeds, the live cap and the spawn rate). Host pick and vote offer exactly the same options; *Join & deploy at start* or *Join — I'll walk in*. If nobody joined, the round is skipped. A started round runs even if you stay behind: spectate it, or walk out a green **DEPLOY** door to teleport in. A round nobody deploys into ends after 150 s.
- **Class & survivor are remembered**: the title shows one ENTER LOBBY button; "Change class / survivor" (also in the pause menu) reopens the picker. Classes differ only by perks: everyone starts with the basic Beretta92.
- **Weapon tiers (T1 Scrap → T5 Legendary)** come from each weapon's stats (sustained DPS, time-to-kill on a 200 HP zed, range, mag, reload). Each armory card shows the weapon's tier and stats. Maps only spawn T1–T2 weapons at the start; the ceiling rises by one tier every 6 minutes (max T4) and bosses drop one tier higher.
- **Inventory persists between runs**: weapons you buy or pick up stay with you, even if you die. Spares go in the **storage locker** in the lobby (4 slots, upgradable to 12 at the merchant). Buying with a full inventory sends the weapon to storage.
- **Armory:** one row of tables beside the spawn room (two categories per table). Walk up to any table to open the armory screen: tabs switch between every category (melee, handguns, magnums, SMGs, shotguns, ARs, rifles, LMGs, specials, throwables, ammo, medical) without walking around. Weapons are unlocked permanently with coins and are free to re-pick each round; ammo, throwables, mines and meds cost coins per purchase.
- **Merchant:** permanent weapon upgrades (original wep_upgrades levels) and inventory upgrades: weapon slots 3→5, ammo slots 2→6, throwables pouch.
- **Coins:** the HUD shows your real bank balance, plus `+N` for what the current run will pay out. Nothing is earned in the base; time only counts on a real map. Coins are paid at the end of a match: kills ×3 + 2 per 10 s alive + 150 objective bonus, × difficulty (Easy 0.6, Normal 1, Hard 1.6, Nightmare 2.4). Saved in the browser.
- **Inventory:** generic weapon slots; ammo lives in typed slots (auto top-up only for a type you already carry, new types need Use); grenades/mines/molotovs are a separate counted pouch, switched with Toggle throwable (T / △ / hold NADE).
- **Shooting** is hitscan: no visible bullets, impacts show on the zombie or wall; recoil bloom and range falloff. Explosives and flamethrowers stay projectiles.
- **Spawns** follow the original MobSpawn rects (map edges), never on screen or within 480 px; floors without reachable rects use the outer ring of the playable area. Infected climb through windows.
- **Minimap** (top right; top centre on phones, toggle in Settings): the whole floor, you as a white arrow, teammates as blue dots with their initial (flashing red when down), nearby zeds, survivors and the way out.
- **Votes** tally every connected player in co-op (most votes wins, ties go to the host); solo, your vote decides.

## Online co-op (up to 4)

- **Title → 🌐 Co-op online:** *Host a game* opens a room and shows a 5-letter code; friends type it under *Join a friend*. No account or server: players connect peer-to-peer over WebRTC through the free PeerJS matchmaker (`js/vendor/peerjs.min.js`, MIT). Some strict school/work networks block WebRTC.
- **Who runs what:** the host simulates the zeds, spawns, NPCs, objectives and the round timer. Each player simulates their own survivor, so movement and shooting feel instant. Hits are sent to the host, which applies them and reports kills back.
- **Loot and coins are per player:** whoever lands the kill rolls the drop on their own map, and everyone keeps their own coins, weapons and records. The party list shows every player's bank balance.
- **Down, not out:** at 0 HP with a teammate still standing you go DOWN for 25 s. You can crawl, and zeds keep chewing on you, which shortens the timer. A teammate holds USE next to you for 2.5 s to pick you up at 30% HP (+15 coins for them).
- **Your death ends your run, not the round:** you get your results and go back to the base, and can spectate the rest from the mission board. The round ends when the objective is done or nobody is left standing.
- **Squad play:** the squad deploys together. Stairs move the whole team to the new floor. Hordes grow by 60% for each extra survivor.
- **Menus don't pause** a co-op game; they only take your hands off the controls.
- **Testing locally:** open `http://localhost:8123/?net=local` in two tabs. They connect through a `BroadcastChannel` instead of the internet.

## Survival director (`js/survival.js`)

- **Endless threat:** after minute 3, each minute adds +10% zed HP and +6% zed damage. Spawns speed up, and the population cap keeps growing past the old ceiling of 50. THREAT is shown under the HUD.
- **Horde nights:** the first comes at 4:00, then one every 5 minutes. A siren gives a 12 s warning. Then the screen turns red, spawns pour in from every edge and every zed hunts you for 75 s, and each later horde lasts longer. Survive it and a supply drop lands next to you (ammo, herbs, a weapon roll).
- **Elites:** these show a coloured ring and get more common with threat and during hordes.
  - **Armored** (grey) takes 35% less damage.
  - **Frenzied** (red) is fast.
  - **Bloated** (green) bursts into acid when it dies.
- **Scarcity:** kill drops thin out after minute 4 (down to 40%), so crafting and melee start to matter.
- **Brutal feedback:**
  - **Gore:** kills throw gibs that splatter as decals (toggle in Settings; Medic *Sanitation* also hides them).
  - **Kill streaks:** CARNAGE → BRUTAL → SLAUGHTER → MASSACRE → UNSTOPPABLE.
  - **Damage pulse:** the screen edges glow red in proportion to the hits you take.
- **Records:** best time for each map · mode · difficulty, plus the most hordes survived and highest threat reached. The results screen shows NEW RECORD or how far short you fell, and the cause of death.

## Platform support

- **Auto fullscreen:** goes fullscreen when you enter the base (Settings → *Auto fullscreen*). Pause has a ⛶ button to toggle it. A blocked attempt, such as from a controller press, retries on your next tap or key. iPhone has no browser fullscreen, so the title shows an *Add to Home Screen* hint.
- **Losing focus pauses solo games:** this covers switching apps or tabs, a controller disconnecting, and the window losing focus. Audio is suspended while the game is hidden. The screen is kept awake (Wake Lock).
- **Touch:** phones start in touch mode. Long-press menus, pinch zoom, text selection and pull-to-refresh are blocked. Android phones buzz on hits and blasts. Menus respect notches and safe areas.

## Game modes & original features

- **Modes** (from the exe's mode table): Survival (endless), Extermination (kill 120), Evac (helicopter arrives at 3:00, stand in the landing ring to escape), Rescue (find every survivor, then evac), Peaceful (no infected). Battle Royale / Death Match are PvP and not included.
- **Siege (solo, persistent campaign):** hold a fortified building (the sealed interior nearest the spawn) night after night. By day you gather scrap piles, board windows and spend scrap at the workbench (barricades, barracks, armory, field hospital, floodlights); recurring named survivors arrive, defend a post and drift away or fall. At dusk a siren announces the horde's size and the compass sides it comes from, then 3–7 waves hit at night; survive to dawn for scrap, supplies and a bigger next night. Saved per map in the browser (`tlcr-siege-v1`); dying costs 25% scrap and you retry that night. Infected never spawn inside buildings. Code: `js/siege.js`.
- **Spawn themes** from `spawn_levels_*.rktd`: Zeds, Spiders, Chaos, Mechs (original DRAUGR / LOKI / SKJOLD robot sprites), Boss Rush.
- **Evac helicopter**: flies in to the map's `EvacZone`/`HeliSpawn` marker with the original radio line, rotor loop and landing wind; an arrow points to it when off-screen.
- **Boss / mob abilities** from `mob_db`: tongue attacks grab and reel you in (attack or jump to struggle free), spiders lay webs that slow you (plus the maps' WebTrap tiles), the spider queen spawns minions.
- **Mines** (Mine, Incendiary, Nitro, Acid): place with **N** or from the inventory; they arm after 1 s and trigger on infected.
- **Fire**: Molotovs, incendiary grenades/mines and fire explosions leave burning ground (Pyro *Scorched* / *Inferno* apply).
- **Weather**: rain with thunder flashes, or snow, with the original ambience loops (toggle in Settings).

## Controls

Every action can be rebound in **Settings** (main menu or pause): keyboard/mouse (two bindings each, conflicts flagged red), controller buttons, and touch (size, opacity, left-handed mirror, and which action each on-screen button performs). Settings persist in `localStorage`.

- **PS5 DualSense / gamepads** (standard mapping): left stick move (L3 run), right stick aim, R2 fire, L1 throw, ✕ use-or-jump (contextual), ○ jump, □ reload (hold: place mine), △ next throwable (hold: heal), R1 next weapon, L2 last weapon, D-pad weapon slots, R3 frenzy, Options pause (hold Options: inventory). Rumble on shots, hits and explosions. Menus: ✕ select, ○ back.
- **PS4 DualShock 4 and Xbox controllers** work the same way (Xbox button names are shown automatically, or pick them in Settings → Controller). Browsers that don't recognise a controller (Firefox with PlayStation pads, some Android / Fire OS browsers) report a raw layout; the game translates it to the standard one, including a D-pad reported as a hat axis.
- **Tablets (Amazon Silk / Fire OS, Android):** the default layout never uses Create/Share, the PS / Xbox button or the touchpad, which those browsers grab for their own menus. Browser keys a controller sends (Back, Menu, media keys) are swallowed during play, the touchpad-as-mouse doesn't flip the HUD, and if ○ / B triggers the browser's Back the game opens the pause menu instead of leaving the page. Settings → Controller has a live button tester.
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
- `js/net.js`: co-op transport (PeerJS WebRTC, or BroadcastChannel with `?net=local`), room codes, star topology
- `js/coop.js`: co-op glue: snapshots, mirrored zeds and NPCs on clients, hit/kill relay, avatars, down and revive, party HUD
- `js/survival.js`: survival director: endless threat, horde nights, elites, gore, kill streaks, damage pulse
- `js/sfx.js`: plays the original FMOD sounds (positional SFX, music playlist, boss/menu/death themes, volume settings)
- `tools/fsb5.js`: converts FMOD `sfx.bank` / `music.bank` (FSB5 Vorbis) into standalone `.ogg` files in pure Node. FMOD strips the Vorbis setup headers, so they are restored from vgmstream's table (`tools/vendor/vorbis_codebooks_fsb.h`).

## Audio

- **Base music: Sake (Tethered mix)** (default). An original suspense arrangement: Sake slowed and pitched down 2 semitones, under a creeping pizzicato ostinato, tremolo cellos, swelling violin clusters, a wordless "ooh" choir, heartbeat and timpani hits. Everything except the Sake stem is synthesised (`tools/tethered-mix.py`, no samples), and every part follows Sake's Ab / F# bass. Switch back to the original in Settings → Audio.

`tools/extract.js` exports all 349 sound effects and 28 music tracks from the original banks to `assets/audio/` (≈29 MB) with a manifest. Gunshots are matched to each weapon by name (e.g. `spas-12-fire`, `ak47-fire`), mobs use their family's moan/attack/pain/death sets, and the player's hurt/death sounds follow the survivor's gender. Music: *Save Room (RE0)* on the menu, a shuffled playlist in game, *Plant 42 – Boss Theme* when a boss appears, *Secure Place* on death. Volumes are in Settings → Gameplay; M mutes.

Event-to-sample mapping is by sample name. The original FMOD event graph (`sound-events.rktd` GUIDs) was not decoded. Ogg Vorbis plays in Chrome, Edge, Firefox and Android; older iOS Safari versions may not decode Ogg.

## Optional: your own free matchmaking server

Co-op connects through the free public PeerJS matchmaker by default. For more reliable rooms (no shared rate limits) deploy the tiny signaling server in `server/` for free on Render (one click via `render.yaml`, steps in `server/README.md`), then set `BROKER` in `js/config.js`. The game tries your server first and falls back to the public one automatically. `js/config.js` also lists extra STUN/TURN relays so phones on mobile data can connect. Test any server with `?broker=host:port` in the URL on every device.

## Drop-in rounds, host-run matches, doors
- Rounds auto-start and drop everyone in the room (including late joiners) — no queuing. The host can turn **Auto-start rounds** off on the mission board and press **Start match now** when ready.
- **Change class / survivor** from the pause menu without leaving the room; settings are there too.
- Closing a door on yourself now shoves you clear, and being wedged inside a solid tile frees you automatically.
