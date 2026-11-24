// API do site em api.joaocostart.com (Cloudflare Worker + D1).
// Substitui a parte "viva" do app.py: comentários, registos, visitas, notificações,
// etiquetas, links personalizados e utilizadores. O conteúdo (escritas, posts, fotos)
// fica no GitHub e é gravado diretamente pelo admin (static/admin-shim.js).

const SESSION_GAP = 30 * 60; // 30 min sem atividade = visita nova
const KEEP_DAYS = 90;
const BOTS = /bot|crawl|spider|slurp|facebookexternalhit|preview|fetch|curl|wget|python|monitor|headless/i;
const SECTION_NAMES = { musica: "música", escrita: "escrita", podcast: "podcast", opinioes: "opinião" };

// ---------------- utilidades ----------------
const enc = new TextEncoder();
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const rawJson = (s, status = 200) => new Response(s, { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const text = (s, status = 200) => new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const empty = () => new Response(null, { status: 204 });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const rid = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const tokenUrlsafe = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));

// hora de Portugal, no formato do app.py: 2026-11-24T10:05:03
function nowISO(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
const ago = (sec) => nowISO(new Date(Date.now() - sec * 1000));
const tdiff = (a, b) => (Date.parse(a + "Z") - Date.parse(b + "Z")) / 1000; // segundos entre dois nowISO

async function body(req) { try { return await req.json(); } catch { return {}; } }

// ---------------- D1 ----------------
async function kvGet(env, k, def) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind(k).first();
  return r ? JSON.parse(r.v) : def;
}
const kvSet = (env, k, v) => env.DB.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, JSON.stringify(v)).run();

async function userFromToken(env, token) {
  token = String(token || "");
  if (token.length < 20) return [null, null];
  const r = await env.DB.prepare("SELECT u.uid, u.data FROM tokens t JOIN users u ON u.uid=t.uid WHERE t.h=?").bind(await sha256(token)).first();
  return r ? [r.uid, JSON.parse(r.data)] : [null, null];
}

// ---------------- localização (Cloudflare já sabe) ----------------
let regionNames;
function geoOf(req) {
  const cf = req.cf || {};
  let country = cf.country || "";
  try { regionNames ||= new Intl.DisplayNames(["pt-PT"], { type: "region" }); country = country ? regionNames.of(country) : ""; } catch { /* fica o código */ }
  return [cf.city, country].filter(Boolean).join(", ");
}
const ispOf = (req) => (req.cf && req.cf.asOrganization) || "";
const ipOf = (req) => req.headers.get("CF-Connecting-IP") || "";

// ---------------- conteúdo publicado (para títulos) ----------------
let contentCache = { t: 0, items: [], posts: [] };
async function content(env) {
  if (Date.now() - contentCache.t < 60_000) return contentCache;
  try {
    const [items, posts] = await Promise.all(["items", "posts"].map((x) =>
      fetch(`${env.SITE}/api/${x}`, { cf: { cacheTtl: 60 } }).then((r) => (r.ok ? r.json() : []))));
    contentCache = { t: Date.now(), items, posts };
  } catch { /* mantém o anterior */ }
  return contentCache;
}
async function pageTitle(env, key) {
  const [sec, pid] = key.split("/");
  const c = await content(env);
  const src = sec === "opinioes" ? c.posts : c.items.filter((i) => i.section === sec);
  const x = src.find((x) => x.id === pid);
  return x ? x.title : null;
}
async function pageName(env, path) {
  const [a, b] = path.replace(/^\/+|\/+$/g, "").split("/");
  if (!a) return "início";
  if (b) return `${a}: ${(await pageTitle(env, `${a}/${b}`)) || b}`;
  return a;
}

// ---------------- tradução automática (comentários) ----------------
async function translateEN(s) {
  if (!s || !s.trim()) return "";
  try {
    const r = await fetch("https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=pt&tl=en", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0" },
      body: new URLSearchParams({ q: s }),
    });
    const flat = (d) => (typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => flat(Array.isArray(x) ? x[0] : x)).join("") : "");
    return flat(await r.json());
  } catch { return ""; }
}

