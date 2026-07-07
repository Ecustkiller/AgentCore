"""Try model discovery and more model names on Codex backend."""
import json
import urllib.error
import urllib.request
from pathlib import Path

CRED = json.loads(
    (Path(__file__).resolve().parent.parent / "api" / "cpa-to-sub2api-20260707143913.json").read_text()
)
acc = CRED["accounts"][0]["credentials"]
TOKEN = acc["access_token"]
ACCOUNT_ID = acc["account_id"]

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "OpenAI-Beta": "responses=v1",
    "chatgpt-account-id": ACCOUNT_ID,
}

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


def get(url: str) -> None:
    req = urllib.request.Request(url, headers=HEADERS, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"GET {url}: {resp.status}")
            print(resp.read().decode()[:1500])
    except urllib.error.HTTPError as e:
        print(f"GET {url}: {e.code}")
        print(e.read().decode()[:500])


def try_model(model: str) -> str:
    body = json.dumps({"model": model, "input": "say hi", "stream": True}).encode()
    req = urllib.request.Request(
        "https://chatgpt.com/backend-api/codex/responses",
        data=body,
        headers={**HEADERS, "Accept": "text/event-stream"},
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


print("=== Discovery ===")
for p in GET_PATHS:
    get(p)

print("\n=== Model sweep ===")
for m in MODELS:
    print(f"  {m}: {try_model(m)}")
