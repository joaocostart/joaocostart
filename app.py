import os, re, json, time, uuid, hmac, hashlib, secrets, threading, ipaddress
import html as htmllib
from datetime import datetime, timedelta
from collections import Counter
import geo
import webpush
import translate
from urllib.request import Request, urlopen
from urllib.parse import urljoin, quote
from functools import wraps
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory, Response, session, redirect
from urllib.parse import urlencode
from werkzeug.middleware.proxy_fix import ProxyFix
try:
    from PIL import Image
except ImportError:  # opcional: só serve para dizer ao Facebook o tamanho da imagem
    Image = None

BASE = Path(__file__).parent
DATA = BASE / "data"
UP = DATA / "uploads"
UP.mkdir(parents=True, exist_ok=True)
ITEMS, SITE = DATA / "items.json", DATA / "site.json"
PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
SECTIONS = {"musica", "escrita", "podcast"}
KINDS = {**{e: "image" for e in "jpg jpeg png webp gif".split()},
         **{e: "video" for e in "mp4 webm m4v".split()},
         **{e: "audio" for e in "mp3 m4a ogg wav aac opus flac".split()}}
lock = threading.Lock()
app = Flask(__name__, static_folder="static", static_url_path="/s")
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # atrás do Caddy: IP real e https
app.config["MAX_CONTENT_LENGTH"] = 3 * 1024**3  # 3 GB por ficheiro
_secret = BASE / "data" / "secret.key"  # assina o cookie usado durante o login com Facebook/Google
if not _secret.exists():
    _secret.write_text(os.urandom(32).hex())
    os.chmod(_secret, 0o600)
app.secret_key = _secret.read_text().strip()
app.config.update(SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SECURE=True)


def load(p, default):
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return default


def save(p, obj):
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(p)


def admin(f):
    @wraps(f)
    def wrapper(*a, **k):
        auth = request.authorization
        if not PASSWORD or not auth or not hmac.compare_digest(auth.password or "", PASSWORD):
            return Response("Acesso restrito (defina ADMIN_PASSWORD)", 401,
                            {"WWW-Authenticate": 'Basic realm="admin"'})
        return f(*a, **k)
    return wrapper


SITE_SECS = ["musica", "escrita", "podcast", "opinioes"]
SEC_TITLE = {"musica": "Música", "escrita": "Escrita", "podcast": "Podcast", "opinioes": "Opiniões"}
PRIVACY_PT = [
    "Este site regista as visitas para estatísticas: data, página vista, de onde vieste, tipo de aparelho e browser, "
    "endereço IP e a localização e operador aproximados que se deduzem dele. Cada browser recebe um número anónimo "
    "guardado no próprio browser, para distinguir visitas novas de repetidas.",
    "Para comentar fazes um registo simples (nome e, se quiseres, o teu @instagram), guardado neste browser. O nome, o @instagram "
    "e os comentários ficam públicos; as tuas visitas neste browser passam a estar associadas ao teu registo (visível só para mim).",
    "Os dados ficam guardados no meu servidor, não são vendidos nem partilhados, e as visitas são apagadas ao fim de 90 dias. "
    "O site mostra anúncios do Google AdSense, que podem usar cookies próprios.",
    "Para apagares os teus dados ou fazeres perguntas, fala comigo pelas redes sociais no fundo da página."]


def _e(v):
    return htmllib.escape(str(v or ""), quote=True)


def _paras(text):
    return "".join(f"<p>{_e(par).replace(chr(10), '<br>')}</p>" for par in re.split(r"\n\s*\n", text.strip()) if par.strip())


def _date_pt(d):
    try:
        y, mo, da = d.split("-")
        return f"{int(da)} de {['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'][int(mo)-1]} de {y}"
    except Exception:
        return ""


def _entries():
    items, posts = load(ITEMS, []), load(POSTS, [])
    es = [{"sec": "opinioes", "o": p, "url": f"/opinioes/{p['id']}"} for p in posts] + \
         [{"sec": i["section"], "o": i, "url": f"/{i['section']}/{i['id']}"} for i in items]
    return sorted(es, key=lambda x: x["o"].get("date", ""), reverse=True), items, posts


def ssr(path):
    """(estado, título, descrição, imagem, html) da página — o conteúdo vai já no HTML, sem depender de JavaScript."""
    site = load(SITE, {})
    es, items, posts = _entries()
    sec, _, pid = path.strip("/").partition("/")
    li = lambda x: (f'<li><a href="{x["url"]}">{_e(x["o"]["title"])}</a> <small>{SEC_TITLE.get(x["sec"], "")}'
                    f'{" · " + _date_pt(x["o"]["date"]) if x["o"].get("date") else ""}</small></li>')
    if not sec:
        lines = [l for l in (site.get("intro") or "").split("\n") if l.strip()]
        if lines and lines[0].strip().lower() == (site.get("name") or "").strip().lower():
            lines = lines[1:]
        body = f'<h1>{_e(site.get("name"))}</h1>' + "".join(f"<p>{_e(l)}</p>" for l in lines)
        if site.get("photo"):
            body += f'<img src="/media/{_e(site["photo"])}" alt="{_e(site.get("name"))}">'
        if es:
            body += "<h2>Mais recente</h2><ul>" + "".join(li(x) for x in es[:20]) + "</ul>"
        return 200, site.get("name", ""), " ".join(lines) or site.get("name", ""), site.get("photo"), body
    if sec == "teoria":
        topics = ["Notas e braço da guitarra", "Acordes (todos, com diagrama e som)", "Intervalos", "Escalas e modos",
                  "Campo harmónico", "Progressões", "Círculo de quintas", "Ritmo e compasso"]
        return (200, "Teoria musical de guitarra",
                "Teoria musical de guitarra: notas, todos os acordes com diagrama e som, escalas, intervalos, campo harmónico e mais.",
                None, "<h1>Teoria musical de guitarra</h1><ul>" + "".join(f"<li>{t}</li>" for t in topics) + "</ul>")
    if sec == "privacidade" and not pid:
        return 200, "Privacidade", PRIVACY_PT[0], None, "<h1>Privacidade</h1>" + "".join(f"<p>{_e(t)}</p>" for t in PRIVACY_PT)
    if sec not in SITE_SECS:
        return 404, "Página não encontrada", "", None, "<h1>Página não encontrada</h1>"
    mine = [x for x in es if x["sec"] == sec]
    if not pid:
        if not mine:
            return 404, SEC_TITLE[sec], "", None, f"<h1>{SEC_TITLE[sec]}</h1><p>Em breve.</p>"
        body = f"<h1>{SEC_TITLE[sec]}</h1><ul>" + "".join(li(x) for x in mine) + "</ul>"
        return 200, SEC_TITLE[sec], f'{SEC_TITLE[sec]} — {", ".join(x["o"]["title"] for x in mine[:6])}', None, body
    x = next((x for x in mine if x["o"]["id"] == pid), None)
    if not x:
        return 404, "Página não encontrada", "", None, "<h1>Página não encontrada</h1>"
    o, body, image = x["o"], f'<h1>{_e(x["o"]["title"])}</h1>', None
    if o.get("date"):
        body += f'<p><small>{SEC_TITLE[sec]} · {_date_pt(o["date"])}</small></p>'
    kind = "image" if (o.get("kind") == "image" or o.get("media_type") == "image") else o.get("kind") or o.get("media_type")
    if o.get("file") and kind == "image":
        image = o["file"]
        body += f'<img src="/media/{_e(o["file"])}" alt="{_e(o["title"])}">'
    elif o.get("file") and kind == "video":
        body += f'<video src="/media/{_e(o["file"])}" controls preload="metadata"></video>'
    elif o.get("file") and kind == "audio":
        body += f'<audio src="/media/{_e(o["file"])}" controls preload="metadata"></audio>'
    for k in ("music", "audio"):
        if o.get(k):
            body += f'<audio src="/media/{_e(o[k])}" controls preload="metadata"></audio>'
    if o.get("cover"):
        image = image or o["cover"]
    if o.get("url"):
        body += f'<p><a href="{_e(o["url"])}" rel="noopener">{_e(o.get("link_title") or o["url"])}</a></p>'
    if o.get("text") and o.get("file") and kind == "image":
        body += f'<details><summary>Ler em texto</summary>{_paras(o["text"])}</details>'
    else:
        body += _paras(o.get("text", ""))
    desc = (o.get("text") or f'{SEC_TITLE[sec]} · {o["title"]}')
    return 200, o["title"], desc, image or site.get("photo"), body