function publicComment(c, pictures = {}) {
  const out = {};
  for (const k of ["id", "name", "ig", "text", "t", "reply", "text_tr", "reply_tr"]) if (c[k]) out[k] = c[k];
  if (c.uid && pictures[c.uid]) out.picture = pictures[c.uid];
  return out;
}

function cleanIg(v) {
  const ig = String(v || "").trim().replace(/^@+/, "").replace(/\/+$/, "").split("/").pop().slice(0, 30);
  return /^[A-Za-z0-9._]{1,30}$/.test(ig) ? ig : ig ? null : "";
}
function whoLabel(name, ig) {
  name = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);
  ig = String(ig || "").trim().replace(/^@+/, "").slice(0, 30);
  ig = /^[A-Za-z0-9._]{1,30}$/.test(ig) ? ig : "";
  return name || ig ? (name + (ig ? ` (@${ig})` : "")).trim() : "";
}

// ---------------- visitas ----------------
function device(ua) {
  const d = /Mobi|Android|iPhone/.test(ua) ? "telemóvel" : /iPad|Tablet/.test(ua) ? "tablet" : "computador";
  const b = [["Edg/", "Edge"], ["OPR/", "Opera"], ["SamsungBrowser", "Samsung"], ["Firefox/", "Firefox"], ["FBAN", "Facebook"],
    ["Instagram", "Instagram"], ["Chrome/", "Chrome"], ["Safari/", "Safari"]].find(([k]) => ua.includes(k));
  return `${d} · ${b ? b[1] : "outro"}`;
}
const IPHONES = {"iPhone11,2":"iPhone XS","iPhone11,4":"iPhone XS Max","iPhone11,6":"iPhone XS Max","iPhone11,8":"iPhone XR","iPhone12,1":"iPhone 11","iPhone12,3":"iPhone 11 Pro","iPhone12,5":"iPhone 11 Pro Max","iPhone12,8":"iPhone SE (2.ª)","iPhone13,1":"iPhone 12 mini","iPhone13,2":"iPhone 12","iPhone13,3":"iPhone 12 Pro","iPhone13,4":"iPhone 12 Pro Max","iPhone14,4":"iPhone 13 mini","iPhone14,5":"iPhone 13","iPhone14,2":"iPhone 13 Pro","iPhone14,3":"iPhone 13 Pro Max","iPhone14,6":"iPhone SE (3.ª)","iPhone14,7":"iPhone 14","iPhone14,8":"iPhone 14 Plus","iPhone15,2":"iPhone 14 Pro","iPhone15,3":"iPhone 14 Pro Max","iPhone15,4":"iPhone 15","iPhone15,5":"iPhone 15 Plus","iPhone16,1":"iPhone 15 Pro","iPhone16,2":"iPhone 15 Pro Max","iPhone17,3":"iPhone 16","iPhone17,4":"iPhone 16 Plus","iPhone17,1":"iPhone 16 Pro","iPhone17,2":"iPhone 16 Pro Max","iPhone17,5":"iPhone 16e","iPhone18,1":"iPhone 17 Pro","iPhone18,2":"iPhone 17 Pro Max","iPhone18,3":"iPhone 17","iPhone18,4":"iPhone Air"};
function uaModel(ua) {
  let m = ua.match(/(iPhone\d+,\d+)/);
  if (m) return IPHONES[m[1]] || m[1];
  m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build\/|\)|;)/);
  if (m && !["K", "wv", "Mobile"].includes(m[1].trim())) return m[1].trim().slice(0, 40);
  return "";
}
function uaApp(ua) {
  for (const [k, n] of [["Instagram", "app do Instagram"], ["FBAN", "app do Facebook"], ["FBAV", "app do Facebook"], ["FB_IAB", "app do Facebook"],
    ["Messenger", "Messenger"], ["musical_ly", "TikTok"], ["BytedanceWebview", "TikTok"], ["LinkedInApp", "LinkedIn"]]) if (ua.includes(k)) return n;
  return "";
}
const REF_NAMES = [["facebook.", "Facebook"], ["fb.", "Facebook"], ["instagram.", "Instagram"], ["google.", "Google"], ["bing.", "Bing"],
  ["duckduckgo.", "DuckDuckGo"], ["whatsapp", "WhatsApp"], ["wa.me", "WhatsApp"], ["t.co", "X/Twitter"], ["twitter.", "X/Twitter"],
  ["tiktok.", "TikTok"], ["youtube.", "YouTube"], ["linkedin.", "LinkedIn"]];
