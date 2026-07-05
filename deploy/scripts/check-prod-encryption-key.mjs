#!/usr/bin/env node
import { loadDeployEnv, sshScript } from "./load-deploy-env.mjs";

loadDeployEnv();
sshScript([
  'DEPLOY="/opt/agentcore/repo/deploy_f6d1637"',
  'ENVF="$DEPLOY/config/production.env"',
  'echo "=== /opt/agentcore/.env ==="',
  'grep -E "^(ENCRYPTION_KEY|billing_mode)=" /opt/agentcore/.env 2>/dev/null | sed "s/=.*/=***redacted***/" || echo "(missing or no match)"',
  'echo "=== production.env ==="',
  'grep -E "^(ENCRYPTION_KEY|billing_mode)=" "$ENVF" 2>/dev/null | sed "s/=.*/=***redacted***/" || echo "(missing or no match)"',
  'echo "=== api container env ==="',
  'COMPOSE=( docker compose -p agentcore -f "$DEPLOY/docker-compose.server.yml" -f "$DEPLOY/docker-compose.app.yml" --env-file "$ENVF" )',
  '"${COMPOSE[@]}" exec -T api sh -c \'echo billing_mode=$BILLING_MODE; if [ -n "$ENCRYPTION_KEY" ]; then echo ENCRYPTION_KEY=set; else echo ENCRYPTION_KEY=empty; fi\'',
].join("\n"));