def render(path):
    status, title, desc, image, body = ssr(path)
    site = load(SITE, {})
    page = (BASE / "static" / "index.html").read_text("utf-8")
    full = title if title == site.get("name") else f"{title} · {site.get('name', '')}"
    head = og_tags(title, desc, image, request.host_url.rstrip("/") + (path if path != "/" else "/"),
                   "website" if path == "/" else "article")
    if status != 200:  # páginas vazias / inexistentes: não indexar e sem anúncios (regras do AdSense)
        head += '<meta name="robots" content="noindex">\n'
        page = re.sub(r'<script async src="https://pagead2\.googlesyndication\.com[^>]*></script>\n?', "", page)
    page = page.replace("<title>…</title>", f"<title>{_e(full)}</title>", 1).replace("</head>", head + "</head>", 1)
    page = page.replace('<main id="m" class="wrap"></main>', f'<main id="m" class="wrap"><article class="post ssr">{body}</article></main>', 1)
    return Response(page, status, mimetype="text/html")


@app.get("/")
def home():
    return render("/")


@app.get("/<sec>")
@app.get("/<sec>/<pid>")
def page(sec, pid=""):
    if sec not in SITE_SECS + ["privacidade", "teoria"]:
        return render(f"/{sec}")
    return render(f"/{sec}/{pid}" if pid else f"/{sec}")


@app.get("/sitemap.xml")
def sitemap():
    es, items, posts = _entries()
    base = request.host_url.rstrip("/")
    urls = [("/", es[0]["o"].get("date", "") if es else "")]
    urls += [(f"/{k}", next((x["o"].get("date", "") for x in es if x["sec"] == k), "")) for k in SITE_SECS if any(x["sec"] == k for x in es)]
    urls += [(x["url"], x["o"].get("date", "")) for x in es] + [("/teoria", ""), ("/privacidade", "")]
    xml = "".join(f"<url><loc>{base}{u}</loc>" + (f"<lastmod>{d}</lastmod>" if d else "") + "</url>" for u, d in urls)
    return Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + xml + "</urlset>",
                    mimetype="application/xml")


@app.get("/ads.txt")
def ads_txt():
    return send_from_directory(BASE, "ads.txt", mimetype="text/plain")


@app.get("/robots.txt")
def robots():
    return Response(f"User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /auth/\nSitemap: {request.host_url}sitemap.xml\n",
                    mimetype="text/plain")


@app.get("/admin")
@admin
def admin_page():
    return app.send_static_file("admin.html")


@app.get("/media/<name>")
def media(name):
    return send_from_directory(UP, name, conditional=True, max_age=31536000)


# campos traduzidos automaticamente para inglês (devolvidos como <campo>_tr; o original não muda)
ITEM_TR, POST_TR, COMMENT_TR = ["title", "text"], ["title", "text", "link_title"], ["text", "reply"]


@app.get("/api/site")
def get_site():
    return jsonify(translate.add({"name": "O teu nome", "intro": "Escreve aqui a tua introdução, em /admin.",
                                  **load(SITE, {})}, ["intro"]))


@app.post("/api/site")
@admin
def set_site():
    d = request.get_json(force=True)
    with lock:
        s = load(SITE, {})
        s.update(name=str(d.get("name", ""))[:80], intro=str(d.get("intro", ""))[:3000],
                 intro_en=str(d.get("intro_en", ""))[:3000])
        for k in ("instagram", "facebook"):  # redes sociais (só links https)
            v = str(d.get(k, "")).strip()[:300]
            s[k] = v if re.match(r"https://", v) else ""
        save(SITE, s)
    translate.now(s.get("intro"))
    return "", 204


@app.get("/api/items")
def get_items():
    s = request.args.get("s")
    items, n = load(ITEMS, []), comment_counts()
    items = [translate.add({**i, "comments": n.get(f'{i["section"]}/{i["id"]}', 0)}, ITEM_TR) for i in items]
    return jsonify(items if not s else [i for i in items if i["section"] == s])


@app.post("/api/items")
@admin
def add_item():
    f = request.files.get("file")
    sec = request.form.get("section")
    title = request.form.get("title", "").strip()[:120]
    title_en = request.form.get("title_en", "").strip()[:120]
    text, text_en = request.form.get("text", "").strip()[:20000], request.form.get("text_en", "").strip()[:20000]
    ext = f.filename.rsplit(".", 1)[-1].lower() if f and "." in f.filename else ""
    au = request.files.get("audio")
    aext = ext_of(au)
    if au and au.filename and aext not in AUDIO_EXT:
        return "O áudio tem de ser mp3, m4a, ogg, wav, aac, opus ou flac", 400
    if sec not in SECTIONS or (ext and ext not in KINDS) or (not ext and not text and not aext):
        return "Escolhe a secção e um ficheiro (imagem, vídeo, áudio) ou escreve o texto", 400
    if not title:
        return "Escreve um título", 400
    name = ""
    if ext:
        name = uuid.uuid4().hex + "." + ext
        f.save(UP / name)
    aname = ""
    if aext:
        aname = uuid.uuid4().hex + "." + aext
        au.save(UP / aname)
    item = {"id": uuid.uuid4().hex[:8], "section": sec, "title": title, "title_en": title_en,
            "file": name, "kind": KINDS[ext] if ext else "text", "audio": aname, "text": text, "text_en": text_en,
            "date": datetime.now().strftime("%Y-%m-%d")}
    with lock:
        items = load(ITEMS, [])
        items.insert(0, item)
        save(ITEMS, items)
    translate.now(title, text)
    return jsonify(item)


@app.put("/api/items/<iid>")
@admin
def edit_item(iid):
    f = request.files.get("file")
    sec = request.form.get("section")
    ext = ext_of(f)
    if sec not in SECTIONS or (f and f.filename and ext not in KINDS):
        return "Secção ou formato inválido", 400
    au = request.files.get("audio")
    aext = ext_of(au)
    if au and au.filename and aext not in AUDIO_EXT:
        return "O áudio tem de ser mp3, m4a, ogg, wav, aac, opus ou flac", 400
    new = uuid.uuid4().hex + "." + ext if f and f.filename else None
    if new:
        f.save(UP / new)
    anew = uuid.uuid4().hex + "." + aext if aext else None
    if anew:
        au.save(UP / anew)
    old_file = old_audio = None
    with lock:
        items = load(ITEMS, [])
        item = next((i for i in items if i["id"] == iid), None)
        if item is None:
            for x in (new, anew):
                if x:
                    (UP / x).unlink(missing_ok=True)
            return "Item não encontrado", 404
        item.update(section=sec, title=request.form.get("title", "").strip()[:120],
                    title_en=request.form.get("title_en", "").strip()[:120],
                    text=request.form.get("text", "").strip()[:20000], text_en=request.form.get("text_en", "").strip()[:20000])
        if anew:
            old_audio, item["audio"] = item.get("audio"), anew
        elif request.form.get("remove_audio") == "1":
            old_audio, item["audio"] = item.get("audio"), ""
        if request.form.get("remove_file") == "1" and (item.get("text") or item.get("audio")) and not new:
            old_file, item["file"], item["kind"] = item.get("file"), "", "text"
        if new:
            old_file, item["file"], item["kind"] = item["file"], new, KINDS[ext]
        save(ITEMS, items)
    for x in (old_file, old_audio):
        if x:
            (UP / x).unlink(missing_ok=True)
    translate.now(item.get("title"), item.get("text"))
    return jsonify(item)


@app.delete("/api/items/<iid>")
@admin
def del_item(iid):
    with lock:
        items = load(ITEMS, [])
        gone = [i for i in items if i["id"] == iid]
        save(ITEMS, [i for i in items if i["id"] != iid])
        keys = {f'{i["section"]}/{i["id"]}' for i in gone}
        if keys:  # os comentários dessa obra também vão
            save(COMMENTS, [c for c in load(COMMENTS, []) if page_of(c) not in keys])
    for i in gone:
        for k in ("file", "audio"):
            if i.get(k):
                (UP / i[k]).unlink(missing_ok=True)
    return "", 204


