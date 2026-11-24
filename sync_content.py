"""Copia para o repositório o que foi publicado no admin (guardado no Worker da Cloudflare).

Corre no GitHub Actions de 5 em 5 minutos (.github/workflows/pages.yml).
Escreve data/site.json, data/items.json, data/posts.json e os ficheiros novos em
data/uploads/, e apaga os que o admin apagou. Imprime "changed=true" se mudou algo.
Não precisa de nenhuma password: só lê o que o site já mostra publicamente.
"""
import json, os, sys
from pathlib import Path
from urllib.request import Request, urlopen

API = os.environ.get("API_BASE", "https://api.joaocostart.com")
BASE = Path(__file__).parent
DATA = BASE / "data"
UP = DATA / "uploads"
UA = {"User-Agent": "site-sync"}


def get(path):
    with urlopen(Request(API + path, headers=UA), timeout=120) as r:
        return r.read()


def main():
    ex = json.loads(get("/api/export"))
    if not ex.get("version") or ex.get("items") is None:
        print("o Worker ainda não tem conteúdo — nada a fazer")
        return False
    changed = False
    UP.mkdir(parents=True, exist_ok=True)
    for x in ex.get("media_new") or []:  # ficheiros novos
        f = UP / x["name"]
        if not f.exists():
            f.write_bytes(get(f"/api/media/{x['name']}"))
            print("novo:", x["name"])
            changed = True
    for x in ex.get("media_deleted") or []:  # ficheiros apagados no admin
        f = UP / x["name"]
        if f.exists():
            f.unlink()
            print("apagado:", x["name"])
            changed = True
    for name in ("site", "items", "posts"):
        if ex.get(name) is None:
            continue
        p = DATA / f"{name}.json"
        new = json.dumps(ex[name], ensure_ascii=False, indent=1)
        if not p.exists() or p.read_text("utf-8") != new:
            p.write_text(new, "utf-8")
            print("atualizado:", p.name)
            changed = True
    return changed


if __name__ == "__main__":
    ch = main()
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"changed={'true' if ch else 'false'}\n")
    print("changed=" + ("true" if ch else "false"))
