# Geometry Dash Web (with private proxy)

Browser port of Geometry Dash (from gn-math / `web-ports/geometry-dash`), with its own
online-levels proxy so you don't depend on the shared, overloaded public proxies.

## Deploy
1. Push this repo to GitHub.
2. On vercel.com: **Add New → Project → Import** this repo. Leave every setting on default → **Deploy**.
3. Open your `*.vercel.app` URL and play.

## How it works
- `index.html` – the game. Its files load from `raw.githubusercontent.com/web-ports/geometry-dash`.
- `api/gd.js` – a serverless function that forwards online requests to RobTop's server
  (`www.boomlings.com/database`) and songs from Newgrounds.
- `vercel.json` – maps `/gd/*` on your site to that function.

The game tries your own `/gd` proxy first. If it fails (error 429/5xx or a 30 s timeout),
it falls back to the original webdashers workers, then api.sngdu.com and api.ixl.college.

## Quick test
Visit `https://<your-site>.vercel.app/gd/getGJLevels21.php`. A short reply like `-1`
means the proxy reached RobTop's server. A Vercel error page means the function didn't deploy.

## DashMods (mod menu)
`mods/gd-mods.js` adds an in-game mod menu. Open it with **Tab** or the purple button in the
right edge of the screen. Each mod can be switched on or off; **View → Settings** changes its options.
Everything is saved in your browser.

| Mod | What it does | Default keys |
|---|---|---|
| Speedhack | Runs the whole game (and music) slower or faster | `[` slower, `]` faster, `\` toggle 1× |
| Frame Stepper | Freezes the game and advances one frame at a time | `F` freeze, `G` step |
| FPS Counter | Shows the game's frame rate | – |
| Input Display | Shows jump/left/right inputs, clicks per second and total clicks | – |
| Startpos Switcher | In online levels that contain start positions, jumps between them and restarts there | `Q` previous, `E` next |
| Practice Stats | Attempts, deaths, time in level, current and longest attempt | optional reset key |
| Fast Loading (on by default) | Caches the ~366 MB of game files in the browser (service worker `sw.js`) so later visits start fast | – |
| Save Backup | Download progress as a file, restore it (with undo) | – |
| Fullscreen Key (on by default) | Toggle fullscreen | `F2` |
| Auto Pause (on by default) | Pauses the level when you switch tabs or click away | – |
| Hide Cursor | Hides the mouse pointer while playing | – |
| Texture Pack | Recolor the game's textures (hue/saturation/brightness/contrast, invert, black-and-white, per group) or load an uploaded pack (.zip or files) | – |
| Smooth Autosave (on by default) | Holds the 10-second autosave while you're playing a level; saves on pause, leaving the level, switching tabs, or every 3 minutes | – |

How it works: the engine reads time from `performance.now()`/`Date.now()`, so the speedhack
scales those, plus the Web Audio playback rate and the engine's music-position function.
Freezing holds the engine inside its per-frame wait (`gd_js_yield_frame`), which the script
hooks when the engine's code is added to the page.

Startpos Switcher: when a level downloads (`downloadGJLevel22`), every start position except the
selected one gets the 2.2 "Disable" flag (`kA21`), the level data is padded to a fixed length and
its checksum is recomputed. Switching overwrites that level data in the game's memory with the
version for the new selection, then exits to the level page and presses Play (queued as the same
input messages the page sends). Q/E only act while you're in that level, so the editor's Q/E
rotation is unaffected. Turn the mod on before opening a level's page. During a switch the game
clock runs ~6x (menu fades run on game time) under a cover screen, and the level data's memory
location is found in the background while you play so switches don't have to search again.

Texture Pack: the engine looks for every texture in `/AppData/` before `/Resources/`, so the mod
writes replacement files into `/AppData/` in the engine's virtual file system just before the game
starts (a hook added to `gd_web.js` as it loads). Originals are never modified; with the mod off
nothing is written. Recolored textures are cached in IndexedDB (`dashmods` → `textures`). Uploaded
packs use normal Geometry Dash names (e.g. `GJ_GameSheet03-uhd.png` + `.plist`); leading folders such
as `MyPack/resources/` are stripped automatically.