@app.post("/api/photo")
@admin
def set_photo():
    f = request.files.get("file")
    ext = f.filename.rsplit(".", 1)[-1].lower() if f and "." in f.filename else ""
    if KINDS.get(ext) != "image":
        return "Escolhe uma imagem", 400
    name = uuid.uuid4().hex + "." + ext
    f.save(UP / name)
    with lock:
        s = load(SITE, {})
        old, s["photo"] = s.get("photo"), name
        save(SITE, s)
    if old:
        (UP / old).unlink(missing_ok=True)
    return "", 204


@app.delete("/api/photo")
@admin
def del_photo():
    with lock:
        s = load(SITE, {})
        old = s.pop("photo", None)
        save(SITE, s)
    if old:
        (UP / old).unlink(missing_ok=True)
    return "", 204


# ---------- Opiniões (posts) ----------
POSTS = DATA / "posts.json"
AUDIO_EXT = {"mp3", "m4a", "ogg", "wav", "webm", "opus", "mp4", "aac", "flac"}
IMG_CT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}
UA = {"User-Agent": "Mozilla/5.0 (compatible; link-preview)"}


def ext_of(f):
    return f.filename.rsplit(".", 1)[-1].lower() if f and f.filename and "." in f.filename else ""


def store(f):
    name = uuid.uuid4().hex + "." + ext_of(f)
    f.save(UP / name)
    return name


def embed_for(url):
    """Converte links do YouTube/Vimeo/Spotify num player embebido (ou None)."""
    m = re.search(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|live/)|youtu\.be/)([\w-]{11})", url)
    if m:
        return {"kind": "video", "src": f"https://www.youtube-nocookie.com/embed/{m[1]}",
                "thumb": f"https://img.youtube.com/vi/{m[1]}/maxresdefault.jpg",
                "thumb2": f"https://img.youtube.com/vi/{m[1]}/hqdefault.jpg"}
    m = re.search(r"vimeo\.com/(?:video/)?(\d+)", url)
    if m:
        return {"kind": "video", "src": f"https://player.vimeo.com/video/{m[1]}"}
    m = re.search(r"open\.spotify\.com/(?:intl-[\w-]+/)?(track|album|playlist|episode|show|artist)/(\w+)", url)
    if m:
        return {"kind": "spotify" if m[1] in ("track", "episode") else "spotify-big",
                "src": f"https://open.spotify.com/embed/{m[1]}/{m[2]}"}
    return None


def fetch_meta(url):
    """Lê og:image e og:title da página (para a pré-visualização dos links)."""
    try:
        with urlopen(Request(url, headers=UA), timeout=8) as r:
            html = r.read(1_500_000).decode(r.headers.get_content_charset() or "utf-8", "replace")
    except Exception:
        return {}
    out = {}
    for key in ("image", "title"):
        for pat in (rf'<meta[^>]+(?:property|name)=["\'](?:og|twitter):{key}["\'][^>]*content=["\']([^"\']+)',
                    rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\'](?:og|twitter):{key}["\']'):
            m = re.search(pat, html, re.I)
            if m:
                out[key] = htmllib.unescape(m[1]).strip()
                break
    if "title" not in out:
        m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
        if m:
            out["title"] = htmllib.unescape(m[1]).strip()
    if "image" in out:
        out["image"] = urljoin(url, out["image"])
    return out


def download_image(url):
    """Guarda uma cópia local da imagem de pré-visualização (evita links partidos)."""
    try:
        with urlopen(Request(url, headers=UA), timeout=10) as r:
            ext = IMG_CT.get(r.headers.get_content_type())
            data = r.read(10_000_001)
        if not ext or len(data) > 10_000_000:
            return None
        name = uuid.uuid4().hex + "." + ext
        (UP / name).write_bytes(data)
        return name
    except Exception:
        return None


@app.get("/api/posts")
def get_posts():
    n = comment_counts()
    return jsonify([translate.add({**p, "comments": n.get(f'opinioes/{p["id"]}', 0)}, POST_TR) for p in load(POSTS, [])])


@app.post("/api/posts")
@admin
def add_post():
    return save_post(None)


@app.put("/api/posts/<pid>")
@admin
def edit_post(pid):
    return save_post(pid)


def save_post(pid):
    """Cria (pid=None) ou edita uma opinião. Na edição, o que não for enviado mantém-se."""
    old = {}
    if pid:
        old = next((p for p in load(POSTS, []) if p["id"] == pid), None)
        if old is None:
            return "Opinião não encontrada", 404
    g = lambda k, n: request.form.get(k, "").strip()[:n]
    mtype = g("media_type", 10)
    url = g("media_url", 2000)
    up = {k: (f if f and f.filename else None) for k in ("media_file", "cover", "audio", "music")
          for f in [request.files.get(k)]}
    mfile, cover, audio, music = up["media_file"], up["cover"], up["audio"], up["music"]
    if mtype not in {"none", "image", "video", "link"}:
        return "Tipo de media inválido", 400
    if url and not re.match(r"https?://", url, re.I):
        return "O link tem de começar por http:// ou https://", 400
    # ficheiro de media atual (só se reaproveita se for do mesmo tipo)
    keep_file = old.get("file") if old.get("media_type") == mtype else None
    file_kind = KINDS.get(ext_of(mfile)) if mfile else KINDS.get((keep_file or "").rsplit(".", 1)[-1])
    if mtype == "image" and file_kind != "image":
        return "Escolhe uma imagem (jpg, png, webp, gif)", 400
    if mtype == "video" and not url and file_kind != "video":
        return "Escolhe um vídeo (mp4, webm, m4v) ou cola um link do YouTube/Vimeo", 400
    if mtype == "link" and not url:
        return "Cola o link", 400
    if cover and KINDS.get(ext_of(cover)) != "image":
        return "A imagem de capa tem de ser jpg, png, webp ou gif", 400
    if audio and ext_of(audio) not in AUDIO_EXT:
        return "Formato de áudio inválido", 400
    if music and ext_of(music) not in AUDIO_EXT:
        return "A música tem de ser mp3, m4a, ogg, wav, aac, opus ou flac", 400
    text, text_en, title = g("text", 20000), g("text_en", 20000), g("title", 160)
    keep_audio = old.get("audio") if request.form.get("remove_audio") != "1" else None
    if not title or not (text or audio or keep_audio):
        return "Escreve um título e a tua opinião (texto ou áudio)", 400

    post = {"id": old.get("id") or uuid.uuid4().hex[:8],
            "date": old.get("date") or datetime.now().strftime("%Y-%m-%d"),
            "title": title, "title_en": g("title_en", 160),
            "text": text, "text_en": text_en, "media_type": mtype}
    if mtype in ("image", "video") and not (mtype == "video" and url):
        if mfile:
            post["file"] = store(mfile)
        elif keep_file:
            post["file"] = keep_file
    if request.form.get("remove_cover") != "1" and old.get("cover"):
        post["cover"] = old["cover"]
    if mtype in ("video", "link") and url:
        post["url"] = url
        if url == old.get("url"):  # link igual: não volta a ir buscar nada
            for k in ("embed", "link_title"):
                if old.get(k):
                    post[k] = old[k]
        else:
            emb = embed_for(url)
            if emb:
                post["embed"] = {"kind": emb["kind"], "src": emb["src"]}
            meta = {} if emb and emb.get("thumb") else fetch_meta(url)
            if meta.get("title"):
                post["link_title"] = meta["title"][:300]
            thumb = (emb or {}).get("thumb") or meta.get("image")
            if thumb and not cover:
                post["cover"] = (download_image(thumb) or (emb and emb.get("thumb2") and download_image(emb["thumb2"]))
                                 or post.get("cover"))
    elif mtype in ("none", "image") and not cover and post.get("cover") and old.get("url"):
        post.pop("cover")  # deixou de haver link: a capa automática deixa de fazer sentido
    if cover:
        post["cover"] = store(cover)
    if not post.get("cover"):
        post.pop("cover", None)
    if audio:
        post["audio"] = store(audio)
    elif keep_audio:
        post["audio"] = keep_audio
    if music:
        post["music"] = store(music)
    elif old.get("music") and request.form.get("remove_music") != "1":
        post["music"] = old["music"]
    with lock:
        posts = load(POSTS, [])
        if pid:
            posts = [post if p["id"] == pid else p for p in posts]
        else:
            posts.insert(0, post)
        save(POSTS, posts)
    for k in ("file", "cover", "audio", "music"):  # apaga ficheiros substituídos ou removidos
        if old.get(k) and old[k] not in (post.get("file"), post.get("cover"), post.get("audio"), post.get("music")):
            (UP / old[k]).unlink(missing_ok=True)
    translate.now(post.get("title"), post.get("text"), post.get("link_title"))
    return jsonify(post)


