#!/usr/bin/env node
/**
 * Sync production AI logs to local for analysis.
 *
 *   pnpm sync:logs                 # events + slim DB export (redacted turn_journal)
 *   pnpm sync:logs --full          # include raw turn_journal (local deep dig only)
 *   pnpm sync:logs --events-only
 *   pnpm sync:logs --export-only
 *   pnpm sync:logs --days 3        # DB export window (default 7)
 *
 * Prerequisites:
 *   deploy/.env.deploy.local with DEPLOY_SSH_HOST / USER / KEY_PATH (/ PORT)
 *
 * Why Node (not bash wrapper): Windows maintainers often lack working WSL bash;
 * package.json calls this file directly. Deploy credentials live in DEPLOY_SSH_*.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  loadDeployEnv,
  scp,
  scpFrom,
  sshCapture,
  sshScript,
} from "../deploy/scripts/load-deploy-env.mjs";

loadDeployEnv();

const LOCAL_EXPORT_DIR = join(REPO_ROOT, "logs", "prod-export");
const REMOTE_BUNDLE = "/tmp/agentcore-sync-logs.tgz";
const REMOTE_EXPORT_SCRIPT = "/tmp/agentcore-export_conversations.py";
const CONTAINER = "agentcore-api";
const LOCAL_EXPORT_SCRIPT = join(
  REPO_ROOT,
  "apps/server/scripts/export_conversations.py",
);

const args = process.argv.slice(2);
let syncEvents = true;
let syncExport = true;
let fullExport = false;
let days = 7;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case "--events-only":
      syncExport = false;
      break;
    case "--export-only":
      syncEvents = false;
      break;
    case "--full":
      fullExport = true;
      break;
    case "--days": {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`Invalid --days ${raw}`);
        process.exit(1);
      }
      days = n;
      break;
    }
    case "-h":
    case "--help":
      console.log(`Usage: pnpm sync:logs [--events-only | --export-only] [--full] [--days N]

Pull production structured logs into logs/prod-export/ using
deploy/.env.deploy.local (DEPLOY_SSH_*).

  (default)       Slim DB export: redacted turn_journal (no user/LLM bodies)
  --full          Include raw turn_journal (large; local deep dig, not for packs)
  --events-only   Only sync API container stdout JSONL (docker logs)
  --export-only   Only run DB export inside the api container + pull
  --days N        DB export window (default 7)
`);
      process.exit(0);
      break;
    default:
      console.error(`Unknown argument: ${arg}`);
      console.error(
        "Usage: pnpm sync:logs [--events-only | --export-only] [--full] [--days N]",
      );
      process.exit(1);
  }
}

mkdirSync(LOCAL_EXPORT_DIR, { recursive: true });

function extractBundle(localTgz) {
  const tar = spawnSync("tar", ["xzf", localTgz, "-C", LOCAL_EXPORT_DIR], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (tar.status !== 0) {
    console.error(tar.stderr || tar.stdout || "tar extract failed");
    process.exit(tar.status ?? 1);
  }
}

function pullRemoteBundle(label) {
  console.log(`→ ${label}`);
  const localTgz = join(LOCAL_EXPORT_DIR, "_sync-bundle.tgz");
  try {
    scpFrom(REMOTE_BUNDLE, localTgz);
    extractBundle(localTgz);
  } finally {
    if (existsSync(localTgz)) unlinkSync(localTgz);
    sshCapture(`rm -f ${REMOTE_BUNDLE}`, { allowFail: true });
  }
}

function replaceEventsJsonl(extractedName) {
  const extracted = join(LOCAL_EXPORT_DIR, extractedName);
  const eventsMain = join(LOCAL_EXPORT_DIR, "events.jsonl");
  if (!existsSync(extracted)) {
    console.error(`Missing ${extracted} after pull`);
    process.exit(1);
  }
  if (existsSync(eventsMain)) unlinkSync(eventsMain);
  renameSync(extracted, eventsMain);
  // Drop leftover rotations from the old volume-file sync so discover_log_files
  // does not merge stale prod.jsonl.* into the docker-stdout dump.
  for (const name of readdirSync(LOCAL_EXPORT_DIR)) {
    if (name.startsWith("events.jsonl.") || name.startsWith("prod.jsonl")) {
      unlinkSync(join(LOCAL_EXPORT_DIR, name));
    }
  }
}

function syncEventLogs() {
  console.log(`→ pack API stdout JSONL (docker logs --since ${days}d)`);
  sshScript(`set -euo pipefail
CONTAINER="${CONTAINER}"
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "container $CONTAINER not found" >&2
  exit 1
fi
# Container stdio only. Non-JSON banners (uvicorn startup-failed text) dropped.
docker logs --since ${days}d "$CONTAINER" 2>/dev/null | grep -E '^\\{' > /tmp/agentcore-events.jsonl || true
tar czf ${REMOTE_BUNDLE} -C /tmp agentcore-events.jsonl
ls -lh ${REMOTE_BUNDLE}
`);
  pullRemoteBundle("pull event logs");
  replaceEventsJsonl("agentcore-events.jsonl");
}

function discoverHostDataExportDir() {
  const { stdout } = sshCapture(`set -euo pipefail
CONTAINER="${CONTAINER}"
DATA_DIR="$(docker exec "$CONTAINER" printenv DATA_DIR)"
DATA_DIR="\${DATA_DIR:-/data}"
HOST_DATA=""
while IFS='|' read -r dest src; do
  [ -n "\$dest" ] || continue
  if [ "\$dest" = "\$DATA_DIR" ]; then
    HOST_DATA="\$src"
    break
  fi
done <<EOF
$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Destination}}|{{.Source}}{{println}}{{end}}')
EOF
if [ -z "\$HOST_DATA" ]; then
  echo "no mount for DATA_DIR=\$DATA_DIR" >&2
  exit 1
fi
printf '%s\\n' "\$HOST_DATA/export"
`);
  const hostExport = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!hostExport) {
    console.error("could not resolve host export dir");
    process.exit(1);
  }
  return hostExport;
}

function syncDbExport() {
  if (!existsSync(LOCAL_EXPORT_SCRIPT)) {
    console.error(`Missing ${LOCAL_EXPORT_SCRIPT}`);
    process.exit(1);
  }
  // Ship the local script so path fixes apply before the next image deploy
  // (image copy historically assumed monorepo parents[3] → IndexError in Docker).
  const journalFlag = fullExport ? "" : " --journal-redacted";
  console.log(
    fullExport
      ? "→ upload export script + run inside api container (full, raw journal)"
      : "→ upload export script + run inside api container (slim, redacted journal)",
  );
  scp(LOCAL_EXPORT_SCRIPT, REMOTE_EXPORT_SCRIPT);
  const hostExport = discoverHostDataExportDir();
  console.log(`  host export dir: ${hostExport}`);
  sshScript(`set -euo pipefail
CONTAINER="${CONTAINER}"
docker cp ${REMOTE_EXPORT_SCRIPT} "$CONTAINER":/tmp/export_conversations.py
docker exec -u root "$CONTAINER" chown app:app /tmp/export_conversations.py || true
docker exec "$CONTAINER" python /tmp/export_conversations.py --days ${days} --output /data/export${journalFlag}
rm -f ${REMOTE_EXPORT_SCRIPT}
mkdir -p "${hostExport}"
cd "${hostExport}"
if ls conversations.jsonl >/dev/null 2>&1; then
  tar czf ${REMOTE_BUNDLE} conversations.jsonl messages.jsonl cost_events.jsonl turn_metrics.jsonl turn_journal.jsonl
else
  tar czf ${REMOTE_BUNDLE} .
fi
ls -lh ${REMOTE_BUNDLE}
`);
  pullRemoteBundle("pull DB export");
}

if (syncEvents) syncEventLogs();
if (syncExport) syncDbExport();

console.log(`
Done → ${LOCAL_EXPORT_DIR}

Analyze with:
  cd apps/server
  uv run python scripts/log_stats.py --file ../../logs/prod-export/events.jsonl
  uv run python scripts/log_timeline.py --export-dir ../../logs/prod-export --recent
  uv run python scripts/log_timeline.py --export-dir ../../logs/prod-export <conv_id>
`);
