import logging
from typing import Optional

import boto3

logger = logging.getLogger(__name__)

_cognito_client = None


def _get_cognito():
    global _cognito_client
    if _cognito_client is None:
        _cognito_client = boto3.client("cognito-idp", region_name="us-east-1")
    return _cognito_client


def validate_access_token(access_token: str) -> Optional[dict]:
    """Validates a Cognito access token via GetUser. Returns identity dict or None."""
    try:
        resp = _get_cognito().get_user(AccessToken=access_token)
        attrs = {a["Name"]: a["Value"] for a in resp["UserAttributes"]}
        user_id = attrs.get("sub", "")
        email = attrs.get("email", "")
        name = attrs.get("name") or email.split("@")[0]
        logger.info(f"[auth] token valid — user_id={user_id} email={email}")
        return {"user_id": user_id, "email": email, "display_name": name}
    except Exception as exc:
        logger.warning(f"[auth] token validation failed: {exc}")
        return None
