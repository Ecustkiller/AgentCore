#!/usr/bin/env node
import { loadDeployEnv, sshScript } from "./load-deploy-env.mjs";

loadDeployEnv();

const script = [
  'ENVF="/opt/agentcore/repo/deploy_f6d1637/config/production.env"',
  'if grep -q "^ADMIN_MFA_REQUIRED=" "$ENVF" 2>/dev/null; then',
  '  sed -i "s/^ADMIN_MFA_REQUIRED=.*/ADMIN_MFA_REQUIRED=false/" "$ENVF"',
  "else",
  '  echo "ADMIN_MFA_REQUIRED=false" >> "$ENVF"',
  "fi",
  'grep "^ADMIN_MFA_REQUIRED=" "$ENVF"',
].join("\n");

sshScript(script);
