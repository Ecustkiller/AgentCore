"""Query available Codex models for the configured account."""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_CRED = Path(__file__).resolve().parent.parent / "api" / "codex-credentials.json"


def load_token(cred_path: Path) -> tuple[str, str]:
    data = json.loads(cred_path.read_text(encoding="utf-8"))
    if "access_token" in data:
        return data["access_token"], data.get("account_id", "")
    creds = data["accounts"][0]["credentials"]
    return creds["access_token"], creds["account_id"]


def main() -> int:
    cred_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CRED
    token, account_id = load_token(cred_path)
    headers = {
        "Authorization": f"Bearer {token}",
        "chatgpt-account-id": account_id,
    }
    for ver in ("0.114.0", "0.1.0", "1.0.0"):
        url = f"https://chatgpt.com/backend-api/codex/models?client_version={ver}"
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                print(f"\n=== client_version={ver} OK ===")
                print(resp.read().decode()[:2000])
        except urllib.error.HTTPError as e:
            print(f"\n=== client_version={ver} {e.code} ===")
            print(e.read().decode()[:500])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
