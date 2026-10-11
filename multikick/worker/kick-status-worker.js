// Cloudflare Worker for Multi Kick Viewer: tells the app which Kick channels are live.
//
//   GET https://<your-worker>.workers.dev/?c=slug1,slug2
//   -> {"ok":true,"live":{"slug1":true,"slug2":false},"info":{"slug1":{"viewers":1234,"title":"...","category":"..."}}}
//
// Browsers can't ask Kick directly (no CORS), so this runs on Cloudflare and adds the CORS header.
// Set KICK_CLIENT_ID and KICK_CLIENT_SECRET (from https://kick.com/settings/developer) under
// Settings → Variables and Secrets to use Kick's official API. Without them it tries kick.com's
// site API, which Kick's bot protection usually blocks.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
// Kick slugs use "-" where usernames have "_".
const slugOf = (name) => name.replace(/_/g, '-');

let token = null;
let tokenExpires = 0;

async function getToken(env) {
  if (token && Date.now() < tokenExpires) return token;
  const r = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.KICK_CLIENT_ID,
      client_secret: env.KICK_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`Kick login failed (${r.status}): check KICK_CLIENT_ID / KICK_CLIENT_SECRET`);
  const d = await r.json();
  token = d.access_token;
  tokenExpires = Date.now() + Math.max(60, (d.expires_in || 3600) - 300) * 1000;
  return token;
}

async function fetchChannels(slugs, env) {
  const q = new URLSearchParams();
  slugs.forEach((s) => q.append('slug', s));
  const call = async () => fetch(`https://api.kick.com/public/v1/channels?${q}`, {
    headers: { Authorization: `Bearer ${await getToken(env)}`, Accept: 'application/json' },
  });
  let r = await call();
  if (r.status === 401) { token = null; r = await call(); }  // token revoked early
  return r;
}

async function viaOfficialApi(names, env) {
  const live = {}, info = {};
  const record = (data) => {
    for (const ch of data || []) {
      const slug = String(ch.slug).toLowerCase();
      live[slug] = !!(ch.stream && ch.stream.is_live);
      if (live[slug]) info[slug] = { viewers: ch.stream.viewer_count, title: ch.stream_title, category: ch.category && ch.category.name };
    }
  };
  const slugs = names.map(slugOf);
  const r = await fetchChannels(slugs, env);
  if (r.ok) record((await r.json()).data);
  else if (r.status === 400 || r.status === 404) {
    // One bad name can fail the whole batch: ask one at a time instead.
    for (const s of slugs) {
      const one = await fetchChannels([s], env);
      if (one.ok) record((await one.json()).data);
    }
  } else throw new Error(`Kick API error (${r.status})`);
  // Channels Kick didn't return don't exist, so they are not live.
  return {
    live: Object.fromEntries(names.map((n) => [n, live[slugOf(n)] === true])),
    info: Object.fromEntries(names.filter((n) => info[slugOf(n)]).map((n) => [n, info[slugOf(n)]])),
  };
}

async function viaSiteApi(names) {
  const live = {}, info = {};
  await Promise.all(names.slice(0, 40).map(async (n) => {
    const r = await fetch(`https://kick.com/api/v2/channels/${slugOf(n)}`, { headers: { Accept: 'application/json' } });
    if (r.status === 404) { live[n] = false; return; }
    if (!r.ok) throw new Error(`kick.com blocked the request (${r.status}): set KICK_CLIENT_ID and KICK_CLIENT_SECRET`);
    const ls = (await r.json()).livestream;
    live[n] = !!ls;
    if (ls) info[n] = { viewers: ls.viewer_count, title: ls.session_title };
  }));
  return { live, info };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const names = [...new Set((new URL(request.url).searchParams.get('c') || '')
      .toLowerCase().split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9_-]{1,25}$/.test(s)))].slice(0, 50);
    const mode = env.KICK_CLIENT_ID && env.KICK_CLIENT_SECRET ? 'official' : 'site';
    if (!names.length) return json({ ok: true, mode });
    try {
      const { live, info } = mode === 'official' ? await viaOfficialApi(names, env) : await viaSiteApi(names);
      return json({ ok: true, mode, live, info });
    } catch (e) {
      return json({ ok: false, mode, error: String((e && e.message) || e) }, 502);
    }
  },
};
