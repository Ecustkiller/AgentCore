#!/usr/bin/env node
/**
 * Skip image build; re-run finish-server.sh.
 *
 *   node deploy/scripts/resume-finish.mjs <short-sha>
 *
 * Use after cutover failed with the image already on the machine. Does not
 * rebuild or push. (Not a log-permission workaround — production is stdout-only.)
 *
 * The remote body is written to a tempfile first: `docker compose run` attaches
 * stdin by default, which would otherwise swallow the rest of `ssh bash -s`.
 */
import { loadDeployEnv, sshScript } from "./load-deploy-env.mjs";

loadDeployEnv();

const sha = process.argv[2]?.trim();
if (!sha) {
  console.error("usage: node deploy/scripts/resume-finish.mjs <short-sha>");
  process.exit(1);
}
if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) {
  console.error(`ERROR: invalid SHA '${sha}' (expected 7–40 hex chars)`);
  process.exit(1);
}

const deployDir = process.env.AGENTCORE_DEPLOY_DIR?.trim() || "";
const deployDirExport = deployDir
  ? `export AGENTCORE_DEPLOY_DIR=${JSON.stringify(deployDir)}\n`
  : "";

const script = `set -euo pipefail
${deployDirExport}cat > /tmp/agentcore-resume-finish.sh << 'EOS'
set -euo pipefail
HOME_DIR="\${AGENTCORE_HOME:-/opt/agentcore}"
SHA="\$1"
echo "==> resume finish-server (skip second workspace snapshot; already taken this window)"
export SKIP_WORKSPACE_SNAPSHOT=1
bash "\$HOME_DIR/repo/deploy/scripts/finish-server.sh" "\$SHA"
EOS
bash /tmp/agentcore-resume-finish.sh ${JSON.stringify(sha)}
`;

console.log(`→ resume finish-server api:${sha} (no rebuild)`);
if (deployDir) console.log(`→ AGENTCORE_DEPLOY_DIR=${deployDir}`);
sshScript(script);
