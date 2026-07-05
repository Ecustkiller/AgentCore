#!/usr/bin/env node
import { loadDeployEnv, sshScript } from "./load-deploy-env.mjs";

loadDeployEnv();

const script = [
  "set -euo pipefail",
  'DEPLOY="/opt/agentcore/repo/deploy_f6d1637"',
  'ENVF="$DEPLOY/config/production.env"',
  'COMPOSE=( docker compose -p agentcore -f "$DEPLOY/docker-compose.server.yml" -f "$DEPLOY/docker-compose.app.yml" --env-file "$ENVF" )',
  "",
  'echo "== current admin accounts =="',
  '"${COMPOSE[@]}" exec -T postgres psql -U agentcore -d agentcore -c "SELECT user_id, username, role, status FROM users WHERE role=\'admin\' AND deleted_at IS NULL ORDER BY username;"',
  "",
  'echo "== revoke admin refresh sessions =="',
  '"${COMPOSE[@]}" exec -T postgres psql -U agentcore -d agentcore -c "UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id IN (SELECT user_id FROM users WHERE role=\'admin\' AND deleted_at IS NULL) AND revoked_at IS NULL;"',
  "",
  'echo "== admin_mfa enrollment status =="',
  '"${COMPOSE[@]}" exec -T postgres psql -U agentcore -d agentcore -c "SELECT u.username, (m.enabled_at IS NOT NULL) AS mfa_enrolled FROM users u LEFT JOIN admin_mfa m ON m.user_id=u.user_id WHERE u.role=\'admin\' AND u.deleted_at IS NULL ORDER BY u.username;"',
  "",
  'if grep -q "^ENCRYPTION_KEY=" "$ENVF" 2>/dev/null; then',
  '  echo "ENCRYPTION_KEY: set in production.env (MFA can enroll)"',
  "else",
  '  echo "WARN: ENCRYPTION_KEY missing in production.env — MFA setup will fail"',
  "fi",
  'echo "MIGRATION DONE"',
].join("\n");

sshScript(script);
