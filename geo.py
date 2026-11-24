"""Localização aproximada (cidade, país) de um IP, sem enviar nada para fora.

Lê o ficheiro data/geo/dbip.mmdb (DB-IP "IP to City Lite", CC BY 4.0,
https://db-ip.com) com um leitor mínimo do formato MaxMind DB.
"""
import gzip, ipaddress, mmap, shutil, struct, threading, urllib.request
from datetime import date
from functools import lru_cache
from pathlib import Path

GEO_DIR = Path(__file__).parent / "data" / "geo"
DB = GEO_DIR / "dbip.mmdb"        # cidade / país
ASN = GEO_DIR / "asn.mmdb"        # operador de internet
_reader, _asn, _lock = None, None, threading.Lock()


class _Reader:
    def __init__(self, path):
        f = open(path, "rb")
        self.buf = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        start = self.buf.rfind(b"\xab\xcd\xefMaxMind.com")
        if start < 0:
            raise ValueError("ficheiro mmdb inválido")
        self.meta, _ = self._decode(start + 14, start + 14)
        self.nodes = self.meta["node_count"]
        self.rec = self.meta["record_size"]
        self.tree = self.rec * 2 // 8 * self.nodes
        self.data = self.tree + 16
        self.v4start = 0
        if self.meta["ip_version"] == 6:  # IPv4 fica em ::/96
            n = 0
            for _ in range(96):
                if n >= self.nodes:
                    break
                n = self._read_node(n, 0)
            self.v4start = n

    def _read_node(self, n, bit):
        b, r = self.buf, self.rec
        if r == 24:
            o = n * 6 + bit * 3
            return int.from_bytes(b[o:o + 3], "big")
        if r == 28:
            o = n * 7
            if bit == 0:
                return ((b[o + 3] & 0xF0) << 20) | int.from_bytes(b[o:o + 3], "big")
            return ((b[o + 3] & 0x0F) << 24) | int.from_bytes(b[o + 4:o + 7], "big")
        o = n * 8 + bit * 4
        return int.from_bytes(b[o:o + 4], "big")

    def _decode(self, off, base):
        b = self.buf
        ctrl = b[off]; off += 1
        t = ctrl >> 5
        if t == 1:  # ponteiro
            s, v = (ctrl >> 3) & 3, ctrl & 7
            if s == 0:
                p = (v << 8) | b[off]; off += 1
            elif s == 1:
                p = ((v << 16) | int.from_bytes(b[off:off + 2], "big")) + 2048; off += 2
            elif s == 2:
                p = ((v << 24) | int.from_bytes(b[off:off + 3], "big")) + 526336; off += 3
            else:
                p = int.from_bytes(b[off:off + 4], "big"); off += 4
            val, _ = self._decode(base + p, base)
            return val, off
        if t == 0:
            t = 7 + b[off]; off += 1
        size = ctrl & 0x1F
        if size >= 29:
            n = size - 28
            extra = int.from_bytes(b[off:off + n], "big"); off += n
            size = (29, 285, 65821)[n - 1] + extra
        if t == 2:
            return b[off:off + size].decode("utf-8", "replace"), off + size
        if t == 7:
            d = {}
            for _ in range(size):
                k, off = self._decode(off, base)
                d[k], off = self._decode(off, base)
            return d, off
        if t == 11:
            a = []
            for _ in range(size):
                v, off = self._decode(off, base)
                a.append(v)
            return a, off
        if t in (5, 6, 9, 10):
            return int.from_bytes(b[off:off + size], "big"), off + size
        if t == 8:
            return int.from_bytes(b[off:off + size].rjust(4, b"\0"), "big", signed=True), off + size
        if t == 3:
            return struct.unpack(">d", b[off:off + 8])[0], off + 8
        if t == 15:
            return struct.unpack(">f", b[off:off + 4])[0], off + 4
        if t == 14:
            return bool(size), off
        return bytes(b[off:off + size]), off + size

    def lookup(self, ip):
        ip = ipaddress.ip_address(ip)
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        bits = ip.max_prefixlen
        n = self.v4start if ip.version == 4 else 0
        val = int(ip)
        for i in range(bits):
            if n >= self.nodes:
                break
            n = self._read_node(n, (val >> (bits - 1 - i)) & 1)
        if n <= self.nodes:
            return None
        return self._decode(self.data + (n - self.nodes - 16), self.data)[0]


def _get():
    global _reader
    if _reader is None and DB.exists():
        with _lock:
            if _reader is None:
                _reader = _Reader(DB)
    return _reader


def _get_asn():
    global _asn
    if _asn is None and ASN.exists():
        with _lock:
            if _asn is None:
                _asn = _Reader(ASN)
    return _asn


_ISP = [("MEO", "MEO"), ("NOS ", "NOS"), ("NOS,", "NOS"), ("VODAFONE", "Vodafone"), ("NOWO", "NOWO"), ("DIGI", "Digi"),
        ("ORANGE", "Orange"), ("MOVISTAR", "Movistar"), ("TELEFONICA", "Movistar"), ("GOOGLE", "Google"),
        ("AMAZON", "Amazon"), ("MICROSOFT", "Microsoft"), ("CLOUDFLARE", "Cloudflare"), ("APPLE", "Apple (iCloud Relay)")]


@lru_cache(maxsize=4096)
def isp(ip):
    """Operador de internet (ex.: 'MEO', 'NOS', 'Vodafone') ou ''."""
    try:
        if ipaddress.ip_address(ip).is_private:
            return ""
        r = _get_asn()
        org = ((r.lookup(ip) if r else None) or {}).get("autonomous_system_organization", "")
    except Exception:
        return ""
    up = org.upper() + " "
    for k, v in _ISP:
        if k in up:
            return v
    return org.split(" - ")[0].split(",")[0].strip()[:40]


def _name(d):
    n = (d or {}).get("names", {})
    return n.get("pt-BR") or n.get("en") or ""


@lru_cache(maxsize=4096)
def locate(ip):
    """'Cidade, País' (ou '' se não souber / IP privado)."""
    try:
        if ipaddress.ip_address(ip).is_private:
            return "rede local"
        r = _get()
        rec = r.lookup(ip) if r else None
    except Exception:
        return ""
    if not rec:
        return ""
    return ", ".join(x for x in (_name(rec.get("city")), _name(rec.get("country"))) if x)


def update_if_old(days=40):
    """Descarrega as versões mais recentes (a DB-IP publica uma por mês). Corre em segundo plano."""
    _update("dbip-city-lite", DB, "version.txt", days)
    _update("dbip-asn-lite", ASN, "asn-version.txt", days)


def _update(name, dest, verfile, days):
    global _reader, _asn
    ver = GEO_DIR / verfile
    try:
        cur = ver.read_text().strip()
    except OSError:
        cur = ""
    today = date.today()
    want = f"{today:%Y-%m}"
    if cur == want or (dest.exists() and (today - date.fromtimestamp(dest.stat().st_mtime)).days < days):
        return
    GEO_DIR.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".download")
    try:
        url = f"https://download.db-ip.com/free/{name}-{want}.mmdb.gz"
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=120) as r, \
                gzip.GzipFile(fileobj=r) as g, open(tmp, "wb") as out:
            shutil.copyfileobj(g, out)
        _Reader(tmp)  # confirma que o ficheiro é válido antes de o usar
        with _lock:
            tmp.replace(dest)
            _reader = _asn = None
        ver.write_text(want)
        locate.cache_clear()
        isp.cache_clear()
    except Exception:
        tmp.unlink(missing_ok=True)
