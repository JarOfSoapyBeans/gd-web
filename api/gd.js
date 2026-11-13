// Vercel serverless proxy for the Geometry Dash web port.
// vercel.json rewrites /gd/<anything> to /api/gd?p=<anything>, so:
//   /gd/getGJLevels21.php      -> https://www.boomlings.com/database/getGJLevels21.php
//   /gd/audio-proxy?url=<song> -> fetches the song from Newgrounds / the GD song CDN

const AUDIO_HOSTS = ["audio.ngfiles.com", "geometrydashfiles.b-cdn.net"];

async function handle(request) {
  const url = new URL(request.url);
  const path = (url.searchParams.get("p") || "").replace(/^\/+/, "");
  url.searchParams.delete("p");

  let target;
  let init;

  if (path === "audio-proxy") {
    const song = url.searchParams.get("url") || "";
    let host = "";
    try { host = new URL(song).hostname; } catch {}
    if (!AUDIO_HOSTS.includes(host)) return new Response("Bad audio URL", { status: 400 });
    target = song;
    init = { method: "GET" };
  } else if (/^[A-Za-z0-9_]+\.php$/.test(path)) {
    const query = url.searchParams.toString();
    target = "https://www.boomlings.com/database/" + path + (query ? "?" + query : "");
    init = {
      method: request.method,
      // RobTop's server expects the game's format: a form body and no browser User-Agent.
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "",
      },
      body: request.method === "POST" ? await request.text() : undefined,
    };
  } else {
    return new Response("Not found", { status: 404 });
  }

  try {
    const upstream = await fetch(target, init);
    const headers = new Headers();
    const type = upstream.headers.get("content-type");
    if (type) headers.set("Content-Type", type);
    headers.set("Cache-Control", path === "audio-proxy" ? "public, max-age=86400" : "no-store");
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    return new Response("Upstream error: " + err.message, { status: 502 });
  }
}

export const GET = handle;
export const POST = handle;
