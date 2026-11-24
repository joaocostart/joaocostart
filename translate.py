"""Tradução automática PT -> EN do conteúdo do site.

As traduções ficam guardadas em data/translations.json ({texto original: tradução}),
por isso cada texto só é traduzido uma vez. O que não está traduzido vai para uma
fila que é tratada em segundo plano; a versão inglesa escrita à mão (campos *_en)
tem sempre prioridade — isso é decidido no browser.

NOTA: reconstruído a partir do app.py e das conversas no Raspberry Pi
(o ficheiro original não foi recuperado, só o final, que se manteve igual).
"""
import json, time, threading, queue
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

FILE = Path(__file__).parent / "data" / "translations.json"
URL = "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=pt&tl=en"
MAX = 4000  # caracteres por pedido

_lock = threading.Lock()
_cache = None
_q = queue.Queue()
_pending = set()


def _load():
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save():
    FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_cache, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(FILE)


def _flatten(d):
    """A resposta vem como lista de strings ou de listas [tradução, língua]."""
    if isinstance(d, str):
        return d
    if isinstance(d, list) and d:
        return "".join(_flatten(x[0] if isinstance(x, list) else x) for x in d)
    return ""


def _request(text):
    data = urlencode({"q": text}).encode()
    with urlopen(Request(URL, data=data, headers={"User-Agent": "Mozilla/5.0"}), timeout=20) as r:
        return _flatten(json.loads(r.read().decode("utf-8")))


def _chunks(text):
    """Divide textos grandes pelas quebras de linha, para não passar o limite do serviço."""
    out, cur = [], ""
    for line in text.split("\n"):
        while len(line) > MAX:
            out.append(line[:MAX]); line = line[MAX:]
        if cur and len(cur) + len(line) + 1 > MAX:
            out.append(cur); cur = line
        else:
            cur = f"{cur}\n{line}" if cur else line
    out.append(cur)
    return out


def _translate_now(text):
    """Traduz já (se ainda não estiver) e guarda. Devolve a tradução ou None."""
    with _lock:
        hit = _load().get(text)
    if hit:
        return hit
    try:
        tr = "\n".join(_request(c) if c.strip() else c for c in _chunks(text))
    except Exception:
        return None
    if not tr.strip():
        return None
    with _lock:
        _load()[text] = tr
        _save()
    return tr


def _worker():
    while True:
        t = _q.get()
        try:
            _translate_now(t)
        finally:
            with _lock:
                _pending.discard(t)
        time.sleep(0.5)  # não abusar do serviço


threading.Thread(target=_worker, daemon=True).start()


def en(text):
    """Tradução guardada; se ainda não houver, põe na fila e devolve None."""
    if not isinstance(text, str) or not text.strip():
        return None
    with _lock:
        hit = _load().get(text)
        if hit:
            return hit
        if text not in _pending:
            _pending.add(text)
            _q.put(text)
    return None


def add(obj, fields):
    """Cópia de obj com os campos <campo>_tr (tradução automática) quando já existem."""
    obj = dict(obj)
    for k in fields:
        tr = en(obj.get(k))
        if tr:
            obj[k + "_tr"] = tr
    return obj


def now(*texts, timeout=8):
    """Traduz logo os textos acabados de guardar (até `timeout` segundos)."""
    end = time.time() + timeout
    for t in texts:
        if time.time() > end:
            break
        if isinstance(t, str) and t.strip():
            _translate_now(t)


def warm(texts):
    """Põe na fila tudo o que ainda não está traduzido."""
    for t in texts:
        if isinstance(t, str):
            en(t)
