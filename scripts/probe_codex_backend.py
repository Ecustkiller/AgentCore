"""Probe Codex backend endpoints for K-12 ChatGPT OAuth token."""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_CRED = _REPO_ROOT / "config" / "codex-credentials.json"


def _cred_path() -> Path:
    override = os.environ.get("CODEX_CREDENTIALS_PATH")
    return Path(override) if override else _DEFAULT_CRED


def load_creds() -> dict:
    path = _cred_path()
    if not path.exists():
        raise FileNotFoundError(
            f"Credentials not found: {path}\n"
            "Place ChatGPT OAuth creds in config/codex-credentials.json "
            "(gitignored), or set CODEX_CREDENTIALS_PATH."
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    if "access_token" in data:
        return {
            "access_token": data["access_token"],
            "session_token": data.get("session_token", ""),
            "account_id": data.get("account_id", ""),
            "email": data.get("email", ""),
        }
    acc = data["accounts"][0]["credentials"]
    return {
        "access_token": acc["access_token"],
        "session_token": acc.get("session_token", ""),
        "account_id": acc["account_id"],
        "email": acc.get("email", ""),
    }


def post(url: str, token: str, body: dict, extra_headers: dict | None = None, label: str = "") -> None:
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
            print(f"\n=== {label}: {resp.status} OK ===")
            print(raw[:1200])
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        print(f"\n=== {label}: {e.code} FAILED ===")
        try:
            print(json.dumps(json.loads(raw), indent=2)[:800])
        except json.JSONDecodeError:
            print(raw[:800])


def main() -> int:
    creds = load_creds()
    token = creds["access_token"]
    session = creds["session_token"]
    print(f"email={creds['email']} account_id={creds['account_id']}")

    codex_headers = {
        "OpenAI-Beta": "responses=v1",
        "chatgpt-account-id": creds["account_id"],
    }

    bodies = [
        {"model": "gpt-4o", "input": "say hi in one word"},
        {"model": "o4-mini", "input": "say hi in one word", "stream": True},
        {"model": "gpt-5-codex", "input": "say hi in one word", "stream": True},
        {"model": "codex-mini", "input": "say hi in one word", "stream": True},
    ]

    endpoints = [
        ("codex/responses", "https://chatgpt.com/backend-api/codex/responses"),
        ("codex/responses + session", "https://chatgpt.com/backend-api/codex/responses"),
        ("v1/responses on chatgpt", "https://chatgpt.com/backend-api/v1/responses"),
    ]

    for name, url in endpoints:
        auth = session if "session" in name else token
        for body in bodies:
            post(url, auth, body, codex_headers, f"{name} / {body['model']}")

    # Try with session cookie style
    if session:
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Cookie": f"__Secure-next-auth.session-token={session}",
            "chatgpt-account-id": creds["account_id"],
            "OpenAI-Beta": "responses=v1",
        }
        req = urllib.request.Request(
            "https://chatgpt.com/backend-api/codex/responses",
            data=json.dumps({"model": "gpt-4o", "input": "say hi", "stream": True}).encode(),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                print(f"\n=== cookie auth: {resp.status} OK ===")
                print(resp.read().decode()[:1200])
        except urllib.error.HTTPError as e:
            print(f"\n=== cookie auth: {e.code} FAILED ===")
            print(e.read().decode()[:800])

    return 0


if __name__ == "__main__":
    sys.exit(main())
