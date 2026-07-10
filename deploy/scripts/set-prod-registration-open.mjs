#!/usr/bin/env node
/**
 * Set REGISTRATION_OPEN on the live production.env and recreate the api container
 * so the env_file is re-read. Usage:
 *   node deploy/scripts/set-prod-registration-open.mjs false
 *   node deploy/scripts/set-prod-registration-open.mjs true
 */
import { loadDeployEnv, sshScript } from "./load-deploy-env.mjs";

loadDeployEnv();

const value = (process.argv[2] ?? "false").trim().toLowerCase();
if (value !== "true" && value !== "false") {
  console.error("usage: set-prod-registration-open.mjs <true|false>");
  process.exit(1);
}

const script = [
  "set -euo pipefail",
  'DEPLOY="/opt/agentcore/repo/deploy_f6d1637"',
  'ENVF="$DEPLOY/config/production.env"',
  `VALUE="${value}"`,
  'if grep -q "^REGISTRATION_OPEN=" "$ENVF" 2>/dev/null; then',
  '  sed -i "s/^REGISTRATION_OPEN=.*/REGISTRATION_OPEN=$VALUE/" "$ENVF"',
  "else",
  '  echo "REGISTRATION_OPEN=$VALUE" >> "$ENVF"',
  "fi",
  'grep "^REGISTRATION_OPEN=" "$ENVF"',
  'COMPOSE=( docker compose -p agentcore -f "$DEPLOY/docker-compose.server.yml" -f "$DEPLOY/docker-compose.app.yml" --env-file "$ENVF" )',
  '"${COMPOSE[@]}" up -d api',
  '"${COMPOSE[@]}" exec -T api sh -c \'echo REGISTRATION_OPEN=$REGISTRATION_OPEN\'',
].join("\n");

sshScript(script);
