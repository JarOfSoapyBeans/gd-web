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
bottom-left corner. Each mod can be switched on or off; **View → Settings** changes its options.
Everything is saved in your browser.

| Mod | What it does | Default keys |
|---|---|---|
| Speedhack | Runs the whole game (and music) slower or faster | `[` slower, `]` faster, `\` toggle 1× |
| Frame Stepper | Freezes the game and advances one frame at a time | `F` freeze, `G` step |
| FPS Counter | Shows the game's frame rate | – |
| Input Display | Shows jump/left/right inputs, clicks per second and total clicks | – |

How it works: the engine reads time from `performance.now()`/`Date.now()`, so the speedhack
scales those, plus the Web Audio playback rate and the engine's music-position function.
Freezing holds the engine inside its per-frame wait (`gd_js_yield_frame`), which the script
hooks when the engine's code is added to the page.
