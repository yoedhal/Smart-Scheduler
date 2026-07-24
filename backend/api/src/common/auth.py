import logging
import time
from typing import Optional

import boto3

logger = logging.getLogger(__name__)

_cognito_client = None

# --- Token validation cache -------------------------------------------------
# validate_access_token() used to call Cognito's GetUser on EVERY API request.
# Since the whole frontend tunnels through the single /api/proxy endpoint, that
# put a Cognito network round-trip in front of every single call. We memoize the
# token -> identity result in module scope (survives across warm Lambda
# invocations) for a short TTL.
#
# Tradeoff: a token that is revoked — or that expires — stays accepted until its
# cache entry lapses (up to _TOKEN_CACHE_TTL_SECONDS). Cognito access tokens are
# short-lived, so keeping the TTL small bounds that staleness window acceptably.
_TOKEN_CACHE_TTL_SECONDS = 300
_TOKEN_CACHE_MAX_ENTRIES = 1000
_token_cache: dict = {}  # access_token -> (expires_at_epoch, identity)


def _get_cognito():
    global _cognito_client
    if _cognito_client is None:
        _cognito_client = boto3.client("cognito-idp", region_name="us-east-1")
    return _cognito_client


def validate_access_token(access_token: str) -> Optional[dict]:
    """Validates a Cognito access token. Returns identity dict or None.

    Serves a cached identity when one is present and unexpired; otherwise
    validates via Cognito GetUser and caches the result for a short TTL.
    """
    now = time.time()
    cached = _token_cache.get(access_token)
    if cached and cached[0] > now:
        return dict(cached[1])  # copy so callers can't mutate the cached identity

    try:
        resp = _get_cognito().get_user(AccessToken=access_token)
        attrs = {a["Name"]: a["Value"] for a in resp["UserAttributes"]}
        user_id = attrs.get("sub", "")
        email = attrs.get("email", "")
        name = attrs.get("name") or email.split("@")[0]
        identity = {"user_id": user_id, "email": email, "display_name": name}

        # Bound cache size cheaply: on overflow drop expired entries, then clear
        # entirely if still full (rare — tokens are per-user, containers short-lived).
        if len(_token_cache) >= _TOKEN_CACHE_MAX_ENTRIES:
            for t in [t for t, (exp, _) in _token_cache.items() if exp <= now]:
                _token_cache.pop(t, None)
            if len(_token_cache) >= _TOKEN_CACHE_MAX_ENTRIES:
                _token_cache.clear()
        _token_cache[access_token] = (now + _TOKEN_CACHE_TTL_SECONDS, identity)

        logger.info(f"[auth] token valid — user_id={user_id} email={email}")
        return identity
    except Exception as exc:
        _token_cache.pop(access_token, None)  # never serve a now-rejected token
        logger.warning(f"[auth] token validation failed: {exc}")
        return None
