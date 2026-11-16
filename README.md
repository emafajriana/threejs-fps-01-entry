# EMBER QUAY — a round-based tactical FPS

A complete Counter-Strike-style tactical shooter in three.js, built for the
make.fun `threejs-fps-01` bounty. Single-player against bots, from static
files — no build step, no network request.

## The game

Five **Cinders** attack a decommissioned oil terminal at night; five
**Tidewatch** defend it. Plant the **Igniter** at the Crane Yard (A) or the
Tank Farm (B) — or stop the ones who do. First team to 6 rounds takes the
match.

- **Gunplay:** raycast hits with headshot bonuses, recoil and spread that
  punish firing on the move, acceleration-based movement, crouching for a
  steadier aim, and collision with the map. Stopping to aim pays.
- **Tactics:** plant/defuse objective at two sites, money earned each round
  spent in a buy menu (4 weapons + the Sunburst flash grenade), bots that
  follow waypoint routes, hold positions, investigate gunshots, and go blind
  when a flash pops in their face.
- **Weapons:** V9 sidearm, Hornet SMG, Harrier AR, Albatross DMR — tapping
  beats spraying. Press `G` to throw a Sunburst flash.
- **Map:** Ember Quay — a night harbour terminal with a gantry crane, oil
  tanks, a container canyon, a pier walk and a rail spur; sodium lamps
  against cold moonlight.
- **Code:** one job per module, a fixed-step (1/60 s) simulation kept apart
  from rendering, a single match state store, scratch vectors in the hot
  paths instead of per-frame allocation.

## Controls

| Key | Action |
| --- | --- |
| W A S D | Move |
| Mouse | Look (click the game to lock the pointer) |
| Click | Fire |
| R | Reload |
| Shift | Walk quietly |
| Ctrl / C | Crouch (steadier aim) |
| Space | Jump |
| B | Buy menu (buy phase) |
| E (hold) | Plant / defuse the Igniter |
| G | Throw a Sunburst flash grenade |
| 1 / 2 | Sidearm / primary weapon |
| Tab | Scoreboard |

## Run it

Serve `game/` with any static file server and open `index.html` in desktop
Chrome, e.g. `node serve.ts` is not needed — `python3 -m http.server`
inside `game/` works too.

## Layout

- `game/index.html` — the page, HUD and import map (`three` only)
- `game/src/palette.js` — art direction, canvas-painted textures
- `game/src/world.js` — the map: boxes, colliders, waypoint graph, sight tests
- `game/src/input.js` — keyboard and mouse state
- `game/src/audio.js` — synthesized WebAudio sounds (no audio files)
- `game/src/weapons.js` — the armoury and the viewmodels
- `game/src/player.js` — the first-person body
- `game/src/bots.js` — bot soldiers and their AI
- `game/src/hud.js` — every DOM readout
- `game/src/main.js` — the match brain: rounds, economy, shooting, staging
- `game/vendor/three/` — three.js 0.187.0, byte for byte from the kit
- `main.ts` — the entry program: copies `game/` + `screenshots/` to
  `/output` and writes `dossier.json` (Node 22, standard library only)

## License

MIT — see `LICENSE`.
