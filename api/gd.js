// Vercel serverless proxy for the Geometry Dash web port.
// vercel.json rewrites /gd/<anything> to /api/gd?p=<anything>, so:
//   /gd/getGJLevels21.php      -> https://www.boomlings.com/database/getGJLevels21.php
//   /gd/audio-proxy?url=<song> -> fetches the song from Newgrounds / the GD song CDN

const AUDIO_PREFIX = {
  "audio.ngfiles.com": "/ext/ng",
  "geometrydashfiles.b-cdn.net": "/ext/cdn",
  "geometrydashcontent.b-cdn.net": "/ext/cdn2",
};

async function handle(request) {
  const url = new URL(request.url);
  const path = (url.searchParams.get("p") || "").replace(/^\/+/, "");
  url.searchParams.delete("p");

  let target;
  let init;

  if (path === "audio-proxy") {
    // Songs are often bigger than Vercel's 4.5 MB function limit, so don't pipe them
    // through here. Redirect to a same-origin path that vercel.json rewrites straight
    // to the song host (rewrites have no size limit and stay same-origin, so no CORS issue).
    const song = url.searchParams.get("url") || "";
    let parsed;
    try { parsed = new URL(song); } catch {}
    const prefix = parsed && AUDIO_PREFIX[parsed.hostname];
    if (!prefix) return new Response("Bad audio URL", { status: 400 });
    return new Response(null, {
      status: 307,
      headers: { Location: prefix + parsed.pathname + parsed.search },
    });
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
export const HEAD = handle;
