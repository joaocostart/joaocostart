"""Gera o site completo para o GitHub Pages na pasta docs/.

Uso:  python build_static.py
O GitHub Actions corre isto a cada alteração no repositório e publica docs/
(ver .github/workflows/pages.yml). Corre o app.py "a fingir" (sem servidor) e
grava cada página e o conteúdo (introdução, escritas, posts, imagens) como
ficheiros, já com a tradução para inglês.
Os comentários, registos, visitas e notificações vão ao Worker da Cloudflare
(api.joaocostart.com, pasta worker/). O admin fica em joaocostart.com/admin.
"""
import json, os, shutil, sys
from pathlib import Path

DOMAIN = "joaocostart.com"
API = os.environ.get("API_BASE", "https://api.joaocostart.com")
BASE = Path(__file__).parent
OUT = BASE / "docs"

os.environ.setdefault("ADMIN_PASSWORD", "build-estatico")  # o app.py precisa de uma; nada é publicado
os.environ["NO_BACKGROUND"] = "1"  # sem descargas em segundo plano no app.py
sys.path.insert(0, str(BASE))
import app as site  # noqa: E402

HEAD = f"<script>window.API_BASE={json.dumps(API)}</script>\n"


def get(c, path):
    r = c.get(path, base_url=f"https://{DOMAIN}")
    return r.status_code, r.data


def write(rel, data):
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))


def page(c, path):
    status, html = get(c, path)
    html = html.decode("utf-8").replace("</head>", HEAD + "</head>", 1)
    rel = "404.html" if path == "/404" else (path.strip("/") + "/index.html" if path != "/" else "index.html")
    write(rel, html)
    return status


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    c = site.app.test_client()
    items = json.loads(get(c, "/api/items")[1])
    posts = json.loads(get(c, "/api/posts")[1])
    # traduz já tudo para inglês, para o site ter as duas línguas
    s = json.loads(get(c, "/api/site")[1])
    site.translate.now(s.get("intro"), *[i.get(f) for i in items for f in site.ITEM_TR],
                       *[p.get(f) for p in posts for f in site.POST_TR], timeout=300)

    paths = ["/"] + [f"/{s}" for s in site.SITE_SECS] + ["/privacidade", "/teoria"]
    paths += [f'/{i["section"]}/{i["id"]}' for i in items]
    paths += [f'/opinioes/{p["id"]}' for p in posts]
    for p in paths:
        print(page(c, p), p)
    page(c, "/404")  # páginas que não existem

    for api in ("site", "items", "posts"):
        write(f"api/{api}", get(c, f"/api/{api}")[1])
    for f in ("ads.txt", "robots.txt", "sitemap.xml"):
        write(f, get(c, "/" + f)[1])

    # admin: o mesmo admin.html, com o adaptador que grava no GitHub e fala com o Worker
    admin = (BASE / "static" / "admin.html").read_text("utf-8")
    i = admin.index("<script>")  # antes do script do admin
    admin = admin[:i] + HEAD + '<script src="/s/admin-shim.js"></script>\n' + admin[i:]
    write("admin/index.html", admin)
    write("admin.webmanifest", json.dumps({
        "name": "Admin · " + s.get("name", "site"), "short_name": "Admin", "start_url": "/admin/", "scope": "/",
        "display": "standalone", "background_color": "#0f1112", "theme_color": "#0f1112",
        "icons": [{"src": "/s/icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "/s/icon-512.png", "sizes": "512x512", "type": "image/png"}]}, ensure_ascii=False))
    shutil.copy2(BASE / "static" / "sw.js", OUT / "sw.js")  # notificações push do admin

    shutil.copytree(BASE / "static", OUT / "s", ignore=shutil.ignore_patterns("admin.html", "index.html"))
    up = BASE / "data" / "uploads"
    (OUT / "media").mkdir(parents=True, exist_ok=True)
    for f in up.iterdir():
        if f.is_file() and f.suffix.lower() != ".txt":
            shutil.copy2(f, OUT / "media" / f.name)

    write("CNAME", DOMAIN + "\n")
    write(".nojekyll", b"")
    print("pronto:", OUT)


if __name__ == "__main__":
    main()
