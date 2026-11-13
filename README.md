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
