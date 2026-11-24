"""Gera a versão estática do site (para o GitHub Pages) na pasta docs/.

Uso:  python build_static.py
Corre o app.py "a fingir" (sem servidor) e grava cada página e cada resposta
da API como ficheiro. Sem admin, comentários, login, estatísticas nem
notificações — isso só funciona com o servidor (app.py) a correr.
Volta a correr sempre que mudares data/ ou static/, e faz commit da pasta docs/.
"""
import json, os, shutil, sys
from pathlib import Path

DOMAIN = "joaocostart.com"
BASE = Path(__file__).parent
OUT = BASE / "docs"

os.environ.setdefault("ADMIN_PASSWORD", "build-estatico")  # o app.py precisa de uma; nada é publicado
sys.path.insert(0, str(BASE))
import app as site  # noqa: E402

STATIC_CSS = ("<style>/* versão estática: sem comentários nem login */"
              ".cform,.nocm{display:none!important}</style>\n")


def get(c, path):
    r = c.get(path, base_url=f"https://{DOMAIN}")
    return r.status_code, r.data


def write(rel, data):
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)


def page(c, path):
    status, html = get(c, path)
    html = html.decode("utf-8").replace("</head>", STATIC_CSS + "</head>", 1)
    rel = "404.html" if path == "/404" else (path.strip("/") + "/index.html" if path != "/" else "index.html")
    write(rel, html.encode("utf-8"))
    return status


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    c = site.app.test_client()
    items = json.loads(get(c, "/api/items")[1])
    posts = json.loads(get(c, "/api/posts")[1])
    # traduz já tudo para inglês, para a versão estática ter as duas línguas
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
    write("api/comments", b"[]")
    for f in ("ads.txt", "robots.txt", "sitemap.xml"):
        write(f, get(c, "/" + f)[1])

    shutil.copytree(BASE / "static", OUT / "s", ignore=shutil.ignore_patterns("admin.html", "index.html"))
    up = BASE / "data" / "uploads"
    (OUT / "media").mkdir(parents=True, exist_ok=True)
    for f in up.iterdir():
        if f.is_file() and f.suffix.lower() != ".txt":
            shutil.copy2(f, OUT / "media" / f.name)

    write("CNAME", (DOMAIN + "\n").encode())
    write(".nojekyll", b"")
    print("pronto:", OUT)


if __name__ == "__main__":
    main()
