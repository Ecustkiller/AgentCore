#!/usr/bin/env node
import { loadDeployEnv, sshScript } from "./load-deploy-env.mjs";

loadDeployEnv();
sshScript(
  'DEPLOY="/opt/agentcore/repo/deploy_f6d1637"; ENVF="$DEPLOY/config/production.env"; COMPOSE=( docker compose -p agentcore -f "$DEPLOY/docker-compose.server.yml" -f "$DEPLOY/docker-compose.app.yml" --env-file "$ENVF" ); "${COMPOSE[@]}" exec -T postgres psql -U agentcore -d agentcore -c "SELECT (SELECT COUNT(*) FROM refresh_tokens rt JOIN users u ON u.user_id=rt.user_id WHERE u.role=\'admin\' AND rt.revoked_at IS NULL) AS active_admin_sessions, (SELECT COUNT(*) FROM admin_mfa m JOIN users u ON u.user_id=m.user_id WHERE u.role=\'admin\' AND m.enabled_at IS NOT NULL) AS mfa_enrolled_count;"',
);
