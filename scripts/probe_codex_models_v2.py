"""Quick model test with proper Codex request format."""
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


def main() -> int:
    token, aid = load_creds()
    for model in ["gpt-5.4", "gpt-5.5", "gpt-4o", "gpt-5.2", "o4-mini"]:
        body = {
            "model": model,
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "say hi in one word"}],
                }
            ],
            "stream": True,
            "store": False,
            "instructions": "You are helpful.",
        }
        req = urllib.request.Request(
            "https://chatgpt.com/backend-api/codex/responses",
            data=json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                "ChatGPT-Account-ID": aid,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode()
                print(f"{model}: OK {raw[:100]}")
        except urllib.error.HTTPError as e:
            detail = json.loads(e.read().decode()).get("detail", "?")
            print(f"{model}: FAIL {e.code} {detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