function sourceOf(r) {
  if (r.tag) return `link para ${r.tag}`;
  const app = uaApp(r.ua || "");
  const host = r.ref ? r.ref.replace(/^https?:\/\/(www\.|m\.|l\.|lm\.)?([^/]+).*/, "$2") : "";
  const f = REF_NAMES.find(([k]) => host.includes(k));
  const name = f ? f[1] : host;
  if (app && (!name || app.toLowerCase().includes(name.toLowerCase()))) return app;
  return name ? name + (app ? ` (${app})` : "") : app || "direto";
}
async function rdns(ip) {
  if (!ip) return "";
  try {
    let name;
    if (ip.includes(":")) return ""; // IPv6: sem DNS inverso
    name = ip.split(".").reverse().join(".") + ".in-addr.arpa";
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=PTR`, { headers: { Accept: "application/dns-json" } });
    const d = await r.json();
    return ((d.Answer || []).find((a) => a.type === 12)?.data || "").replace(/\.$/, "").slice(0, 120);
  } catch { return ""; }
}
const isMe = (r, labels) => !!((labels[`vid:${r.vid}`] || {}).me || (labels[`ip:${r.ip}`] || {}).me);

// ---------------- notificações ----------------
async function notifyCfg(env) {
  let c = await kvGet(env, "notify", {});
  if (!c.topic) { c = { topic: "site-" + rid(8), visits: true, comments: true, ...c }; await kvSet(env, "notify", c); }
  return c;
}
async function sendWhatsapp(c, title, message, click = "") {
  const t = `*${title}*\n${message}` + (click ? `\n${click}` : "");
  try {
    const r = await fetch(`https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(c.wa_phone)}&text=${encodeURIComponent(t.slice(0, 1500))}&apikey=${encodeURIComponent(c.wa_key)}`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; site)" } });
    const b = (await r.text()).slice(0, 2000);
    return [!b.toLowerCase().includes("error"), b.replace(/<[^>]+>/g, " ").trim().slice(0, 300)];
  } catch (e) { return [false, String(e)]; }
}
async function push(env, title, message, tags, click = "") {
  const c = await notifyCfg(env);
  const jobs = [];
  if (c.ntfy_on !== false) {
    const b = { topic: c.topic, title: title.slice(0, 200), message: message.slice(0, 3000), tags };
    if (click) b.click = click;
    jobs.push(fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).catch(() => {}));
  }
  if (c.wa_on && c.wa_phone && c.wa_key) jobs.push(sendWhatsapp(c, title, message, click));
  jobs.push(sendPushAll(env, title, message, click));
  await Promise.all(jobs);
}

// --- Web Push (RFC 8291/8292) com WebCrypto ---
async function vapid(env) {
  let k = await kvGet(env, "vapid", null);
  if (!k) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    k = { jwk: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) };
    await kvSet(env, "vapid", k);
  }
  return k;
}
async function hkdf(salt, ikm, info, n) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, n * 8));
}
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function webpush(env, sub, data) {
  const v = await vapid(env);
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, secret, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, cat(enc.encode(JSON.stringify(data)), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPub.length;
  const u = new URL(sub.endpoint);
  const h = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const cl = b64u(enc.encode(JSON.stringify({ aud: u.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.SITE })));
  const sk = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, sk, enc.encode(`${h}.${cl}`)));
  try {
    const r = await fetch(sub.endpoint, { method: "POST", body: cat(head, asPub, ct), headers: {
      Authorization: `vapid t=${h}.${cl}.${sig}, k=${v.pub}`, "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "normal" } });
    return r.status;
  } catch { return 0; }
}
async function sendPushAll(env, title, message, click) {
  const subs = await kvGet(env, "push", []);
  if (!subs.length) return;
  const codes = await Promise.all(subs.map((s) => webpush(env, s, { title, body: message, url: click || "/admin" })));
  const gone = subs.filter((s, i) => [404, 410].includes(codes[i])).map((s) => s.endpoint);
  if (gone.length) await kvSet(env, "push", (await kvGet(env, "push", [])).filter((x) => !gone.includes(x.endpoint)));
}

async function notifyRegister(env, name, ig) {
  if ((await notifyCfg(env)).comments)
    await push(env, `Novo registo: ${name}` + (ig ? ` (@${ig})` : ""), "Alguém registou-se no site.", ["wave"], `${env.SITE}/admin#comentarios`);
}
async function notifyComment(env, c) {
  if (!(await notifyCfg(env)).comments) return;
  const title = (await pageTitle(env, c.page)) || "";
  const who = c.name + (c.ig ? ` (@${c.ig})` : "");
  await push(env, `Novo comentário de ${who}`, `Em: ${title}\n\n${c.text}`, ["speech_balloon"], `${env.SITE}/admin#coments`);
}
async function notifyVisit(env, rec, prevT) {
  const cfg = await notifyCfg(env);
  const labels = await kvGet(env, "labels", {});
  if (!cfg.visits || isMe(rec, labels)) return;
  if (prevT && tdiff(rec.t, prevT) < SESSION_GAP) return; // mesma visita, outra página
  const lines = [];
  if (rec.vid) {
    const ts = (await env.DB.prepare("SELECT t FROM visits WHERE vid=? ORDER BY t").bind(rec.vid).all()).results.map((r) => r.t);
    let k = 0, last = null;
    for (const t of ts) { if (!last || tdiff(t, last) > SESSION_GAP) k++; last = t; }
    const n = (await env.DB.prepare("SELECT COUNT(*) n FROM (SELECT MIN(t) m FROM visits WHERE vid IS NOT NULL GROUP BY vid) WHERE m <= ?").bind(ts[0] || rec.t).first()).n;
    const who = (await env.DB.prepare("SELECT json_extract(data,'$.who') w FROM visits WHERE vid=? AND json_extract(data,'$.who') IS NOT NULL ORDER BY t DESC LIMIT 1").bind(rec.vid).first())?.w;
    const lab = labels[`vid:${rec.vid}`] || {};
    const name = lab.name || rec.tag || rec.who || who || `Visitante nº ${n || "?"}`;
    lines.push(`👤 ${name} · ` + (k <= 1 ? "primeira visita" : `${k}ª visita`));
  }
  lines.push("📱 " + (rec.model ? rec.model + " · " : "") + rec.dev);
  if (rec.isp) lines.push("📶 " + rec.isp);
  lines.push("📄 " + (await pageName(env, rec.path)));
  if (sourceOf(rec) !== "direto") lines.push("↪ " + sourceOf(rec));
  await push(env, `Nova visita · ${rec.geo || "local desconhecido"}`, lines.join("\n"), ["eyes"], `${env.SITE}/admin#visitas`);
}

