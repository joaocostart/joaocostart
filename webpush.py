"""Notificações push do próprio site (Web Push, RFC 8030/8291/8292), sem serviços de terceiros.

Cada aparelho que ativa as notificações no admin dá-nos uma "subscrição"
(um endereço do sistema de push do browser + chaves). As mensagens são
encriptadas aqui, com as chaves desse aparelho, e assinadas com a nossa
chave VAPID (data/vapid.pem). Só o aparelho consegue ler o conteúdo.
"""
import base64, json, os, struct, time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

KEY_FILE = Path(__file__).parent / "data" / "vapid.pem"


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _raw(pub):
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def vapid_key():
    if not KEY_FILE.exists():
        k = ec.generate_private_key(ec.SECP256R1())
        KEY_FILE.write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                             serialization.NoEncryption()))
        os.chmod(KEY_FILE, 0o600)
    return serialization.load_pem_private_key(KEY_FILE.read_bytes(), None)


def public_key():
    """Chave pública VAPID (base64url) para o browser usar no subscribe()."""
    return b64u(_raw(vapid_key().public_key()))


def _hkdf(salt, ikm, info, n):
    return HKDF(hashes.SHA256(), n, salt, info).derive(ikm)


def _encrypt(payload, p256dh, auth):
    ua_pub = unb64u(p256dh)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub)
    eph = ec.generate_private_key(ec.SECP256R1())
    as_pub = _raw(eph.public_key())
    secret = eph.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf(unb64u(auth), secret, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    salt = os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    body = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + struct.pack(">IB", 4096, len(as_pub)) + as_pub + body


def _jwt(aud, sub):
    head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
    claims = b64u(json.dumps({"aud": aud, "exp": int(time.time()) + 12 * 3600, "sub": sub}).encode())
    msg = f"{head}.{claims}".encode()
    r, s = decode_dss_signature(vapid_key().sign(msg, ec.ECDSA(hashes.SHA256())))
    return f"{head}.{claims}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def send(sub, data, contact):
    """Envia `data` (dict) para uma subscrição. Devolve o código HTTP (201 = ok; 404/410 = já não existe)."""
    ep = sub["endpoint"]
    u = urlparse(ep)
    body = _encrypt(json.dumps(data).encode(), sub["keys"]["p256dh"], sub["keys"]["auth"])
    req = Request(ep, data=body, method="POST", headers={
        "Authorization": f"vapid t={_jwt(f'{u.scheme}://{u.netloc}', contact)}, k={public_key()}",
        "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
        "TTL": "86400", "Urgency": "normal"})
    try:
        with urlopen(req, timeout=15) as r:
            return r.status
    except HTTPError as e:
        return e.code
    except Exception:
        return 0
