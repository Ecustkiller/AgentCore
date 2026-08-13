#!/usr/bin/env node
/**
 * Build + deploy admin console to production server via SSH.
 *
 *   pnpm -C apps/admin deploy:production
 *
 * API URL：admin 打**自己域**下的 /api（AGENTCORE_OFFICE_API_URL 可覆盖），刻意不跟
 * 桌面 / 手机共用 AGENTCORE_APP_API_URL —— 那正是两个 SPA 共用一份 access cookie、
 * 后登录者顶替先登录者的根因（详见 deploy/nginx/office-admin.conf 顶部注释）。
 * 须先 loadDeployEnv()，再解析主机——否则 deploy/.env.deploy.local 里的
 * AGENTCORE_* 不会生效。
 */
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  assertBackendContractSatisfied,
  loadDeployEnv,
  run,
  scp,
  sshScript,
} from "../../../deploy/scripts/load-deploy-env.mjs";

loadDeployEnv();

const APP_HOST = process.env.AGENTCORE_APP_HOST || "app.fashitianxia.xyz";
const OFFICE_HOST =
  process.env.AGENTCORE_OFFICE_HOST || "office.fashitianxia.xyz";
const API_URL =
  process.env.AGENTCORE_OFFICE_API_URL || `https://${OFFICE_HOST}/api`;
// 契约探针走产品域：后端是同一个进程，/version 的 git_sha 与走哪个入口无关。首次部署时
// office 的 /api/ 反代恰恰还没装上（它就是这次要装的），拿它探活会锁死自己。
const CONTRACT_PROBE_URL =
  process.env.AGENTCORE_APP_API_URL ||
  process.env.VITE_API_URL ||
  `https://${APP_HOST}/api`;
const TARBALL = join(REPO_ROOT, "admin-dist.tgz");
const NGINX_CONF = join(REPO_ROOT, "deploy/nginx/office-admin.conf");
const REMOTE_SCRIPT = join(REPO_ROOT, "deploy/scripts/admin-remote-install.sh");

// Guard against shipping a frontend newer than the live backend (前后端版本漂移).
await assertBackendContractSatisfied({ apiBaseUrl: CONTRACT_PROBE_URL });

const buildEnv = {
  ...process.env,
  VITE_API_URL: API_URL,
  ORIGIN: `https://${OFFICE_HOST}`,
  OFFICE_HOST,
};

run(
  "pnpm install (admin workspace)",
  "pnpm",
  ["install", "--frozen-lockfile", "--filter", "agentcore-admin..."],
  { env: buildEnv },
);

run("pnpm build (admin)", "pnpm", ["--filter", "agentcore-admin", "build"], {
  env: buildEnv,
});

run("tar admin dist", "tar", ["-czf", TARBALL, "-C", "apps/admin", "dist"]);

scp(TARBALL, "/tmp/admin-dist.tgz");
scp(NGINX_CONF, "/tmp/office-admin.conf");

const deployDir = process.env.AGENTCORE_DEPLOY_DIR?.trim() || "";
const deployDirExport = deployDir
  ? `export AGENTCORE_DEPLOY_DIR=${JSON.stringify(deployDir)}\n`
  : "";

sshScript(
  [
    deployDirExport.trimEnd(),
    `export ORIGIN=${JSON.stringify(`https://${OFFICE_HOST}`)}`,
    `export OFFICE_HOST=${JSON.stringify(OFFICE_HOST)}`,
    readFileSync(REMOTE_SCRIPT, "utf8"),
  ]
    .filter(Boolean)
    .join("\n"),
);

unlinkSync(TARBALL);

console.log(`✓ Admin deploy complete — verify https://${OFFICE_HOST}/`);
