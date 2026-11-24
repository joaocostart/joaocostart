"""Publicação automática no GitHub Pages.

Quando o admin muda conteúdo (escritas, posts, introdução, foto), espera uns
segundos (para juntar várias alterações seguidas), gera a versão estática
(build_static.py -> docs/) e faz commit + push para o GitHub.

Só funciona com AUTO_PUBLISH=1 e com o git do servidor autorizado a fazer push
(ver LEIAME.txt). O resultado fica em data/publish.log.
"""
import os, subprocess, threading, traceback
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).parent
LOG = BASE / "data" / "publish.log"
DELAY = 20  # segundos

_timer, _lock, _run_lock = None, threading.Lock(), threading.Lock()


def enabled():
    return os.environ.get("AUTO_PUBLISH") == "1"


def schedule(delay=DELAY):
    global _timer
    if not enabled():
        return
    with _lock:
        if _timer:
            _timer.cancel()
        _timer = threading.Timer(delay, run)
        _timer.daemon = True
        _timer.start()


def _log(msg):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")


def _git(*args):
    r = subprocess.run(["git", *args], cwd=BASE, capture_output=True, text=True, timeout=300)
    if r.returncode not in (0, 1):
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()[:500]}")
    return r


def run():
    with _run_lock:
        try:
            import build_static
            build_static.main()
            _git("add", "docs", "data/items.json", "data/posts.json", "data/site.json", "data/uploads")
            if _git("diff", "--cached", "--quiet").returncode == 0:
                _log("nada para publicar")
                return
            _git("commit", "-m", "Publica alterações feitas no admin")
            _git("pull", "--rebase", "origin", "main")
            r = _git("push", "origin", "HEAD:main")
            _log("publicado" if r.returncode == 0 else f"push falhou: {r.stderr.strip()[:300]}")
        except Exception:
            _log("erro: " + traceback.format_exc()[-800:])