// ---------------- pré-visualização de links (para o admin) ----------------
const UA = { "User-Agent": "Mozilla/5.0 (compatible; link-preview)" };
const unescapeHtml = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
async function fetchMeta(url) {
  let html;
  try { const r = await fetch(url, { headers: UA, redirect: "follow" }); html = (await r.text()).slice(0, 1_500_000); } catch { return {}; }
  const out = {};
  for (const key of ["image", "title"]) {
    for (const re of [new RegExp(`<meta[^>]+(?:property|name)=["'](?:og|twitter):${key}["'][^>]*content=["']([^"']+)`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og|twitter):${key}["']`, "i")]) {
      const m = html.match(re);
      if (m) { out[key] = unescapeHtml(m[1]).trim(); break; }
    }
  }
  if (!out.title) { const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (m) out.title = unescapeHtml(m[1]).trim(); }
  if (out.image) try { out.image = new URL(out.image, url).href; } catch { delete out.image; }
  return out;
}

// ---------------- pedidos ----------------
function isAdmin(req, env) {
  const a = req.headers.get("Authorization") || "";
  if (!env.ADMIN_PASSWORD || !a.startsWith("Basic ")) return false;
  let pw = "";
  try { pw = atob(a.slice(6)).split(":").slice(1).join(":"); } catch { return false; }
  return pw.length === env.ADMIN_PASSWORD.length && crypto.subtle.timingSafeEqual
    ? crypto.subtle.timingSafeEqual(enc.encode(pw), enc.encode(env.ADMIN_PASSWORD)) : pw === env.ADMIN_PASSWORD;
}

function cors(req, env, res) {
  const o = req.headers.get("Origin");
  const ok = (env.SITE_ORIGINS || "").split(",").map((s) => s.trim()).includes(o);
  const h = new Headers(res.headers);
  if (ok) {
    h.set("Access-Control-Allow-Origin", o);
    h.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    h.set("Access-Control-Max-Age", "86400");
    h.append("Vary", "Origin");
  }
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors(req, env, new Response(null, { status: 204 }));
    if (!url.pathname.startsWith("/api/")) // páginas: estão no GitHub Pages
      return Response.redirect(env.SITE + (url.pathname === "/" ? "/admin" : url.pathname), 302);
    let res;
    try { res = await route(req, env, ctx, url); } catch (e) { res = text("Erro no servidor: " + (e && e.message), 500); }
    return cors(req, env, res);
  },
};

async function route(req, env, ctx, url) {
  const p = url.pathname, m = req.method, DB = env.DB;
  const admin = () => isAdmin(req, env);
  const deny = () => text("Acesso restrito", 401);

  // ---------- públicos ----------
  if (p === "/api/counts" && m === "GET") {
    const r = (await DB.prepare("SELECT page, COUNT(*) n FROM comments GROUP BY page").all()).results;
    return json(Object.fromEntries(r.map((x) => [x.page, x.n])));
  }
  if (p === "/api/comments" && m === "GET") {
    const key = url.searchParams.get("page") || `opinioes/${url.searchParams.get("post") || ""}`;
    const rows = (await DB.prepare("SELECT data FROM comments WHERE page=? ORDER BY t").bind(key).all()).results.map((r) => JSON.parse(r.data));
    const uids = [...new Set(rows.map((c) => c.uid).filter(Boolean))];
    const pics = {};
    if (uids.length) for (const u of (await DB.prepare(`SELECT uid, json_extract(data,'$.picture') pic FROM users WHERE uid IN (${uids.map(() => "?").join(",")})`).bind(...uids).all()).results) if (u.pic) pics[u.uid] = u.pic;
    return json(rows.map((c) => publicComment(c, pics)));
  }
  if (p === "/api/comments" && m === "POST") {
    const d = await body(req);
    if (d.website) return json({ ok: true });
    const [uid, u] = await userFromToken(env, d.token);
    if (!u) return text("Para comentar, regista-te primeiro.", 401);
    const key = String(d.page || `opinioes/${d.post || ""}`).slice(0, 80);
    const t = String(d.text || "").trim().slice(0, 1500);
    if (!t) return text("Escreve o comentário", 400);
    if ((await pageTitle(env, key)) === null) return text("Página não encontrada", 404);
    const ip = ipOf(req), now = nowISO();
    const recent = (await DB.prepare("SELECT t FROM comments WHERE ip=? AND t>? ORDER BY t DESC").bind(ip, ago(86400)).all()).results;
    if ((recent.length && tdiff(now, recent[0].t) < 20) || recent.length >= 30) return text("Muitos comentários seguidos. Tenta daqui a pouco.", 429);
    const c = { id: rid(4), page: key, uid, name: u.name, ig: u.ig || "", text: t, t: now, ip, geo: geoOf(req) };
    c.text_tr = await translateEN(t);
    await DB.prepare("INSERT INTO comments(id,page,uid,t,ip,data) VALUES(?,?,?,?,?,?)").bind(c.id, key, uid, now, ip, JSON.stringify(c)).run();
    ctx.waitUntil(notifyComment(env, c));
    return json(publicComment(c));
  }
  if (p === "/api/register" && m === "POST") {
    const d = await body(req);
    if (d.website) return empty();
    const name = String(d.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const ig = cleanIg(d.ig), email = String(d.email || "").trim().slice(0, 120);
    if (!name) return text("Escreve o teu nome", 400);
    if (ig === null) return text("O @instagram só pode ter letras, números, pontos e _", 400);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return text("Email inválido", 400);
    if (!d.accept) return text("Tens de aceitar a nota de privacidade", 400);
    const ip = ipOf(req), now = nowISO();
    if ((await DB.prepare("SELECT COUNT(*) n FROM users WHERE ip=? AND created>?").bind(ip, ago(86400)).first()).n >= 5)
      return text("Demasiados registos a partir desta rede. Tenta amanhã.", 429);
    const token = tokenUrlsafe(24), uid = rid(4);
    const u = { name, ig, email, created: now, provider: "nome", ip, geo: geoOf(req) };
    await DB.batch([
      DB.prepare("INSERT INTO users(uid,created,ip,data) VALUES(?,?,?,?)").bind(uid, now, ip, JSON.stringify(u)),
      DB.prepare("INSERT INTO tokens(h,uid) VALUES(?,?)").bind(await sha256(token), uid)]);
    ctx.waitUntil(notifyRegister(env, name, ig));
    return json({ uid, token, name, ig });
  }
  if (p === "/api/me" && m === "POST") {
    const [, u] = await userFromToken(env, (await body(req)).token);
    return u ? json({ name: u.name, ig: u.ig || "", picture: u.picture || "", provider: u.provider || "", email: u.email || "" }) : json({}, 404);
  }
  if (p === "/api/me/logout" && m === "POST") {
    await DB.prepare("DELETE FROM tokens WHERE h=?").bind(await sha256(String((await body(req)).token || ""))).run();
    return empty();
  }
  if (p === "/api/me/delete" && m === "POST") {
    const d = await body(req);
    const [uid, u] = await userFromToken(env, d.token);
    if (!u) return text("Sessão inválida", 401);
    const q = [DB.prepare("DELETE FROM users WHERE uid=?").bind(uid), DB.prepare("DELETE FROM tokens WHERE uid=?").bind(uid)];
    if (d.comments) q.push(DB.prepare("DELETE FROM comments WHERE uid=?").bind(uid));
    await DB.batch(q);
    return empty();
  }
  if (p === "/api/hit" && m === "POST") {
    const ua = req.headers.get("User-Agent") || "";
    if (!ua || BOTS.test(ua)) return empty();
    const d = await body(req), ip = ipOf(req);
    const rec = { t: nowISO(), ip, path: String(d.path || "/").slice(0, 200), ref: String(d.ref || "").slice(0, 300), dev: device(ua), geo: geoOf(req), isp: ispOf(req) };
    const vid = String(d.vid || "");
    if (/^[a-z0-9]{8,24}$/.test(vid)) rec.vid = vid;
    const model = String(d.model || "").replace(/[^\w .+()/-]/g, "").trim().slice(0, 40);
    if (model) rec.model = model;
    const [uid, u] = await userFromToken(env, d.token);
    const who = u ? whoLabel(u.name, u.ig) : whoLabel(d.name, d.ig);
    if (u) rec.uid = uid;
    if (who) rec.who = who;
    rec.ua = ua.slice(0, 400);
    for (const [k, re] of [["screen", /^\d{2,5}x\d{2,5}(@[\d.]{1,4})?$/], ["lang", /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/], ["tz", /^[A-Za-z_]+(\/[A-Za-z_+\-]+){0,2}$/]]) {
      const v = String(d[k] || "").slice(0, 40);
      if (re.test(v)) rec[k] = v;
    }
    if (!rec.model && uaModel(ua)) rec.model = uaModel(ua);
    const code = String(d.de || "").slice(0, 40);
    const link = code ? (await kvGet(env, "links", {}))[code] : null;
    if (link) rec.tag = link.name;
    const prev = rec.vid ? await DB.prepare("SELECT t FROM visits WHERE vid=? ORDER BY t DESC LIMIT 1").bind(rec.vid).first()
      : await DB.prepare("SELECT t FROM visits WHERE ip=? AND dev=? ORDER BY t DESC LIMIT 1").bind(ip, rec.dev).first();
    const ins = await DB.prepare("INSERT INTO visits(t,vid,ip,dev,uid,tag,data) VALUES(?,?,?,?,?,?,?)")
      .bind(rec.t, rec.vid || null, ip, rec.dev, rec.uid || null, rec.tag || null, JSON.stringify(rec)).run();
    ctx.waitUntil((async () => {
      const name = await rdns(ip);
      if (name) await DB.prepare("UPDATE visits SET data=json_set(data,'$.rdns',?) WHERE id=?").bind(name, ins.meta.last_row_id).run();
      await notifyVisit(env, rec, prev && prev.t);
    })());
    return empty();
  }

  // ---------- admin ----------
  if (!admin()) return deny();

  if (p === "/api/check") return json({ ok: true });
  if (p === "/api/comments/all" && m === "GET") // em bruto; o admin junta os títulos
    return rawJson("[" + (await DB.prepare("SELECT data FROM comments ORDER BY t DESC").all()).results.map((r) => r.data).join(",") + "]");
  let mm;
  if ((mm = p.match(/^\/api\/comments\/([\w-]+)\/reply$/)) && m === "POST") {
    const reply = String((await body(req)).reply || "").trim().slice(0, 1500);
    const r = await DB.prepare("SELECT data FROM comments WHERE id=?").bind(mm[1]).first();
    if (r) {
      const c = JSON.parse(r.data);
      if (reply) { c.reply = reply; c.reply_tr = await translateEN(reply); } else { delete c.reply; delete c.reply_tr; }
      await DB.prepare("UPDATE comments SET data=? WHERE id=?").bind(JSON.stringify(c), mm[1]).run();
    }
    return empty();
  }
  if ((mm = p.match(/^\/api\/comments\/([\w-]+)$/)) && m === "DELETE") {
    await DB.prepare("DELETE FROM comments WHERE id=?").bind(mm[1]).run();
    return empty();
  }
  if (p === "/api/comments" && m === "DELETE") { // apagar uma obra apaga os seus comentários
    await DB.prepare("DELETE FROM comments WHERE page=?").bind(url.searchParams.get("page") || "").run();
    return empty();
  }
  if (p === "/api/users" && m === "GET") {
    const users = (await DB.prepare("SELECT uid, data FROM users").all()).results;
    const vs = Object.fromEntries((await DB.prepare("SELECT uid, COUNT(*) n, MAX(t) last FROM visits WHERE uid IS NOT NULL GROUP BY uid").all()).results.map((r) => [r.uid, r]));
    const cs = Object.fromEntries((await DB.prepare("SELECT uid, COUNT(*) n FROM comments WHERE uid IS NOT NULL GROUP BY uid").all()).results.map((r) => [r.uid, r.n]));
    const out = users.map(({ uid, data }) => {
      const u = JSON.parse(data);
      return { uid, name: u.name, ig: u.ig || "", email: u.email || "", provider: u.provider || "nome", picture: u.picture || "",
        created: u.created, geo: u.geo || "", comments: cs[uid] || 0, views: (vs[uid] || {}).n || 0, last: (vs[uid] || {}).last || "" };
    });
    return json(out.sort((a, b) => (b.last || b.created).localeCompare(a.last || a.created)));
  }
  if ((mm = p.match(/^\/api\/users\/([\w-]+)$/)) && m === "DELETE") {
    await DB.batch([DB.prepare("DELETE FROM users WHERE uid=?").bind(mm[1]), DB.prepare("DELETE FROM tokens WHERE uid=?").bind(mm[1])]);
    return empty();
  }
  if (p === "/api/visits/raw" && m === "GET") { // em bruto; as contas fazem-se no admin
    await DB.prepare("DELETE FROM visits WHERE t<?").bind(ago(KEEP_DAYS * 86400)).run();
    const rows = (await DB.prepare("SELECT data FROM visits ORDER BY t").all()).results.map((r) => r.data).join(",");
    const ip = ipOf(req), labels = await kvGet(env, "labels", {});
    return rawJson(`{"rows":[${rows}],"labels":${JSON.stringify(labels)},"you":${JSON.stringify({ ip, label: labels[`ip:${ip}`] || {} })}}`);
  }
  if (p === "/api/labels" && m === "POST") {
    const d = await body(req);
    const kind = d.kind, ident = String(d.id || "").slice(0, 60);
    if (!["vid", "ip"].includes(kind) || !ident) return text("Pedido inválido", 400);
    const name = String(d.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const labels = await kvGet(env, "labels", {});
    if (name || d.me) labels[`${kind}:${ident}`] = { name, me: !!d.me }; else delete labels[`${kind}:${ident}`];
    await kvSet(env, "labels", labels);
    return empty();
  }
  if (p === "/api/links" && m === "GET") {
    const opened = Object.fromEntries((await DB.prepare("SELECT tag, COUNT(*) n FROM visits WHERE tag IS NOT NULL GROUP BY tag").all()).results.map((r) => [r.tag, r.n]));
    return json(Object.entries(await kvGet(env, "links", {})).map(([code, v]) => ({ code, ...v, opened: opened[v.name] || 0 })));
  }
  if (p === "/api/links" && m === "POST") {
    const name = String((await body(req)).name || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name) return text("Escreve o nome da pessoa", 400);
    const slug = name.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "link";
    const code = `${slug}-${rid(2)}`;
    const links = await kvGet(env, "links", {});
    links[code] = { name, created: nowISO().slice(0, 10) };
    await kvSet(env, "links", links);
    return json({ code });
  }
  if ((mm = p.match(/^\/api\/links\/([\w-]+)$/)) && m === "DELETE") {
    const links = await kvGet(env, "links", {});
    delete links[mm[1]];
    await kvSet(env, "links", links);
    return empty();
  }
  if (p === "/api/notify" && m === "GET") return json(await notifyCfg(env));
  if (p === "/api/notify" && m === "POST") {
    const d = await body(req), c = await notifyCfg(env);
    Object.assign(c, { visits: !!d.visits, comments: !!d.comments, ntfy_on: d.ntfy_on === undefined ? true : !!d.ntfy_on, wa_on: !!d.wa_on });
    if ("wa_phone" in d) c.wa_phone = String(d.wa_phone).replace(/[^\d+]/g, "").slice(0, 16);
    if ("wa_key" in d) c.wa_key = String(d.wa_key).replace(/[^\w-]/g, "").slice(0, 40);
    if (d.new_topic) c.topic = "site-" + rid(8);
    await kvSet(env, "notify", c);
    return json(c);
  }
  if (p === "/api/notify/test-whatsapp" && m === "POST") {
    const c = await notifyCfg(env);
    if (!(c.wa_phone && c.wa_key)) return json({ ok: false, msg: "Falta o número ou a API key." });
    const [ok, msg] = await sendWhatsapp(c, "Teste do site ✓", "Se estás a ver isto no WhatsApp, está a funcionar.");
    return json({ ok, msg });
  }
  if (p === "/api/notify/test" && m === "POST") {
    ctx.waitUntil(push(env, "Teste do site ✓", "Se estás a ver isto, as notificações estão a funcionar.", ["white_check_mark"], `${env.SITE}/admin`));
    return empty();
  }
  if (p === "/api/push/key" && m === "GET") {
    const subs = await kvGet(env, "push", []);
    return json({ key: (await vapid(env)).pub, devices: subs.map((x) => ({ id: x.endpoint.slice(-12), name: x.name || "", added: x.added || "" })) });
  }
  if (p === "/api/push/subscribe" && m === "POST") {
    const d = await body(req), sub = d.sub || {}, keys = sub.keys || {};
    const ep = String(sub.endpoint || "");
    if (!ep.startsWith("https://") || !keys.p256dh || !keys.auth) return text("Subscrição inválida", 400);
    const item = { endpoint: ep, keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) }, name: String(d.name || "").slice(0, 60), added: nowISO().slice(0, 16).replace("T", " ") };
    await kvSet(env, "push", (await kvGet(env, "push", [])).filter((x) => x.endpoint !== ep).concat([item]));
    return empty();
  }
  if (p === "/api/push/remove" && m === "POST") {
    const i = String((await body(req)).id || "");
    await kvSet(env, "push", (await kvGet(env, "push", [])).filter((x) => !x.endpoint.endsWith(i) || !i));
    return empty();
  }
  if (p === "/api/meta" && m === "GET") { // título e imagem de um link (o browser não consegue, por causa do CORS)
    const u = url.searchParams.get("url") || "";
    return json(/^https?:\/\//i.test(u) ? await fetchMeta(u) : {});
  }
  if (p === "/api/fetchimg" && m === "GET") { // descarrega a imagem de pré-visualização para o admin a guardar no GitHub
    const u = url.searchParams.get("url") || "";
    if (!/^https?:\/\//i.test(u)) return text("", 400);
    const r = await fetch(u, { headers: UA });
    const ct = (r.headers.get("Content-Type") || "").split(";")[0];
    if (!r.ok || !/^image\/(jpeg|png|webp|gif)$/.test(ct)) return text("", 404);
    return new Response(r.body, { headers: { "Content-Type": ct } });
  }
  return text("Não encontrado", 404);
}
