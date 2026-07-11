"""Try model discovery and more model names on Codex backend."""
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


def load_creds() -> tuple[str, str]:
    path = _cred_path()
    if not path.exists():
        raise FileNotFoundError(
            f"Credentials not found: {path}\n"
            "Place ChatGPT OAuth creds in config/codex-credentials.json "
            "(gitignored), or set CODEX_CREDENTIALS_PATH."
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    if "access_token" in data:
        return data["access_token"], data.get("account_id", "")
    acc = data["accounts"][0]["credentials"]
    return acc["access_token"], acc["account_id"]


MODELS = [
    "auto",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5-codex-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o-mini",
    "o3-mini",
    "o3",
    "codex-mini-latest",
    "text-davinci-002-render-sha",
]

GET_PATHS = [
    "https://chatgpt.com/backend-api/models",
    "https://chatgpt.com/backend-api/codex/models",
    "https://chatgpt.com/backend-api/accounts/check",
    "https://chatgpt.com/backend-api/me",
]


def get(url: str, headers: dict[str, str]) -> None:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"GET {url}: {resp.status}")
            print(resp.read().decode()[:1500])
    except urllib.error.HTTPError as e:
        print(f"GET {url}: {e.code}")
        print(e.read().decode()[:500])


def try_model(model: str, headers: dict[str, str]) -> str:
    body = json.dumps({"model": model, "input": "say hi", "stream": True}).encode()
    req = urllib.request.Request(
        "https://chatgpt.com/backend-api/codex/responses",
        data=body,
        headers={**headers, "Accept": "text/event-stream"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return f"OK {resp.status}: {raw[:200]}"
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            detail = json.loads(raw).get("detail", raw[:80])
        except json.JSONDecodeError:
            detail = raw[:80]
        return f"FAIL {e.code}: {detail}"


def main() -> int:
    token, account_id = load_creds()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "OpenAI-Beta": "responses=v1",
        "chatgpt-account-id": account_id,
    }

    print("=== Discovery ===")
    for p in GET_PATHS:
        get(p, headers)

    print("\n=== Model sweep ===")
    for m in MODELS:
        print(f"  {m}: {try_model(m, headers)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