@app.delete("/api/posts/<pid>")
@admin
def del_post(pid):
    with lock:
        posts = load(POSTS, [])
        gone = [p for p in posts if p["id"] == pid]
        save(POSTS, [p for p in posts if p["id"] != pid])
        if gone:  # os comentários dessa opinião também vão
            save(COMMENTS, [c for c in load(COMMENTS, []) if page_of(c) != f"opinioes/{pid}"])
    for p in gone:
        for k in ("file", "cover", "audio", "music"):
            if p.get(k):
                (UP / p[k]).unlink(missing_ok=True)
    return "", 204


# ---------- Registo de visitantes e comentários em todas as páginas ----------
COMMENTS = DATA / "comments.json"
USERS = DATA / "users.json"   # {uid: {name, ig, email, created, token (sha256), ip}}
_recent_comments, _recent_regs = {}, {}  # anti-spam por IP
SECTION_NAMES = {"musica": "música", "escrita": "escrita", "podcast": "podcast", "opinioes": "opinião"}


def page_of(c):
    """Página do comentário: 'opinioes/<id>' ou '<secção>/<id>' (os antigos só tinham 'post')."""
    return c.get("page") or f'opinioes/{c.get("post", "")}'


def page_title(key, posts=None, items=None):
    sec, _, pid = key.partition("/")
    src = (posts if posts is not None else load(POSTS, [])) if sec == "opinioes" else \
        [i for i in (items if items is not None else load(ITEMS, [])) if i["section"] == sec]
    return next((x["title"] for x in src if x["id"] == pid), None)


def comment_counts():
    return Counter(page_of(c) for c in load(COMMENTS, []))


def user_from_token(token):
    token = str(token or "")
    if len(token) < 20:
        return None, None
    h = hashlib.sha256(token.encode()).hexdigest()
    for uid, u in load(USERS, {}).items():
        if any(hmac.compare_digest(t, h) for t in u.get("tokens", []) + [u.get("token", "")] if t):
            return uid, u
    return None, None


def clean_ig(v):
    ig = str(v or "").strip().lstrip("@").rstrip("/").split("/")[-1][:30]
    return ig if re.fullmatch(r"[A-Za-z0-9._]{1,30}", ig) else ("" if not ig else None)


# ---------- Entrar com Facebook / Google (OAuth) ----------
OAUTH = DATA / "oauth.json"  # {"facebook": {"id", "secret"}, "google": {"id", "secret"}} — fora do git
PROVIDERS = {
    "facebook": {"auth": "https://www.facebook.com/v21.0/dialog/oauth", "token": "https://graph.facebook.com/v21.0/oauth/access_token",
                 "scope": "public_profile,email", "label": "Facebook"},
    "google": {"auth": "https://accounts.google.com/o/oauth2/v2/auth", "token": "https://oauth2.googleapis.com/token",
               "scope": "openid email profile", "label": "Google"},
}


def oauth_cfg():
    return load(OAUTH, {})


def redirect_uri(p):
    return request.host_url + f"auth/{p}/callback"


@app.get("/api/auth/providers")
def auth_providers():
    c = oauth_cfg()
    return jsonify([p for p in PROVIDERS if c.get(p, {}).get("id") and c.get(p, {}).get("secret")])


@app.get("/auth/<p>")
def auth_start(p):
    c = oauth_cfg().get(p, {})
    if p not in PROVIDERS or not c.get("id"):
        return "Login indisponível", 404
    session["oauth_state"] = state = secrets.token_urlsafe(16)
    nxt = request.args.get("next", "/")
    session["oauth_next"] = nxt if re.fullmatch(r"/[\w\-/#?=&.%]*", nxt or "") else "/"
    q = {"client_id": c["id"], "redirect_uri": redirect_uri(p), "response_type": "code", "scope": PROVIDERS[p]["scope"], "state": state}
    if p == "google":
        q["prompt"] = "select_account"
    return redirect(PROVIDERS[p]["auth"] + "?" + urlencode(q))


def _http_json(url, data=None, headers=None):
    req = Request(url, data=urlencode(data).encode() if data else None, headers={"Accept": "application/json", **(headers or {})})
    with urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def _profile(p, code):
    c = oauth_cfg()[p]
    if p == "facebook":
        tok = _http_json(PROVIDERS[p]["token"] + "?" + urlencode({"client_id": c["id"], "client_secret": c["secret"],
                                                                 "redirect_uri": redirect_uri(p), "code": code}))["access_token"]
        me = _http_json("https://graph.facebook.com/v21.0/me?" + urlencode({"fields": "id,name,email,picture.width(200).height(200)",
                                                                         "access_token": tok}))
        return {"pid": me["id"], "name": me.get("name", ""), "email": me.get("email", ""),
                "picture": (me.get("picture") or {}).get("data", {}).get("url", "")}
    tok = _http_json(PROVIDERS[p]["token"], {"code": code, "client_id": c["id"], "client_secret": c["secret"],
                                             "redirect_uri": redirect_uri(p), "grant_type": "authorization_code"})["access_token"]
    me = _http_json("https://openidconnect.googleapis.com/v1/userinfo", headers={"Authorization": f"Bearer {tok}"})
    return {"pid": me["sub"], "name": me.get("name", ""), "email": me.get("email", ""), "picture": me.get("picture", "")}


def _login_page(acct, nxt, error=""):
    data = json.dumps(acct) if acct else "null"
    return f"""<!doctype html><meta charset="utf-8"><title>…</title><body style="background:#0f1112;color:#e8e6e1;font:18px Georgia,serif;padding:10vh 8vw">
<p>{htmllib.escape(error) if error else "A entrar…"}</p><p><a style="color:#9dbfab" href="/">voltar ao site</a></p>
<script>try{{var a={data};if(a)localStorage.setItem("acct",JSON.stringify(a))}}catch(e){{}}{"" if error else f"location.replace({json.dumps(nxt)})"}</script>"""


@app.get("/auth/<p>/callback")
def auth_callback(p):
    nxt = session.pop("oauth_next", "/")
    if p not in PROVIDERS or not request.args.get("state") or request.args.get("state") != session.pop("oauth_state", None):
        return _login_page(None, nxt, "O login expirou ou foi cancelado. Tenta outra vez."), 400
    if request.args.get("error") or not request.args.get("code"):
        return _login_page(None, nxt, "Login cancelado.")
    try:
        prof = _profile(p, request.args["code"])
    except Exception:
        return _login_page(None, nxt, f"Não foi possível entrar com {PROVIDERS[p]['label']}. Tenta outra vez."), 502
    ip, now = request.remote_addr or "", datetime.now().isoformat(timespec="seconds")
    token = secrets.token_urlsafe(24)
    th = hashlib.sha256(token.encode()).hexdigest()
    with lock:
        users = load(USERS, {})
        uid = next((k for k, u in users.items() if u.get("provider") == p and u.get("pid") == prof["pid"]), None) or uuid.uuid4().hex[:8]
        u = users.get(uid, {"created": now, "ig": "", "tokens": []})
        new = uid not in users
        u.update(provider=p, pid=prof["pid"], name=prof["name"][:80] or "Sem nome", email=prof["email"][:120],
                 picture=prof["picture"][:500], last_login=now, ip=ip, geo=geo.locate(ip))
        u["tokens"] = (u.get("tokens", []) + [th])[-10:]  # até 10 aparelhos
        users[uid] = u
        save(USERS, users)
    if new:
        notify_register(u["name"] + f" ({PROVIDERS[p]['label']})", "")
    return _login_page({"token": token, "name": u["name"], "ig": u.get("ig", ""), "picture": u["picture"], "provider": p}, nxt)


@app.get("/api/me/comments")
def my_comments():
    uid, u = user_from_token(request.args.get("token") or request.headers.get("X-Token"))
    if not u:
        return jsonify([]), 401
    posts, items = load(POSTS, []), load(ITEMS, [])
    return jsonify([{**public_comment(c), "page": page_of(c), "title": page_title(page_of(c), posts, items) or "(página apagada)"}
                    for c in reversed(load(COMMENTS, [])) if c.get("uid") == uid])


