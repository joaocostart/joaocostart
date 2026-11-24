/* Adaptador do admin para o site sem servidor próprio (GitHub Pages + Cloudflare).
 * O admin.html continua igual e faz pedidos a /api/...; este script apanha-os:
 *  - conteúdo (introdução, foto, escritas/músicas/podcast, opiniões): lido e gravado no
 *    repositório do GitHub através do Worker (que guarda o token); o GitHub Actions publica a seguir;
 *  - estatísticas de visitas e lista de comentários: calculadas aqui no browser;
 *  - o resto (comentários, utilizadores, etiquetas, links, notificações): Worker da Cloudflare.
 * Só precisa da password do admin.
 */
(() => {
  const API = window.API_BASE || "https://api.joaocostart.com";
  const REPO = window.SITE_REPO || "joaocostart/joaocostart";
  const BRANCH = "main";
  const SECTIONS = ["musica", "escrita", "podcast"];
  const KINDS = {}; "jpg jpeg png webp gif".split(" ").forEach((e) => (KINDS[e] = "image"));
  "mp4 webm m4v".split(" ").forEach((e) => (KINDS[e] = "video")); "mp3 m4a ogg wav aac opus flac".split(" ").forEach((e) => (KINDS[e] = "audio"));
  const AUDIO_EXT = new Set("mp3 m4a ogg wav webm opus mp4 aac flac".split(" "));
  const SESSION_GAP = 30 * 60;
  const realFetch = window.fetch.bind(window);

  // ---------- credenciais (guardadas só neste browser) ----------
  const creds = () => { try { return JSON.parse(localStorage.getItem("adm") || "null"); } catch { return null; } };
  const basic = (c) => "Basic " + btoa("admin:" + c.pw);
  function loginForm(msg) {
    const cur = document.getElementById("adm-login");
    if (cur) { if (msg) cur.querySelector("p").textContent = msg; return; }
    document.documentElement.style.overflow = "hidden";
    const d = document.createElement("div");
    d.id = "adm-login";
    d.style.cssText = "position:fixed;inset:0;z-index:99999;background:#0f1112;color:#e8e6e1;font:16px system-ui,sans-serif;display:flex;align-items:center;justify-content:center";
    d.innerHTML = `<form style="width:min(420px,90vw);display:grid;gap:12px">
      <h2 style="margin:0 0 4px;font:600 22px Georgia,serif">Admin</h2>
      <p style="margin:0;color:#c66">${msg || ""}</p>
      <label>Password do admin<input name=pw type=password required autocomplete=current-password style="width:100%;padding:10px;margin-top:4px"></label>
      <button style="padding:10px;font-size:16px">Entrar</button>
      <small style="color:#9a968e">Fica guardada só neste browser. Para sair: "sair deste browser" no fundo do admin.</small></form>`;
    document.body.appendChild(d);
    d.querySelector("input").focus();
    d.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const c = { pw: e.target.pw.value };
      const r = await realFetch(API + "/api/check", { headers: { Authorization: basic(c) } }).catch(() => ({}));
      if (!r.ok) return (d.querySelector("p").textContent = r.status === 401 ? "Password errada." : "Sem ligação ao servidor (api.joaocostart.com).");
      localStorage.setItem("adm", JSON.stringify(c));
      location.reload();
    };
  }
  window.admLogout = () => { localStorage.removeItem("adm"); location.reload(); };
  if (!creds()) { document.addEventListener("DOMContentLoaded", () => loginForm()); }
  document.addEventListener("DOMContentLoaded", () => {
    const a = document.createElement("p");
    a.style.cssText = "text-align:center;margin:40px 0;opacity:.6";
    a.innerHTML = '<a href="#" onclick="event.preventDefault();admLogout()">sair deste browser</a>';
    document.body.appendChild(a);
  });

  // ---------- GitHub (através do Worker, que guarda o token) ----------
  const GH = `${API}/api/gh/repos/${REPO}`;
  const ghFetch = (path, opts = {}) => realFetch(GH + path, { cache: "no-store", ...opts, headers: { Authorization: basic(creds()), ...(opts.headers || {}) } });
  async function gh(path, opts = {}) {
    const r = await ghFetch(path, { ...opts, headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json", ...(opts.headers || {}) } });
    if (r.status === 401 && !(await r.clone().text()).includes("GitHub")) loginForm("A password mudou. Entra outra vez.");
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? null : r.json();
  }
  async function readJSON(path, def) {
    const r = await ghFetch(`/contents/${path}?ref=${BRANCH}&t=${Date.now()}`, { headers: { Accept: "application/vnd.github.raw+json" } });
    if (r.status === 404) return def;
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    try { return JSON.parse(await r.text()); } catch { return def; }
  }
  const dump = (o) => JSON.stringify(o, null, 1);
  const fileB64 = (blob) => new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(",")[1] || ""); fr.onerror = bad; fr.readAsDataURL(blob); });
  const utf8B64 = (s) => { const b = new TextEncoder().encode(s); let o = ""; for (let i = 0; i < b.length; i += 0x8000) o += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(o); };

  // envia um blob com indicação de progresso (para "A enviar 37%")
  function postBlob(b64, onProgress) {
    return new Promise((ok, bad) => {
      const x = new XMLHttpRequest.__real();
      x.open("POST", `${GH}/git/blobs`);
      x.setRequestHeader("Authorization", basic(creds()));
      x.setRequestHeader("Accept", "application/vnd.github+json");
      x.setRequestHeader("Content-Type", "application/json");
      if (onProgress) x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
      x.onload = () => (x.status < 300 ? ok(JSON.parse(x.responseText).sha) : bad(new Error("GitHub " + x.status + ": " + x.responseText.slice(0, 200))));
      x.onerror = () => bad(new Error("Erro de ligação ao GitHub"));
      x.send(JSON.stringify({ content: b64, encoding: "base64" }));
    });
  }
  // grava vários ficheiros num só commit. files: {caminho: Blob|string|null(apagar)}
  async function commit(files, message, onProgress) {
    const entries = [];
    const blobs = Object.entries(files).filter(([, v]) => v instanceof Blob);
    const total = blobs.reduce((n, [, b]) => n + b.size, 0) || 1;
    let done = 0;
    for (const [path, v] of Object.entries(files)) {
      if (v === null) { // só apaga o que existe mesmo no repositório (alguns ficheiros antigos perderam-se)
        const ex = await ghFetch(`/contents/${path}?ref=${BRANCH}`, { method: "HEAD" });
        if (ex.ok) entries.push({ path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const isBlob = v instanceof Blob;
      const sha = await postBlob(isBlob ? await fileB64(v) : utf8B64(v),
        isBlob && onProgress ? (l, t) => onProgress((done + (l / t) * v.size) / total) : null);
      if (isBlob) done += v.size;
      entries.push({ path, mode: "100644", type: "blob", sha });
    }
    for (let attempt = 0; ; attempt++) {
      const ref = await gh(`/git/ref/heads/${BRANCH}`);
      const base = await gh(`/git/commits/${ref.object.sha}`);
      const tree = await gh("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: base.tree.sha, tree: entries }) });
      const c = await gh("/git/commits", { method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }) });
      try { await gh(`/git/refs/heads/${BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: c.sha }) }); return; }
      catch (e) { if (attempt >= 2) throw e; } // alguém gravou entretanto: tenta de novo
    }
  }
  const UP = (name) => `data/uploads/${name}`;
  const newName = (ext) => crypto.randomUUID().replace(/-/g, "") + "." + ext;
  const id8 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date());
  const extOf = (f) => (f && f.name && f.name.includes(".") ? f.name.split(".").pop().toLowerCase() : "");
  const isFile = (f) => f instanceof File && f.name && f.size >= 0;

  // ---------- Worker ----------
  const worker = (path, opts = {}) => realFetch(API + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: basic(creds()) } });
  const counts = async () => { try { return await (await realFetch(API + "/api/counts")).json(); } catch { return {}; } };

  // ---------- respostas ----------
  const R = (body, status = 200, type = "application/json") =>
    new Response(body === null ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": type } });
  const err = (msg, status = 400) => R(msg, status, "text/plain");

  // ---------- conteúdo ----------
  async function getSite() {
    return R({ name: "O teu nome", intro: "Escreve aqui a tua introdução, em /admin.", ...(await readJSON("data/site.json", {})) });
  }
  async function setSite(d) {
    const s = await readJSON("data/site.json", {});
    Object.assign(s, { name: String(d.name || "").slice(0, 80), intro: String(d.intro || "").slice(0, 3000), intro_en: String(d.intro_en || "").slice(0, 3000) });
    for (const k of ["instagram", "facebook"]) { const v = String(d[k] || "").trim().slice(0, 300); s[k] = /^https:\/\//.test(v) ? v : ""; }
    await commit({ "data/site.json": dump(s) }, "Admin: introdução");
    return R(null, 204);
  }
  async function setPhoto(fd, del) {
    const s = await readJSON("data/site.json", {});
    const files = {};
    if (s.photo) files[UP(s.photo)] = null;
    if (del) delete s.photo;
    else {
      const f = fd.get("file");
      if (KINDS[extOf(f)] !== "image") return err("Escolhe uma imagem");
      s.photo = newName(extOf(f));
      files[UP(s.photo)] = f;
    }
    files["data/site.json"] = dump(s);
    await commit(files, del ? "Admin: remove foto" : "Admin: foto");
    return R(null, 204);
  }
  async function getItems(sec) {
    const [items, n] = await Promise.all([readJSON("data/items.json", []), counts()]);
    const out = items.map((i) => ({ ...i, comments: n[`${i.section}/${i.id}`] || 0 }));
    return R(sec ? out.filter((i) => i.section === sec) : out);
  }
  async function saveItem(fd, iid, prog) {
    const g = (k) => String(fd.get(k) || "");
    const sec = g("section"), f = fd.get("file"), au = fd.get("audio");
    const ext = isFile(f) ? extOf(f) : "", aext = isFile(au) ? extOf(au) : "";
    if (aext && !AUDIO_EXT.has(aext)) return err("O áudio tem de ser mp3, m4a, ogg, wav, aac, opus ou flac");
    if (!SECTIONS.includes(sec) || (ext && !KINDS[ext])) return err(iid ? "Secção ou formato inválido" : "Escolhe a secção e um ficheiro (imagem, vídeo, áudio) ou escreve o texto");
    const items = await readJSON("data/items.json", []);
    const files = {};
    const fields = { section: sec, title: g("title").trim().slice(0, 120), title_en: g("title_en").trim().slice(0, 120),
      text: g("text").trim().slice(0, 20000), text_en: g("text_en").trim().slice(0, 20000) };
    let item;
    if (!iid) {
      if (!ext && !fields.text && !aext) return err("Escolhe a secção e um ficheiro (imagem, vídeo, áudio) ou escreve o texto");
      if (!fields.title) return err("Escreve um título");
      const name = ext ? newName(ext) : "", aname = aext ? newName(aext) : "";
      if (name) files[UP(name)] = f;
      if (aname) files[UP(aname)] = au;
      item = { id: id8(), ...fields, file: name, kind: ext ? KINDS[ext] : "text", audio: aname, date: today() };
      items.unshift(item);
    } else {
      item = items.find((i) => i.id === iid);
      if (!item) return err("Item não encontrado", 404);
      Object.assign(item, fields);
      if (aext) { if (item.audio) files[UP(item.audio)] = null; item.audio = newName(aext); files[UP(item.audio)] = au; }
      else if (g("remove_audio") === "1" && item.audio) { files[UP(item.audio)] = null; item.audio = ""; }
      if (g("remove_file") === "1" && (item.text || item.audio) && !ext && item.file) { files[UP(item.file)] = null; item.file = ""; item.kind = "text"; }
      if (ext) { if (item.file) files[UP(item.file)] = null; item.file = newName(ext); item.kind = KINDS[ext]; files[UP(item.file)] = f; }
    }
    files["data/items.json"] = dump(items);
    await commit(files, `Admin: ${iid ? "edita" : "publica"} "${item.title}"`, prog);
    return R(item);
  }
  async function delItem(iid) {
    const items = await readJSON("data/items.json", []);
    const gone = items.filter((i) => i.id === iid);
    const files = { "data/items.json": dump(items.filter((i) => i.id !== iid)) };
    for (const i of gone) for (const k of ["file", "audio"]) if (i[k]) files[UP(i[k])] = null;
    await commit(files, "Admin: apaga item");
    for (const i of gone) await worker(`/api/comments?page=${encodeURIComponent(`${i.section}/${i.id}`)}`, { method: "DELETE" });
    return R(null, 204);
  }

  function embedFor(url) {
    let m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
    if (m) return { kind: "video", src: `https://www.youtube-nocookie.com/embed/${m[1]}`, thumb: `https://img.youtube.com/vi/${m[1]}/maxresdefault.jpg`, thumb2: `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` };
    m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (m) return { kind: "video", src: `https://player.vimeo.com/video/${m[1]}` };
    m = url.match(/open\.spotify\.com\/(?:intl-[\w-]+\/)?(track|album|playlist|episode|show|artist)\/(\w+)/);
    if (m) return { kind: ["track", "episode"].includes(m[1]) ? "spotify" : "spotify-big", src: `https://open.spotify.com/embed/${m[1]}/${m[2]}` };
    return null;
  }
  async function downloadImage(url, files) {
    try {
      const r = await worker("/api/fetchimg?url=" + encodeURIComponent(url));
      if (!r.ok) return null;
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[(r.headers.get("Content-Type") || "").split(";")[0]];
      const b = await r.blob();
      if (!ext || b.size > 10_000_000) return null;
      const name = newName(ext);
      files[UP(name)] = b;
      return name;
    } catch { return null; }
  }
  async function getPosts() {
    const [posts, n] = await Promise.all([readJSON("data/posts.json", []), counts()]);
    return R(posts.map((p) => ({ ...p, comments: n[`opinioes/${p.id}`] || 0 })));
  }
  async function savePost(fd, pid, prog) {
    const posts = await readJSON("data/posts.json", []);
    let old = {};
    if (pid) { old = posts.find((p) => p.id === pid); if (!old) return err("Opinião não encontrada", 404); }
    const g = (k, n) => String(fd.get(k) || "").trim().slice(0, n);
    const up = (k) => (isFile(fd.get(k)) && fd.get(k).name ? fd.get(k) : null);
    const mtype = g("media_type", 10), url = g("media_url", 2000);
    const mfile = up("media_file"), cover = up("cover"), audio = up("audio"), music = up("music");
    if (!["none", "image", "video", "link"].includes(mtype)) return err("Tipo de media inválido");
    if (url && !/^https?:\/\//i.test(url)) return err("O link tem de começar por http:// ou https://");
    const keepFile = old.media_type === mtype ? old.file : null;
    const fileKind = mfile ? KINDS[extOf(mfile)] : KINDS[(keepFile || "").split(".").pop()];
    if (mtype === "image" && fileKind !== "image") return err("Escolhe uma imagem (jpg, png, webp, gif)");
    if (mtype === "video" && !url && fileKind !== "video") return err("Escolhe um vídeo (mp4, webm, m4v) ou cola um link do YouTube/Vimeo");
    if (mtype === "link" && !url) return err("Cola o link");
    if (cover && KINDS[extOf(cover)] !== "image") return err("A imagem de capa tem de ser jpg, png, webp ou gif");
    if (audio && !AUDIO_EXT.has(extOf(audio))) return err("Formato de áudio inválido");
    if (music && !AUDIO_EXT.has(extOf(music))) return err("A música tem de ser mp3, m4a, ogg, wav, aac, opus ou flac");
    const text = g("text", 20000), title = g("title", 160);
    const keepAudio = fd.get("remove_audio") !== "1" ? old.audio : null;
    if (!title || !(text || audio || keepAudio)) return err("Escreve um título e a tua opinião (texto ou áudio)");
    const files = {};
    const store = (f) => { const n = newName(extOf(f)); files[UP(n)] = f; return n; };
    const post = { id: old.id || id8(), date: old.date || today(), title, title_en: g("title_en", 160), text, text_en: g("text_en", 20000), media_type: mtype };
    if (["image", "video"].includes(mtype) && !(mtype === "video" && url)) {
      if (mfile) post.file = store(mfile); else if (keepFile) post.file = keepFile;
    }
    if (fd.get("remove_cover") !== "1" && old.cover) post.cover = old.cover;
    if (["video", "link"].includes(mtype) && url) {
      post.url = url;
      if (url === old.url) { for (const k of ["embed", "link_title"]) if (old[k]) post[k] = old[k]; }
      else {
        const emb = embedFor(url);
        if (emb) post.embed = { kind: emb.kind, src: emb.src };
        const meta = emb && emb.thumb ? {} : await (await worker("/api/meta?url=" + encodeURIComponent(url))).json().catch(() => ({}));
        if (meta.title) post.link_title = meta.title.slice(0, 300);
        const thumb = (emb || {}).thumb || meta.image;
        if (thumb && !cover) post.cover = (await downloadImage(thumb, files)) || (emb && emb.thumb2 && (await downloadImage(emb.thumb2, files))) || post.cover;
      }
    } else if (["none", "image"].includes(mtype) && !cover && post.cover && old.url) delete post.cover;
    if (cover) post.cover = store(cover);
    if (!post.cover) delete post.cover;
    if (audio) post.audio = store(audio); else if (keepAudio) post.audio = keepAudio;
    if (music) post.music = store(music); else if (old.music && fd.get("remove_music") !== "1") post.music = old.music;
    const used = new Set(["file", "cover", "audio", "music"].map((k) => post[k]).filter(Boolean));
    for (const k of ["file", "cover", "audio", "music"]) if (old[k] && !used.has(old[k])) files[UP(old[k])] = null;
    const list = pid ? posts.map((p) => (p.id === pid ? post : p)) : [post, ...posts];
    files["data/posts.json"] = dump(list);
    await commit(files, `Admin: ${pid ? "edita" : "publica"} opinião "${post.title}"`, prog);
    return R(post);
  }
  async function delPost(pid) {
    const posts = await readJSON("data/posts.json", []);
    const gone = posts.filter((p) => p.id === pid);
    const files = { "data/posts.json": dump(posts.filter((p) => p.id !== pid)) };
    for (const p of gone) for (const k of ["file", "cover", "audio", "music"]) if (p[k]) files[UP(p[k])] = null;
    await commit(files, "Admin: apaga opinião");
    if (gone.length) await worker(`/api/comments?page=${encodeURIComponent("opinioes/" + pid)}`, { method: "DELETE" });
    return R(null, 204);
  }

  // ---------- comentários (lista do admin) ----------
  const SECTION_NAMES = { musica: "música", escrita: "escrita", podcast: "podcast", opinioes: "opinião" };
  async function allComments() {
    const r = await worker("/api/comments/all");
    if (!r.ok) return r;
    const [cs, items, posts] = await Promise.all([r.json(), readJSON("data/items.json", []), readJSON("data/posts.json", [])]);
    const title = (k) => { const [s, id] = k.split("/"); const x = (s === "opinioes" ? posts : items.filter((i) => i.section === s)).find((x) => x.id === id); return x ? x.title : null; };
    const out = cs.map((c) => ({ ...c, section: SECTION_NAMES[c.page.split("/")[0]] || "", post_title: title(c.page) || "(página apagada)" }));
    const n = {}; out.forEach((c) => (n[c.page] = (n[c.page] || 0) + 1));
    const pages = posts.map((p) => ({ page: `opinioes/${p.id}`, section: "opinião", title: p.title }))
      .concat(items.map((i) => ({ page: `${i.section}/${i.id}`, section: SECTION_NAMES[i.section] || i.section, title: i.title })));
    pages.forEach((p) => (p.count = n[p.page] || 0));
    return R({ comments: out, pages: pages.sort((a, b) => b.count - a.count) });
  }

  // ---------- estatísticas de visitas (o que o app.py fazia em /api/visits) ----------
  const T = (s) => Date.parse(s + "Z") / 1000;
  const lisbon = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d).replace(" ", "T");
  const uaApp = (ua) => { for (const [k, n] of [["Instagram", "app do Instagram"], ["FBAN", "app do Facebook"], ["FBAV", "app do Facebook"], ["FB_IAB", "app do Facebook"], ["Messenger", "Messenger"], ["musical_ly", "TikTok"], ["BytedanceWebview", "TikTok"], ["LinkedInApp", "LinkedIn"]]) if (ua.includes(k)) return n; return ""; };
  const REF_NAMES = [["facebook.", "Facebook"], ["fb.", "Facebook"], ["instagram.", "Instagram"], ["google.", "Google"], ["bing.", "Bing"], ["duckduckgo.", "DuckDuckGo"], ["whatsapp", "WhatsApp"], ["wa.me", "WhatsApp"], ["t.co", "X/Twitter"], ["twitter.", "X/Twitter"], ["tiktok.", "TikTok"], ["youtube.", "YouTube"], ["linkedin.", "LinkedIn"]];
  function sourceOf(r) {
    if (r.tag) return `link para ${r.tag}`;
    const app = uaApp(r.ua || ""), host = r.ref ? r.ref.replace(/^https?:\/\/(www\.|m\.|l\.|lm\.)?([^/]+).*/, "$2") : "";
    const f = REF_NAMES.find(([k]) => host.includes(k)), name = f ? f[1] : host;
    if (app && (!name || app.toLowerCase().includes(name.toLowerCase()))) return app;
    return name ? name + (app ? ` (${app})` : "") : app || "direto";
  }
  function visitorStats(rows) {
    const st = {}, last = {};
    let n = 0;
    for (const r of [...rows].sort((a, b) => (a.t < b.t ? -1 : 1))) {
      const v = r.vid; if (!v) continue;
      const x = st[v] || (st[v] = { vid: v, n: ++n, visits: 0, who: "", first: r.t, last: r.t, geo: "", dev: "", model: "", isp: "" });
      if (!(v in last) || T(r.t) - last[v] > SESSION_GAP) x.visits++;
      last[v] = T(r.t);
      Object.assign(x, { last: r.t, geo: r.geo || x.geo, dev: r.dev || x.dev, model: r.model || x.model, isp: r.isp || x.isp, who: r.who || x.who });
    }
    return st;
  }
  const isMe = (r, labels) => !!((labels[`vid:${r.vid}`] || {}).me || (labels[`ip:${r.ip}`] || {}).me);
  function sessionsOf(rows, labels, items, posts) {
    const titles = { opinioes: Object.fromEntries(posts.map((p) => [p.id, p.title])) };
    items.forEach((i) => ((titles[i.section] ||= {})[i.id] = i.title));
    const pname = (path) => { const [a, b] = path.replace(/^\/+|\/+$/g, "").split("/"); return !a ? "início" : b ? `${a}: ${(titles[a] || {})[b] || b}` : a; };
    const vs = visitorStats(rows), tagOf = {};
    rows.forEach((r) => { if (r.vid && r.tag) tagOf[r.vid] = r.tag; });
    const out = [], open = {};
    for (const r of [...rows].sort((a, b) => (a.t < b.t ? -1 : 1))) {
      const key = r.vid || `${r.ip}|${r.dev}`, t = T(r.t);
      let s = open[key];
      if (!s || t - s._t > SESSION_GAP) {
        const lab = (r.vid ? labels[`vid:${r.vid}`] : null) || labels[`ip:${r.ip}`] || {};
        const v = vs[r.vid] || null;
        const known = lab.name || r.tag || tagOf[r.vid] || r.who || (v && v.who);
        s = { start: r.t, end: r.t, who: known || (v ? `Visitante nº ${v.n}` : "Visitante (antigo, sem número)"), named: !!known, me: !!lab.me,
          vid: r.vid || "", vn: v ? v.n : null, ip: r.ip, geo: r.geo || "", isp: r.isp || "", dev: r.dev, model: r.model || "",
          source: sourceOf(r), pages: [], _t: t, key, rdns: r.rdns || "", screen: r.screen || "", lang: r.lang || "", tz: r.tz || "" };
        open[key] = s; out.push(s);
      }
      s._t = t; s.end = r.t; s.model = s.model || r.model || "";
      for (const k of ["screen", "lang", "tz"]) s[k] = s[k] || r[k] || "";
      const pg = pname(r.path);
      if (!s.pages.length || s.pages[s.pages.length - 1] !== pg) s.pages.push(pg);
    }
    out.forEach((s) => delete s._t);
    return out;
  }
  const most = (arr, n) => { const c = {}; arr.forEach((x) => (c[x] = (c[x] || 0) + 1)); return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n); };
  async function visits(hide) {
    const r = await worker("/api/visits/raw");
    if (!r.ok) return r;
    const [{ rows, labels, you }, items, posts] = await Promise.all([r.json(), readJSON("data/items.json", []), readJSON("data/posts.json", [])]);
    const sessAll = sessionsOf(rows, labels, items, posts);
    const kept = hide ? rows.filter((r) => !isMe(r, labels)) : rows;
    const now = Date.now(), vs = visitorStats(kept);
    const summary = (days) => { const since = lisbon(new Date(now - days * 864e5)); const rs = kept.filter((r) => r.t >= since); return { views: rs.length, people: new Set(rs.map((r) => r.ip + "|" + r.dev)).size }; };
    const days = {}; kept.forEach((r) => (days[r.t.slice(0, 10)] = (days[r.t.slice(0, 10)] || 0) + 1));
    return R({
      today: summary(1), week: summary(7), month: summary(30),
      pages: most(kept.map((r) => r.path).filter(Boolean), 10),
      refs: most(kept.filter((r) => r.ref).map((r) => r.ref.replace(/^https?:\/\/(www\.)?([^/]+).*/, "$2")), 10),
      devices: most(kept.map((r) => r.dev).filter(Boolean), 8),
      countries: most(kept.filter((r) => r.geo).map((r) => r.geo.split(", ").pop()), 10),
      cities: most(kept.map((r) => r.geo).filter(Boolean), 10),
      daily: Array.from({ length: 30 }, (_, k) => { const d = lisbon(new Date(now - (29 - k) * 864e5)).slice(0, 10); return [d, days[d] || 0]; }),
      recent: [...kept].sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 200).map((r) => ({ ...r, vn: (vs[r.vid] || {}).n, who: r.who || (vs[r.vid] || {}).who || "" })),
      visitors: Object.values(vs).sort((a, b) => (a.last < b.last ? 1 : -1)).slice(0, 100),
      sessions: sessAll.reverse().filter((x) => !(hide && x.me)).slice(0, 300),
      you, labels,
    });
  }

  // ---------- encaminhamento ----------
  async function handle(method, url, bodyIn, prog) {
    const u = new URL(url, location.href);
    if (!u.pathname.startsWith("/api/") || u.origin !== location.origin) return null;
    if (!creds()) { loginForm(); return err("Entra primeiro", 401); }
    const p = u.pathname, json = () => (typeof bodyIn === "string" ? JSON.parse(bodyIn || "{}") : {});
    let m;
    try {
      if (p === "/api/site") return method === "POST" ? await setSite(json()) : await getSite();
      if (p === "/api/photo") return await setPhoto(bodyIn, method === "DELETE");
      if (p === "/api/items" && method === "GET") return await getItems(u.searchParams.get("s"));
      if (p === "/api/items" && method === "POST") return await saveItem(bodyIn, null, prog);
      if ((m = p.match(/^\/api\/items\/(\w+)$/))) return method === "DELETE" ? await delItem(m[1]) : await saveItem(bodyIn, m[1], prog);
      if (p === "/api/posts" && method === "GET") return await getPosts();
      if (p === "/api/posts" && method === "POST") return await savePost(bodyIn, null, prog);
      if ((m = p.match(/^\/api\/posts\/(\w+)$/))) return method === "DELETE" ? await delPost(m[1]) : await savePost(bodyIn, m[1], prog);
      if (p === "/api/comments/all") return await allComments();
      if (p === "/api/visits") return await visits(u.searchParams.get("hide_me") === "1");
      const r = await worker(p + u.search, { method, body: bodyIn, headers: typeof bodyIn === "string" ? { "Content-Type": "application/json" } : {} });
      if (r.status === 401) loginForm("A password mudou. Entra outra vez.");
      return r;
    } catch (e) { return err("Erro: " + e.message, 500); }
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const res = await handle((init.method || "GET").toUpperCase(), url, init.body);
    return res || realFetch(input, init);
  };

  // XMLHttpRequest usado nos formulários com barra de progresso
  const RealXHR = window.XMLHttpRequest;
  class ShimXHR {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ""; this._h = {}; }
    open(method, url) { this._m = method.toUpperCase(); this._u = url; }
    setRequestHeader(k, v) { this._h[k] = v; }
    async send(b) {
      const res = await handle(this._m, this._u, b, (f) => this.upload.onprogress && this.upload.onprogress({ loaded: Math.round(f * 100), total: 100, lengthComputable: true }));
      if (!res) { // pedido normal
        const x = new RealXHR(); x.open(this._m, this._u);
        Object.entries(this._h).forEach(([k, v]) => x.setRequestHeader(k, v));
        x.upload.onprogress = this.upload.onprogress;
        x.onload = () => { this.status = x.status; this.responseText = x.responseText; this.onload && this.onload(); };
        x.onerror = () => this.onerror && this.onerror();
        return x.send(b);
      }
      this.status = res.status; this.responseText = await res.text();
      this.onload && this.onload();
    }
  }
  ShimXHR.__real = RealXHR;
  window.XMLHttpRequest = ShimXHR;
  XMLHttpRequest.__real = RealXHR;
})();
