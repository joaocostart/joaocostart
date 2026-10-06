import os, json, uuid, hmac, threading
from functools import wraps
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory, Response

BASE = Path(__file__).parent
DATA = BASE / "data"
UP = DATA / "uploads"
UP.mkdir(parents=True, exist_ok=True)
ITEMS, SITE = DATA / "items.json", DATA / "site.json"
PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
SECTIONS = {"musica", "escrita", "podcast"}
KINDS = {**{e: "image" for e in "jpg jpeg png webp gif".split()},
         **{e: "video" for e in "mp4 webm m4v".split()},
         **{e: "audio" for e in "mp3 m4a ogg wav".split()}}
lock = threading.Lock()
app = Flask(__name__, static_folder="static", static_url_path="/s")
app.config["MAX_CONTENT_LENGTH"] = 3 * 1024**3  # 3 GB por ficheiro


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


@app.get("/")
def home():
    return app.send_static_file("index.html")


@app.get("/admin")
@admin
def admin_page():
    return app.send_static_file("admin.html")


@app.get("/media/<name>")
def media(name):
    return send_from_directory(UP, name, conditional=True, max_age=31536000)


@app.get("/api/site")
def get_site():
    return jsonify({"name": "O teu nome", "intro": "Escreve aqui a tua introdução, em /admin.",
                    **load(SITE, {})})


@app.post("/api/site")
@admin
def set_site():
    d = request.get_json(force=True)
    with lock:
        s = load(SITE, {})
        s.update(name=str(d.get("name", ""))[:80], intro=str(d.get("intro", ""))[:3000],
                 intro_en=str(d.get("intro_en", ""))[:3000])
        save(SITE, s)
    return "", 204


@app.get("/api/items")
def get_items():
    s = request.args.get("s")
    return jsonify([i for i in load(ITEMS, []) if i["section"] == s])


@app.post("/api/items")
@admin
def add_item():
    f = request.files.get("file")
    sec = request.form.get("section")
    title = request.form.get("title", "").strip()[:120]
    title_en = request.form.get("title_en", "").strip()[:120]
    ext = f.filename.rsplit(".", 1)[-1].lower() if f and "." in f.filename else ""
    if sec not in SECTIONS or ext not in KINDS:
        return "Secção ou formato inválido", 400
    name = uuid.uuid4().hex + "." + ext
    f.save(UP / name)
    item = {"id": uuid.uuid4().hex[:8], "section": sec, "title": title, "title_en": title_en,
            "file": name, "kind": KINDS[ext]}
    with lock:
        items = load(ITEMS, [])
        items.insert(0, item)
        save(ITEMS, items)
    return jsonify(item)


@app.delete("/api/items/<iid>")
@admin
def del_item(iid):
    with lock:
        items = load(ITEMS, [])
        gone = [i for i in items if i["id"] == iid]
        save(ITEMS, [i for i in items if i["id"] != iid])
    for i in gone:
        (UP / i["file"]).unlink(missing_ok=True)
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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)