@app.post("/api/me/delete")
def delete_me():
    """Apagar a conta (e os comentários, se a pessoa quiser) — exigido pelo Facebook e pelo RGPD."""
    d = request.get_json(silent=True) or {}
    uid, u = user_from_token(d.get("token"))
    if not u:
        return "Sessão inválida", 401
    with lock:
        users = load(USERS, {})
        users.pop(uid, None)
        save(USERS, users)
        if d.get("comments"):
            save(COMMENTS, [c for c in load(COMMENTS, []) if c.get("uid") != uid])
    return "", 204


@app.post("/api/me/logout")
def logout_me():
    token = str((request.get_json(silent=True) or {}).get("token", ""))
    h = hashlib.sha256(token.encode()).hexdigest()
    with lock:
        users = load(USERS, {})
        for u in users.values():
            if h in u.get("tokens", []):
                u["tokens"].remove(h)
        save(USERS, users)
    return "", 204


@app.get("/api/oauth")
@admin
def get_oauth():
    c = oauth_cfg()
    return jsonify({p: {"id": c.get(p, {}).get("id", ""), "has_secret": bool(c.get(p, {}).get("secret")),
                        "redirect": request.host_url + f"auth/{p}/callback"} for p in PROVIDERS})


@app.post("/api/oauth")
@admin
def set_oauth():
    d = request.get_json(silent=True) or {}
    with lock:
        c = oauth_cfg()
        for p in PROVIDERS:
            x = d.get(p) or {}
            cur = c.get(p, {})
            if "id" in x:
                cur["id"] = re.sub(r"[^\w.\-]", "", str(x["id"]))[:200]
            if x.get("secret"):
                cur["secret"] = re.sub(r"[^\w.\-]", "", str(x["secret"]))[:200]
            c[p] = cur
        save(OAUTH, c)
    return "", 204


def public_comment(c):
    out = {k: c[k] for k in ("id", "name", "ig", "text", "t", "reply") if k in c}
    pic = (load(USERS, {}).get(c.get("uid"), {}) or {}).get("picture") if c.get("uid") else ""
    if pic:
        out["picture"] = pic
    return out


@app.post("/api/register")
def register():
    d = request.get_json(silent=True) or {}
    if d.get("website"):
        return "", 204
    name = re.sub(r"\s+", " ", str(d.get("name", ""))).strip()[:60]
    ig, email = clean_ig(d.get("ig")), str(d.get("email", "")).strip()[:120]
    if not name:
        return "Escreve o teu nome", 400
    if ig is None:
        return "O @instagram só pode ter letras, números, pontos e _", 400
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return "Email inválido", 400
    if not d.get("accept"):
        return "Tens de aceitar a nota de privacidade", 400
    ip, now = request.remote_addr or "", datetime.now()
    with lock:
        times = [t for t in _recent_regs.get(ip, []) if (now - t).total_seconds() < 86400]
        if len(times) >= 5:
            return "Demasiados registos a partir desta rede. Tenta amanhã.", 429
        _recent_regs[ip] = times + [now]
        token, uid = secrets.token_urlsafe(24), uuid.uuid4().hex[:8]
        users = load(USERS, {})
        users[uid] = {"name": name, "ig": ig, "email": email, "created": now.isoformat(timespec="seconds"),
                      "tokens": [hashlib.sha256(token.encode()).hexdigest()], "provider": "nome", "ip": ip, "geo": geo.locate(ip)}
        save(USERS, users)
    notify_register(name, ig)
    return jsonify({"uid": uid, "token": token, "name": name, "ig": ig})


@app.post("/api/me")
def me():
    uid, u = user_from_token((request.get_json(silent=True) or {}).get("token"))
    return jsonify({"name": u["name"], "ig": u.get("ig", ""), "picture": u.get("picture", ""), "provider": u.get("provider", ""),
                    "email": u.get("email", "")} if u else {}), (200 if u else 404)


@app.get("/api/comments")
def get_comments():
    key = request.args.get("page") or f'opinioes/{request.args.get("post", "")}'
    return jsonify([translate.add(public_comment(c), COMMENT_TR) for c in load(COMMENTS, []) if page_of(c) == key])


@app.post("/api/comments")
def add_comment():
    d = request.get_json(silent=True) or {}
    if d.get("website"):  # campo escondido: só os robôs o preenchem
        return jsonify({"ok": True})
    uid, u = user_from_token(d.get("token"))
    if not u:
        return "Para comentar, regista-te primeiro.", 401
    key = str(d.get("page") or f'opinioes/{d.get("post", "")}')[:80]
    text = str(d.get("text", "")).strip()[:1500]
    if not text:
        return "Escreve o comentário", 400
    if page_title(key) is None:
        return "Página não encontrada", 404
    ip, now = request.remote_addr or "", datetime.now()
    with lock:
        times = [t for t in _recent_comments.get(ip, []) if (now - t).total_seconds() < 86400]
        if (times and (now - times[-1]).total_seconds() < 20) or len(times) >= 30:
            return "Muitos comentários seguidos. Tenta daqui a pouco.", 429
        _recent_comments[ip] = times + [now]
        c = {"id": uuid.uuid4().hex[:8], "page": key, "uid": uid, "name": u["name"], "ig": u["ig"], "text": text,
             "t": now.isoformat(timespec="seconds"), "ip": ip, "geo": geo.locate(ip)}
        cs = load(COMMENTS, [])
        cs.append(c)
        save(COMMENTS, cs)
    notify_comment(c)
    translate.en(text)  # fica na fila para a versão em inglês
    return jsonify(public_comment(c))


@app.get("/api/comments/all")
@admin
def all_comments():
    posts, items = load(POSTS, []), load(ITEMS, [])
    out = []
    for c in reversed(load(COMMENTS, [])):
        k = page_of(c)
        out.append({**c, "page": k, "section": SECTION_NAMES.get(k.split("/")[0], ""),
                    "post_title": page_title(k, posts, items) or "(página apagada)"})
    pages = [{"page": f"opinioes/{p['id']}", "section": "opinião", "title": p["title"]} for p in posts] + \
            [{"page": f"{i['section']}/{i['id']}", "section": SECTION_NAMES.get(i["section"], i["section"]), "title": i["title"]} for i in items]
    n = Counter(c["page"] for c in out)
    for pg in pages:
        pg["count"] = n.get(pg["page"], 0)
    return jsonify({"comments": out, "pages": sorted(pages, key=lambda x: -x["count"])})


@app.get("/api/users")
@admin
def list_users():
    rows, cs = read_visits(), load(COMMENTS, [])
    out = []
    for uid, u in load(USERS, {}).items():
        mine = [r for r in rows if r.get("uid") == uid]
        out.append({"uid": uid, "name": u["name"], "ig": u.get("ig", ""), "email": u.get("email", ""),
                    "provider": u.get("provider", "nome"), "picture": u.get("picture", ""),
                    "created": u["created"], "geo": u.get("geo", ""), "comments": sum(1 for c in cs if c.get("uid") == uid),
                    "views": len(mine), "last": max((r["t"] for r in mine), default="")})
    return jsonify(sorted(out, key=lambda x: x["last"] or x["created"], reverse=True))


@app.delete("/api/users/<uid>")
@admin
def del_user(uid):
    with lock:
        users = load(USERS, {})
        users.pop(uid, None)
        save(USERS, users)
    return "", 204


@app.post("/api/comments/<cid>/reply")
@admin
def reply_comment(cid):
    reply = str((request.get_json(silent=True) or {}).get("reply", "")).strip()[:1500]
    with lock:
        cs = load(COMMENTS, [])
        for c in cs:
            if c["id"] == cid:
                if reply:
                    c["reply"] = reply
                else:
                    c.pop("reply", None)
        save(COMMENTS, cs)
    return "", 204


@app.delete("/api/comments/<cid>")
@admin
def del_comment(cid):
    with lock:
        save(COMMENTS, [c for c in load(COMMENTS, []) if c["id"] != cid])
    return "", 204


