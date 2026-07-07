#!/usr/bin/env node
/**
 * Recover hung deploy: remove stuck `compose run` migration containers,
 * stop live api (avoids migration lock), then finish-server.
 *
 *   node deploy/scripts/recover-finish-deploy.mjs <short-sha>
 */
import { loadDeployEnv, sshScript } from "./load-deploy-env.mjs";

loadDeployEnv();

const sha = process.argv[2]?.trim();
if (!sha) {
  console.error("usage: node deploy/scripts/recover-finish-deploy.mjs <short-sha>");
  process.exit(1);
}

const script = `set -euo pipefail
echo "==> cleanup stuck migration containers"
docker rm -f $(docker ps -q --filter name=agentcore-api-run) 2>/dev/null || true
DEPLOY="\${AGENTCORE_DEPLOY_DIR:-/opt/agentcore/repo/deploy_f6d1637}"
ENVF="$DEPLOY/config/production.env"
COMPOSE=( docker compose -p agentcore -f "$DEPLOY/docker-compose.server.yml" -f "$DEPLOY/docker-compose.app.yml" --env-file "$ENVF" )
echo "==> stop api before migrate"
"\${COMPOSE[@]}" stop api || true
echo "==> finish-server ${sha}"
bash "\${AGENTCORE_HOME:-/opt/agentcore}/repo/deploy/scripts/finish-server.sh" "${sha}"
`;

console.log(`→ recover + finish api:${sha}`);
sshScript(script);
