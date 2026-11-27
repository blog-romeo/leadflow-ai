"""Authentication between the Netlify gateway and this service.

Every /v1 request carries an HMAC-SHA256 signature computed with DEMAND_HUNTER_SERVICE_SECRET over:

    timestamp \\n nonce \\n METHOD \\n path?query \\n organization_id \\n user_id \\n sha256(body)

The organization and the user are part of the signature: they cannot be changed in transit, and the service
never accepts an organization from the body. A nonce is accepted once within the time window (replay protection).
Browsers never talk to this service directly: only the gateway has the secret.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import threading
import time

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,80}$")


class AuthError(Exception):
    def __init__(self, code: str, status: int = 401):
        super().__init__(code)
        self.code, self.status = code, status


def canonical(ts: str, nonce: str, method: str, path: str, org: str, user: str, body: bytes) -> bytes:
    return "\n".join([ts, nonce, method.upper(), path, org, user, hashlib.sha256(body).hexdigest()]).encode()


def sign(secret: str, ts: str, nonce: str, method: str, path: str, org: str, user: str, body: bytes) -> str:
    return hmac.new(secret.encode(), canonical(ts, nonce, method, path, org, user, body), hashlib.sha256).hexdigest()


class NonceCache:
    def __init__(self):
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    def use(self, nonce: str, ttl: float, now: float) -> bool:
        with self._lock:
            for k, exp in list(self._seen.items()):
                if exp < now:
                    del self._seen[k]
            if nonce in self._seen:
                return False
            self._seen[nonce] = now + ttl
            return True


def verify(secret: str, headers, method: str, path: str, body: bytes, nonces: NonceCache, window_s: int,
           now: float | None = None) -> tuple[str, str]:
    """Returns (organization_id, user_id) or raises AuthError. Same error for every failure: no oracle."""
    if not secret or len(secret) < 32:
        raise AuthError("service_not_configured", 503)
    now = time.time() if now is None else now
    ts = headers.get("x-dh-timestamp", "")
    nonce = headers.get("x-dh-nonce", "")
    org = headers.get("x-dh-org", "")
    user = headers.get("x-dh-user", "")
    sig = headers.get("x-dh-signature", "")
    if not (ts.isdigit() and NONCE_RE.match(nonce) and UUID_RE.match(org) and UUID_RE.match(user) and sig):
        raise AuthError("unauthorized")
    if abs(now - int(ts)) > window_s:
        raise AuthError("unauthorized")
    expected = sign(secret, ts, nonce, method, path, org, user, body)
    if not hmac.compare_digest(expected, sig):
        raise AuthError("unauthorized")
    if not nonces.use(nonce, window_s * 2, now):
        raise AuthError("replayed_request", 409)
    return org.lower(), user.lower()