# ---------- Partilha (Facebook, WhatsApp, ...) ----------
def og_tags(title, desc, image, url, kind="article"):
    e = lambda v: htmllib.escape(v or "", quote=True)
    desc = re.sub(r"\s+", " ", desc or "").strip()
    desc = desc[:197] + "…" if len(desc) > 200 else desc
    t = [f'<meta property="og:{k}" content="{e(v)}">' for k, v in
         (("type", kind), ("title", title), ("description", desc), ("url", url),
          ("site_name", load(SITE, {}).get("name", "")), ("locale", "pt_PT")) if v]
    t += [f'<meta name="description" content="{e(desc)}">', f'<link rel="canonical" href="{e(url)}">']
    if image and (UP / image).exists():
        t += [f'<meta property="og:image" content="{e(request.host_url)}media/{e(image)}">',
              '<meta name="twitter:card" content="summary_large_image">']
        if Image:
            try:
                with Image.open(UP / image) as im:
                    t += [f'<meta property="og:image:width" content="{im.width}">',
                          f'<meta property="og:image:height" content="{im.height}">']
            except Exception:
                pass
    return "\n".join(t) + "\n"


@app.get("/p/<pid>")
def share_post(pid):
    """Links de partilha antigos: reencaminham para o endereço real (que já tem a pré-visualização)."""
    p = next((x for x in load(POSTS, []) if x["id"] == pid), None)
    if p:
        return redirect(f"/opinioes/{pid}", 301)
    i = next((x for x in load(ITEMS, []) if x["id"] == pid), None)
    return redirect(f"/{i['section']}/{pid}" if i else "/", 301)


# ---------- Visitas ----------
VISITS = DATA / "visits.jsonl"
KEEP_DAYS = 90
BOTS = re.compile(r"bot|crawl|spider|slurp|facebookexternalhit|preview|fetch|curl|wget|python|monitor|headless", re.I)


def device(ua):
    d = "telemóvel" if re.search(r"Mobi|Android|iPhone", ua) else "tablet" if re.search(r"iPad|Tablet", ua) else "computador"
    b = next((n for k, n in (("Edg/", "Edge"), ("OPR/", "Opera"), ("SamsungBrowser", "Samsung"), ("Firefox/", "Firefox"),
                            ("FBAN", "Facebook"), ("Instagram", "Instagram"), ("Chrome/", "Chrome"), ("Safari/", "Safari"))
              if k in ua), "outro")
    return f"{d} · {b}"


# --- quem é quem: nomes dados no admin, links personalizados, origem, modelo ---
LABELS = DATA / "labels.json"  # {"vid:<id>" | "ip:<ip>": {"name": "...", "me": bool}}
LINKS = DATA / "links.json"    # {"<código>": {"name": "Ana", "created": "..."}}
IPHONES = {"iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max", "iPhone11,8": "iPhone XR",
           "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE (2.ª)",
           "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
           "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
           "iPhone14,6": "iPhone SE (3.ª)", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus", "iPhone15,2": "iPhone 14 Pro",
           "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus", "iPhone16,1": "iPhone 15 Pro",
           "iPhone16,2": "iPhone 15 Pro Max", "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,1": "iPhone 16 Pro",
           "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,5": "iPhone 16e", "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max",
           "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air"}


def ua_model(ua):
    """Modelo do aparelho quando o User-Agent o diz (apps do Facebook/Instagram, alguns Android)."""
    m = re.search(r"(iPhone\d+,\d+)", ua)
    if m:
        return IPHONES.get(m[1], m[1])
    m = re.search(r"Android [\d.]+; ([^;)]+?)(?: Build/|\)|;)", ua)
    if m and m[1].strip() not in ("K", "wv", "Mobile"):
        return m[1].strip()[:40]
    return ""


def ua_app(ua):
    for k, n in (("Instagram", "app do Instagram"), ("FBAN", "app do Facebook"), ("FBAV", "app do Facebook"), ("FB_IAB", "app do Facebook"),
                 ("Messenger", "Messenger"), ("musical_ly", "TikTok"), ("BytedanceWebview", "TikTok"), ("LinkedInApp", "LinkedIn")):
        if k in ua:
            return n
    return ""


REF_NAMES = (("facebook.", "Facebook"), ("fb.", "Facebook"), ("instagram.", "Instagram"), ("google.", "Google"), ("bing.", "Bing"),
             ("duckduckgo.", "DuckDuckGo"), ("whatsapp", "WhatsApp"), ("wa.me", "WhatsApp"), ("t.co", "X/Twitter"),
             ("twitter.", "X/Twitter"), ("tiktok.", "TikTok"), ("youtube.", "YouTube"), ("linkedin.", "LinkedIn"))


def source_of(rec):
    if rec.get("tag"):
        return f"link para {rec['tag']}"
    app_ = ua_app(rec.get("ua", ""))
    host = re.sub(r"^https?://(www\.|m\.|l\.|lm\.)?([^/]+).*", r"\2", rec.get("ref", "")) if rec.get("ref") else ""
    name = next((n for k, n in REF_NAMES if k in host), host)
    if app_ and (not name or name.lower() in app_.lower()):
        return app_
    return (name + (f" ({app_})" if app_ else "")) if name else (app_ or "direto")


RDNS = DATA / "rdns.json"  # cache: ip -> nome de rede (DNS inverso)
_rdns_lock = threading.Lock()


def rdns_cache():
    return load(RDNS, {})


def rdns_lookup(ip):
    """Nome público do endereço (ex.: 'proxy.empresa.pt' ou 'bl6-12-34.dsl.telepac.pt'). Corre em segundo plano."""
    import socket
    if not ip or ip in rdns_cache():
        return
    try:
        if ipaddress.ip_address(ip).is_private:
            name = ""
        else:
            socket.setdefaulttimeout(3)
            name = socket.gethostbyaddr(ip)[0][:120]
    except Exception:
        name = ""
    with _rdns_lock:
        c = rdns_cache()
        c[ip] = name
        if len(c) > 20000:
            c = dict(list(c.items())[-10000:])
        save(RDNS, c)


@app.post("/api/hit")
def hit():
    ua = request.headers.get("User-Agent", "")
    if not ua or BOTS.search(ua):
        return "", 204
    d = request.get_json(silent=True) or {}
    ip = request.remote_addr or ""
    rec = {"t": datetime.now().isoformat(timespec="seconds"), "ip": ip,
           "path": str(d.get("path", "/"))[:200], "ref": str(d.get("ref", ""))[:300], "dev": device(ua),
           "geo": geo.locate(ip), "isp": geo.isp(ip)}
    vid = str(d.get("vid", ""))
    if re.fullmatch(r"[a-z0-9]{8,24}", vid):  # número anónimo deste browser
        rec["vid"] = vid
    model = re.sub(r"[^\w .+()/-]", "", str(d.get("model", ""))).strip()[:40]
    if model:  # modelo do telemóvel (só Android/Chrome o revela)
        rec["model"] = model
    uid, u = user_from_token(d.get("token"))
    who = who_label(u["name"], u.get("ig")) if u else who_label(d.get("name"), d.get("ig"))
    if u:  # pessoa registada
        rec["uid"] = uid
    if who:
        rec["who"] = who
    rec["ua"] = ua[:400]
    for k, pat in (("screen", r"\d{2,5}x\d{2,5}(@[\d.]{1,4})?"), ("lang", r"[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?"), ("tz", r"[A-Za-z_]+(/[A-Za-z_+\-]+){0,2}")):
        v = str(d.get(k, ""))[:40]
        if re.fullmatch(pat, v):
            rec[k] = v
    threading.Thread(target=rdns_lookup, args=(ip,), daemon=True).start()
    if not rec.get("model") and ua_model(ua):
        rec["model"] = ua_model(ua)
    code = str(d.get("de", ""))[:40]
    link = load(LINKS, {}).get(code) if code else None
    if link:  # veio de um link personalizado
        rec["tag"] = link["name"]
    with lock, VISITS.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    notify_visit(rec)
    return "", 204


def who_label(name, ig):
    name = re.sub(r"\s+", " ", str(name or "")).strip()[:60]
    ig = str(ig or "").strip().lstrip("@")[:30]
    ig = ig if re.fullmatch(r"[A-Za-z0-9._]{1,30}", ig) else ""
    return (name + (f" (@{ig})" if ig else "")).strip() if (name or ig) else ""


def read_visits():
    try:
        return [json.loads(l) for l in VISITS.read_text("utf-8").splitlines() if l.strip()]
    except FileNotFoundError:
        return []


def visitor_stats(rows):
    """Para cada browser (vid): nº de visitante (pela ordem da 1ª visita), nº de visitas e nome conhecido."""
    st, last = {}, {}
    for r in sorted(rows, key=lambda r: r["t"]):
        v = r.get("vid")
        if not v:
            continue
        x = st.setdefault(v, {"vid": v, "n": len(st) + 1, "visits": 0, "who": "", "first": r["t"], "last": r["t"],
                              "geo": "", "dev": "", "model": "", "isp": ""})
        t = datetime.fromisoformat(r["t"])
        if v not in last or (t - last[v]).total_seconds() > SESSION_GAP:
            x["visits"] += 1
        last[v] = t
        x.update(last=r["t"], geo=r.get("geo") or x["geo"], dev=r.get("dev") or x["dev"],
                 model=r.get("model") or x["model"], isp=r.get("isp") or x["isp"], who=r.get("who") or x["who"])
    return st


def sessions_of(rows, labels):
    """Junta páginas vistas em visitas (30 min sem atividade = visita nova) e diz quem é cada uma."""
    titles = {"opinioes": {p["id"]: p["title"] for p in load(POSTS, [])}}
    for i in load(ITEMS, []):
        titles.setdefault(i["section"], {})[i["id"]] = i["title"]
    def pname(path):
        a, _, b = path.strip("/").partition("/")
        return "início" if not a else (f"{a}: {titles.get(a, {}).get(b, b)}" if b else a)
    vs = visitor_stats(rows)
    rd = rdns_cache()
    tag_of = {r["vid"]: r["tag"] for r in rows if r.get("vid") and r.get("tag")}
    out, open_ = [], {}
    for r in sorted(rows, key=lambda r: r["t"]):
        key = r.get("vid") or f'{r["ip"]}|{r["dev"]}'
        t = datetime.fromisoformat(r["t"])
        s = open_.get(key)
        if not s or (t - s["_t"]).total_seconds() > SESSION_GAP:
            lab = (labels.get(f'vid:{r["vid"]}') if r.get("vid") else None) or labels.get(f'ip:{r["ip"]}') or {}
            v = vs.get(r.get("vid"), {})
            known = lab.get("name") or r.get("tag") or tag_of.get(r.get("vid")) or r.get("who") or v.get("who")
            s = {"start": r["t"], "end": r["t"], "who": known or (f"Visitante nº {v['n']}" if v else "Visitante (antigo, sem número)"),
                 "named": bool(known), "me": bool(lab.get("me")), "vid": r.get("vid", ""), "vn": v.get("n"), "ip": r["ip"],
                 "geo": r.get("geo", ""), "isp": r.get("isp", ""), "dev": r["dev"], "model": r.get("model", ""),
                 "source": source_of(r), "pages": [], "_t": t, "key": key, "rdns": rd.get(r["ip"], ""),
                 "screen": r.get("screen", ""), "lang": r.get("lang", ""), "tz": r.get("tz", "")}
            open_[key] = s
            out.append(s)
        s["_t"], s["end"] = t, r["t"]
        s["model"] = s["model"] or r.get("model", "")
        for k in ("screen", "lang", "tz"):
            s[k] = s[k] or r.get(k, "")
        p = pname(r["path"])
        if not s["pages"] or s["pages"][-1] != p:
            s["pages"].append(p)
    for s in out:
        s.pop("_t")
    return out


def is_me(r, labels):
    return bool((labels.get(f'vid:{r.get("vid")}') or {}).get("me") or (labels.get(f'ip:{r["ip"]}') or {}).get("me"))


@app.post("/api/labels")
@admin
def set_label():
    d = request.get_json(silent=True) or {}
    kind, ident = d.get("kind"), str(d.get("id", ""))[:60]
    if kind not in ("vid", "ip") or not ident:
        return "Pedido inválido", 400
    name = re.sub(r"\s+", " ", str(d.get("name", ""))).strip()[:60]
    with lock:
        labels = load(LABELS, {})
        if name or d.get("me"):
            labels[f"{kind}:{ident}"] = {"name": name, "me": bool(d.get("me"))}
        else:
            labels.pop(f"{kind}:{ident}", None)
        save(LABELS, labels)
    return "", 204


@app.get("/api/links")
@admin
def get_links():
    opened = Counter(r.get("tag") for r in read_visits() if r.get("tag"))
    return jsonify([{"code": c, **v, "opened": opened.get(v["name"], 0)} for c, v in load(LINKS, {}).items()])


@app.post("/api/links")
@admin
def add_link():
    import unicodedata
    name = re.sub(r"\s+", " ", str((request.get_json(silent=True) or {}).get("name", ""))).strip()[:40]
    if not name:
        return "Escreve o nome da pessoa", 400
    slug = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()).strip("-")[:16] or "link"
    code = f"{slug}-{secrets.token_hex(2)}"
    with lock:
        links = load(LINKS, {})
        links[code] = {"name": name, "created": datetime.now().strftime("%Y-%m-%d")}
        save(LINKS, links)
    return jsonify({"code": code})


@app.delete("/api/links/<code>")
@admin
def del_link(code):
    with lock:
        links = load(LINKS, {})
        links.pop(code, None)
        save(LINKS, links)
    return "", 204


@app.get("/api/visits")
@admin
def visits():
    cutoff = (datetime.now() - timedelta(days=KEEP_DAYS)).isoformat()
    with lock:
        rows = read_visits()
        kept = [r for r in rows if r["t"] >= cutoff]
        for r in kept:  # visitas antigas, de antes de haver localização
            if not r.get("geo"):
                r["geo"] = geo.locate(r["ip"])
            if "isp" not in r:
                r["isp"] = geo.isp(r["ip"])
        if len(kept) != len(rows):  # apaga visitas com mais de 90 dias
            VISITS.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in kept), "utf-8")
    labels = load(LABELS, {})
    sess_all = sessions_of(kept, labels)
    hide = request.args.get("hide_me") == "1"
    if hide:
        kept = [r for r in kept if not is_me(r, labels)]
    now = datetime.now()
    vs = visitor_stats(kept)
    def summary(days):
        since = (now - timedelta(days=days)).isoformat()
        rs = [r for r in kept if r["t"] >= since]
        return {"views": len(rs), "people": len({(r["ip"], r["dev"]) for r in rs})}
    top = lambda key, n=10: Counter(r[key] for r in kept if r[key]).most_common(n)
    refs = Counter(re.sub(r"^https?://(www\.)?([^/]+).*", r"\2", r["ref"]) for r in kept if r["ref"])
    days = Counter(r["t"][:10] for r in kept)
    return jsonify({"today": summary(1), "week": summary(7), "month": summary(30),
                    "pages": top("path"), "refs": refs.most_common(10), "devices": top("dev", 8),
                    "countries": Counter(r["geo"].split(", ")[-1] for r in kept if r.get("geo")).most_common(10),
                    "cities": top("geo", 10),
                    "daily": [[(now - timedelta(days=i)).strftime("%Y-%m-%d"),
                               days.get((now - timedelta(days=i)).strftime("%Y-%m-%d"), 0)] for i in range(29, -1, -1)],
                    "recent": [{**r, "vn": vs.get(r.get("vid"), {}).get("n"), "who": r.get("who") or vs.get(r.get("vid"), {}).get("who", "")}
                               for r in sorted(kept, key=lambda r: r["t"], reverse=True)[:200]],
                    "visitors": sorted(vs.values(), key=lambda x: x["last"], reverse=True)[:100],
                    "sessions": [x for x in reversed(sess_all) if not (hide and x["me"])][:300],
                    "you": {"ip": request.remote_addr, "label": labels.get(f"ip:{request.remote_addr}", {})},
                    "labels": labels})


# ---------- Notificações no telemóvel (ntfy.sh) ----------
NOTIFY = DATA / "notify.json"  # fica fora de /api/site: o nome do canal é secreto
SESSION_GAP = 30 * 60          # sem atividade durante 30 min = visita nova
_last_seen = {}                # (ip, dispositivo) -> última página vista


def notify_cfg():
    c = load(NOTIFY, {})
    if not c.get("topic"):  # canal aleatório, difícil de adivinhar
        c = {"topic": "site-" + secrets.token_hex(8), "visits": True, "comments": True, **c}
        save(NOTIFY, c)
    return c


def page_name(path):
    a, _, b = path.strip("/").partition("/")
    if not a:
        return "início"
    if b:
        src = load(POSTS, []) if a == "opinioes" else load(ITEMS, [])
        t = next((x["title"] for x in src if x["id"] == b), b)
        return f"{a}: {t}"
    return a


_wa_lock = threading.Lock()  # uma mensagem de WhatsApp de cada vez (o serviço gratuito não gosta de rajadas)


def send_whatsapp(c, title, message, click=""):
    """WhatsApp para o próprio dono, via CallMeBot (gratuito, uso pessoal). Devolve (ok, resposta)."""
    text = f"*{title}*\n{message}" + (f"\n{click}" if click else "")
    url = ("https://api.callmebot.com/whatsapp.php?phone=" + quote(c["wa_phone"], safe="") +
           "&text=" + quote(text[:1500], safe="") + "&apikey=" + quote(c["wa_key"], safe=""))
    with _wa_lock:
        try:
            with urlopen(Request(url, headers=UA), timeout=20) as r:
                body = r.read(2000).decode("utf-8", "replace")
            ok = "error" not in body.lower()
        except Exception as e:
            ok, body = False, str(e)
        time.sleep(2)
    return ok, re.sub(r"<[^>]+>", " ", body).strip()[:300]


def push(title, message, tags, click=""):
    c = notify_cfg()
    body = {"topic": c["topic"], "title": title[:200], "message": message[:3000], "tags": tags}
    if click:
        body["click"] = click

    def send():
        if c.get("ntfy_on", True):
            try:
                urlopen(Request("https://ntfy.sh/", data=json.dumps(body).encode(),
                                headers={"Content-Type": "application/json"}), timeout=10).close()
            except Exception:
                pass
        if c.get("wa_on") and c.get("wa_phone") and c.get("wa_key"):
            send_whatsapp(c, title, message, click)
        send_push(title, message, click, contact)
    contact = request.host_url.rstrip("/")
    threading.Thread(target=send, daemon=True).start()


def notify_visit(rec):
    if not notify_cfg().get("visits") or is_me(rec, load(LABELS, {})):
        return
    key, now = rec.get("vid") or (rec["ip"], rec["dev"]), datetime.now()
    with lock:
        last = _last_seen.get(key)
        _last_seen[key] = now
        if len(_last_seen) > 5000:  # limpeza
            for k, t in list(_last_seen.items()):
                if (now - t).total_seconds() > SESSION_GAP:
                    del _last_seen[k]
    if last and (now - last).total_seconds() < SESSION_GAP:
        return  # mesma visita, outra página
    lines = []
    if rec.get("vid"):
        with lock:
            v = visitor_stats(read_visits()).get(rec["vid"], {})
        k = v.get("visits", 1)
        lab = load(LABELS, {}).get(f'vid:{rec["vid"]}') or {}
        name = lab.get("name") or rec.get("tag") or rec.get("who") or v.get("who") or f"Visitante nº {v.get('n', '?')}"
        lines.append(f"👤 {name} · " + ("primeira visita" if k <= 1 else f"{k}ª visita"))
    lines.append("📱 " + (rec["model"] + " · " if rec.get("model") else "") + rec["dev"])
    if rec.get("isp"):
        lines.append("📶 " + rec["isp"])
    lines.append("📄 " + page_name(rec["path"]))
    if source_of(rec) != "direto":
        lines.append("↪ " + source_of(rec))
    push(f"Nova visita · {rec['geo'] or 'local desconhecido'}", "\n".join(lines), ["eyes"], request.host_url + "admin#visitas")


def notify_comment(c):
    if not notify_cfg().get("comments"):
        return
    title = page_title(page_of(c)) or ""
    who = c["name"] + (f" (@{c['ig']})" if c.get("ig") else "")
    push(f"Novo comentário de {who}", f"Em: {title}\n\n{c['text']}", ["speech_balloon"], request.host_url + "admin#coments")


# --- push do próprio site (sem serviços de terceiros) ---
PUSH = DATA / "push.json"  # aparelhos que ativaram as notificações


def send_push(title, message, click, contact):
    subs, gone = load(PUSH, []), []
    for sub in subs:
        code = webpush.send(sub, {"title": title, "body": message, "url": click or "/admin"}, contact)
        if code in (404, 410):  # o aparelho desativou / desinstalou
            gone.append(sub["endpoint"])
    if gone:
        with lock:
            save(PUSH, [x for x in load(PUSH, []) if x["endpoint"] not in gone])


@app.get("/sw.js")
def service_worker():
    r = send_from_directory(app.static_folder, "sw.js", mimetype="application/javascript", max_age=0)
    r.headers["Service-Worker-Allowed"] = "/"
    return r


@app.get("/admin.webmanifest")
def admin_manifest():
    return jsonify({"name": "Admin · " + load(SITE, {}).get("name", "site"), "short_name": "Admin",
                    "start_url": "/admin", "scope": "/", "display": "standalone",
                    "background_color": "#0f1112", "theme_color": "#0f1112",
                    "icons": [{"src": "/s/icon-192.png", "sizes": "192x192", "type": "image/png"},
                              {"src": "/s/icon-512.png", "sizes": "512x512", "type": "image/png"}]})


@app.get("/api/push/key")
@admin
def push_key():
    return jsonify({"key": webpush.public_key(), "devices": [
        {"id": x["endpoint"][-12:], "name": x.get("name", ""), "added": x.get("added", "")} for x in load(PUSH, [])]})


@app.post("/api/push/subscribe")
@admin
def push_subscribe():
    d = request.get_json(silent=True) or {}
    sub = d.get("sub") or {}
    ep, keys = str(sub.get("endpoint", "")), sub.get("keys") or {}
    if not ep.startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
        return "Subscrição inválida", 400
    item = {"endpoint": ep, "keys": {"p256dh": str(keys["p256dh"]), "auth": str(keys["auth"])},
            "name": str(d.get("name", ""))[:60], "added": datetime.now().strftime("%Y-%m-%d %H:%M")}
    with lock:
        save(PUSH, [x for x in load(PUSH, []) if x["endpoint"] != ep] + [item])
    return "", 204


@app.post("/api/push/remove")
@admin
def push_remove():
    i = str((request.get_json(silent=True) or {}).get("id", ""))
    with lock:
        save(PUSH, [x for x in load(PUSH, []) if not x["endpoint"].endswith(i) or not i])
    return "", 204


def notify_register(name, ig):
    if notify_cfg().get("comments"):
        push(f"Novo registo: {name}" + (f" (@{ig})" if ig else ""), "Alguém registou-se no site.", ["wave"], request.host_url + "admin#comentarios")


@app.get("/api/notify")
@admin
def get_notify():
    return jsonify(notify_cfg())


@app.post("/api/notify")
@admin
def set_notify():
    d = request.get_json(silent=True) or {}
    with lock:
        c = notify_cfg()
        c.update(visits=bool(d.get("visits")), comments=bool(d.get("comments")),
                 ntfy_on=bool(d.get("ntfy_on", True)), wa_on=bool(d.get("wa_on")))
        if "wa_phone" in d:
            c["wa_phone"] = re.sub(r"[^\d+]", "", str(d["wa_phone"]))[:16]
        if "wa_key" in d:
            c["wa_key"] = re.sub(r"[^\w-]", "", str(d["wa_key"]))[:40]
        if d.get("new_topic"):
            c["topic"] = "site-" + secrets.token_hex(8)
        save(NOTIFY, c)
    return jsonify(c)


@app.post("/api/notify/test-whatsapp")
@admin
def test_whatsapp():
    c = notify_cfg()
    if not (c.get("wa_phone") and c.get("wa_key")):
        return jsonify({"ok": False, "msg": "Falta o número ou a API key."})
    ok, resp = send_whatsapp(c, "Teste do site ✓", "Se estás a ver isto no WhatsApp, está a funcionar.")
    return jsonify({"ok": ok, "msg": resp})


@app.post("/api/notify/test")
@admin
def test_notify():
    push("Teste do site ✓", "Se estás a ver isto, as notificações estão a funcionar.", ["white_check_mark"],
         request.host_url + "admin")
    return "", 204


threading.Thread(target=geo.update_if_old, daemon=True).start()  # base de localização: atualiza 1x/mês


def _warm_translations():  # ao arrancar: põe na fila o que ainda não tem tradução
    site, items, posts, cs = load(SITE, {}), load(ITEMS, []), load(POSTS, []), load(COMMENTS, [])
    translate.warm([site.get("intro")] + [i.get(f) for i in items for f in ITEM_TR]
                   + [p.get(f) for p in posts for f in POST_TR] + [c.get(f) for c in cs for f in COMMENT_TR])


threading.Thread(target=_warm_translations, daemon=True).start()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
