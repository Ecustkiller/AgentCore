/**
 * 桌面本地代码执行隔离（生成 / 最后修订 2026-11-04）。
 *
 * 三层：默认剥宿主高危 env 键、opt-in 严格白名单、opt-in macOS seatbelt。
 * 既有行为约束见 exec.ts：超时文案逐字不变、PYTHONPATH 的 D11′ 合并不变、
 * 信封形状不变。这里只验证新加的隔离边界，不改那些契约。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceOpResult } from "@shared/ipc-contract";
import { describe, expect, it } from "vitest";
import type { StoredRoot } from "../fs/roots";
import { opExecute, runSubprocess } from "../fs/workspace/exec";
import {
  LOCAL_EXEC_CAPABILITIES,
  buildChildEnv,
  buildSeatbeltProfile,
  readLocalExecIsolation,
  seatbeltArgv,
  seatbeltAvailable,
  seatbeltRefusalReason,
} from "../fs/workspace/execIsolation";

const SEATBELT_BIN = "/usr/bin/sandbox-exec";

describe("buildChildEnv · 默认剥掉宿主高危键", () => {
  it("LD_*/DYLD_*/BASH_FUNC_* 前缀 + 自动执行键一律不继承，普通键保留", () => {
    const env = buildChildEnv(
      undefined,
      {
        PATH: "/usr/bin",
        HOME: "/Users/tester",
        PYTHONPATH: "keep-me",
        MY_CUSTOM_VAR: "hello",
        LD_PRELOAD: "/tmp/evil.dylib",
        LD_LIBRARY_PATH: "/tmp/evil",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
        "BASH_FUNC_evil%%": "() { :; }",
        NODE_OPTIONS: "--require /tmp/evil.js",
        NODE_DEBUG: "http",
        BASH_ENV: "/tmp/evil.sh",
        PYTHONSTARTUP: "/tmp/evil.py",
        OPENSSL_CONF: "/tmp/evil.cnf",
      },
      { strictEnv: false, seatbelt: false },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/tester");
    // D11′: 宿主 PYTHONPATH 必须能进子进程。
    expect(env.PYTHONPATH).toBe("keep-me");
    expect(env.MY_CUSTOM_VAR).toBe("hello");
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env["BASH_FUNC_evil%%"]).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_DEBUG).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.PYTHONSTARTUP).toBeUndefined();
    expect(env.OPENSSL_CONF).toBeUndefined();
  });

  it("envExtra 是显式注入，优先级最高且不受劫持过滤", () => {
    const env = buildChildEnv(
      { PYTHONPATH: "/workspace:/workspace/src", NEXUS_TOKEN: "abc" },
      { PYTHONPATH: "host-value", PATH: "/usr/bin" },
      { strictEnv: false, seatbelt: false },
    );
    expect(env.PYTHONPATH).toBe("/workspace:/workspace/src");
    expect(env.NEXUS_TOKEN).toBe("abc");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("值 undefined 的键不进 env", () => {
    const env = buildChildEnv(
      undefined,
      { A: "1", B: undefined },
      { strictEnv: false, seatbelt: false },
    );
    expect(env).toEqual({ A: "1" });
  });
});

describe("buildChildEnv · 严格模式 opt-in", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/Users/tester",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    PYTHONPATH: "keep-me",
    SSL_CERT_FILE: "/etc/cert.pem",
    AWS_SECRET_ACCESS_KEY: "super-secret",
    HTTP_PROXY: "http://proxy.internal:8080",
    MY_PRIVATE_TOKEN: "abc",
    NODE_OPTIONS: "--require /tmp/evil.js",
  };

  it("只留运行时必需键 + envExtra，宿主凭据/代理被丢掉", () => {
    const env = buildChildEnv({ NEXUS_TOKEN: "explicit" }, host, {
      strictEnv: true,
      seatbelt: false,
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/tester");
    expect(env.LANG).toBe("zh_CN.UTF-8");
    expect(env.LC_ALL).toBe("zh_CN.UTF-8");
    expect(env.PYTHONPATH).toBe("keep-me");
    expect(env.SSL_CERT_FILE).toBe("/etc/cert.pem");
    expect(env.NEXUS_TOKEN).toBe("explicit");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.MY_PRIVATE_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it("默认（未开）仍保留自定义键，严格模式不改变默认行为", () => {
    const env = buildChildEnv(undefined, host, {
      strictEnv: false,
      seatbelt: false,
    });
    expect(env.MY_PRIVATE_TOKEN).toBe("abc");
    expect(env.HTTP_PROXY).toBe("http://proxy.internal:8080");
  });
});

describe("readLocalExecIsolation", () => {
  it("默认全关", () => {
    expect(readLocalExecIsolation({})).toEqual({
      strictEnv: false,
      seatbelt: false,
    });
  });

  it("只认字面值，拼错/未知值 fail closed", () => {
    expect(
      readLocalExecIsolation({
        AGENTCORE_LOCAL_EXEC_ENV_STRICT: "1",
        AGENTCORE_LOCAL_EXEC_SANDBOX: "seatbelt",
      }),
    ).toEqual({ strictEnv: true, seatbelt: true });
    expect(
      readLocalExecIsolation({
        AGENTCORE_LOCAL_EXEC_ENV_STRICT: "true",
        AGENTCORE_LOCAL_EXEC_SANDBOX: "SEATBELT",
      }),
    ).toEqual({ strictEnv: false, seatbelt: false });
  });
});

describe("seatbelt profile", () => {
  it("禁网 + 条件 deny 写白名单，路径去重并转义", () => {
    const profile = buildSeatbeltProfile([
      "/private/tmp/work space",
      "/private/tmp/work space",
      '/private/tmp/quote"dir',
    ]);
    expect(profile.startsWith("(version 1)")).toBe(true);
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny file-write*");
    expect(profile).toContain("(require-not");
    expect(profile).toContain('(subpath "/private/tmp/work space")');
    expect(profile).toContain('(subpath "/private/tmp/quote\\"dir")');
    expect(profile).toContain('(subpath "/dev")');
    expect(profile.match(/work space/g)).toHaveLength(1);
    // 括号配平：deny / require-not / require-any 各一层。
    expect(profile).toContain("    )))");
  });

  it("包装命令把 scriptFile 留在末尾（runSubprocess 会追加）", () => {
    expect(seatbeltArgv(["python3", "-u"], "/tmp/exec.sb")).toEqual([
      SEATBELT_BIN,
      "-f",
      "/tmp/exec.sb",
      "--",
      "python3",
      "-u",
    ]);
  });

  it("如实声明 CPU/内存上限未落实，不宣称 512MB", () => {
    expect(LOCAL_EXEC_CAPABILITIES.memoryLimitEnforced).toBe(false);
    expect(LOCAL_EXEC_CAPABILITIES.cpuLimitEnforced).toBe(false);
    expect(LOCAL_EXEC_CAPABILITIES.envHijackKeysStripped).toBe(true);
  });
});

describe("有牙齿的验证：真实子进程", () => {
  it("默认模式下宿主的 NODE_OPTIONS 不进 AI 脚本，envExtra 仍能注入", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "exec-iso-env-")));
    const script = join(dir, "probe.cjs");
    await writeFile(
      script,
      [
        "const out = {",
        "  nodeOptions: process.env.NODE_OPTIONS ?? null,",
        "  injected: process.env.NEXUS_TEST_INJECT ?? null,",
        "  hasPath: Boolean(process.env.PATH),",
        "};",
        "process.stdout.write(JSON.stringify(out));",
      ].join("\n"),
      "utf-8",
    );
    const original = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--max-old-space-size=64";
    try {
      const res: WorkspaceOpResult = await runSubprocess(
        [process.execPath],
        script,
        dir,
        null,
        10,
        Date.now(),
        { NEXUS_TEST_INJECT: "yes" },
        null,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const value = res.value as {
        success: boolean;
        stdout: string;
        stderr: string;
      };
      expect(value.success, value.stderr).toBe(true);
      const out = JSON.parse(value.stdout) as {
        nodeOptions: string | null;
        injected: string | null;
        hasPath: boolean;
      };
      expect(out.nodeOptions).toBeNull();
      expect(out.injected).toBe("yes");
      expect(out.hasPath).toBe(true);
    } finally {
      if (original === undefined)
        Reflect.deleteProperty(process.env, "NODE_OPTIONS");
      else process.env.NODE_OPTIONS = original;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const canRunSeatbelt =
  process.platform === "darwin" &&
  existsSync(SEATBELT_BIN) &&
  seatbeltAvailable();

describe.skipIf(!canRunSeatbelt)("seatbelt 实跑（macOS）", () => {
  it("白名单内可写、白名单外 EPERM", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "exec-iso-sb-")));
    const allowed = join(dir, "allowed");
    // 必须落在白名单目录之外：tmpdir 根不是 dir 的父级白名单，写它会被 seatbelt 拒。
    const denied = join(
      await realpath(tmpdir()),
      `nexus-iso-denied-${process.pid}-${Date.now()}.txt`,
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(allowed);
    const script = join(dir, "probe.cjs");
    await writeFile(
      script,
      [
        'const fs = require("node:fs");',
        "const [okPath, noPath] = process.argv.slice(2);",
        "for (const p of [okPath, noPath]) {",
        "  try { fs.writeFileSync(p, 'x'); console.log('WRITE-OK'); }",
        "  catch (e) { console.log('WRITE-DENY', e.code); }",
        "}",
      ].join("\n"),
      "utf-8",
    );
    const profilePath = join(dir, "exec.sb");
    await writeFile(profilePath, buildSeatbeltProfile([dir]), "utf-8");
    try {
      const argv = seatbeltArgv([process.execPath, script], profilePath);
      const r = spawnSync(
        argv[0],
        [...argv.slice(1), join(allowed, "ok.txt"), denied],
        {
          encoding: "utf-8",
          timeout: 10_000,
        },
      );
      expect(r.error).toBeUndefined();
      expect(r.stdout).toContain("WRITE-OK");
      expect(r.stdout).toContain("WRITE-DENY EPERM");
      expect(existsSync(join(allowed, "ok.txt"))).toBe(true);
      expect(existsSync(denied)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(denied, { force: true }).catch(() => {});
    }
  });
});

describe("seatbeltRefusalReason · 要求隔离但做不到时 fail closed", () => {
  it("默认关不拦截", () => {
    expect(
      seatbeltRefusalReason({ strictEnv: false, seatbelt: false }, false),
    ).toBeNull();
  });

  it("开了且平台支持 → 放行", () => {
    expect(
      seatbeltRefusalReason({ strictEnv: false, seatbelt: true }, true),
    ).toBeNull();
  });

  it("开了但平台不支持 → 返回拒绝文案，绝不静默降级成裸 spawn", () => {
    const reason = seatbeltRefusalReason(
      { strictEnv: false, seatbelt: true },
      false,
    );
    expect(reason).toContain("refusing to run unisolated");
    expect(reason).toContain("AGENTCORE_LOCAL_EXEC_SANDBOX=seatbelt");
  });
});

describe.skipIf(!canRunSeatbelt)("opExecute · seatbelt 端到端", () => {
  it("脚本正常执行，写工作区外被拒", async () => {
    const rootAbs = await realpath(
      await mkdtemp(join(tmpdir(), "exec-iso-root-")),
    );
    // 不在 workspace / 脚本临时目录 / 系统 tmpdir 白名单内，且不是用户个人目录。
    const outside = `/private/var/tmp/nexus-iso-outside-${process.pid}-${Date.now()}.txt`;
    const prev = process.env.AGENTCORE_LOCAL_EXEC_SANDBOX;
    process.env.AGENTCORE_LOCAL_EXEC_SANDBOX = "seatbelt";
    try {
      const root: StoredRoot = { id: "r", name: "r", absPath: rootAbs };
      const inside = join(rootAbs, "inside.txt");
      const code = [
        'const fs = require("node:fs");',
        `try { fs.writeFileSync(${JSON.stringify(inside)}, "x"); console.log("INSIDE-OK"); }`,
        `catch (e) { console.log("INSIDE-DENY", e.code); }`,
        `try { fs.writeFileSync(${JSON.stringify(outside)}, "x"); console.log("OUTSIDE-OK"); }`,
        `catch (e) { console.log("OUTSIDE-DENY", e.code); }`,
      ].join("\n");
      const res = await opExecute(root, {
        language: "javascript",
        code,
        timeout_seconds: 15,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const v = res.value as {
        success: boolean;
        stdout: string;
        stderr: string;
      };
      expect(v.success, v.stderr).toBe(true);
      expect(v.stdout).toContain("INSIDE-OK");
      expect(v.stdout).toContain("OUTSIDE-DENY EPERM");
      expect(existsSync(outside)).toBe(false);
    } finally {
      if (prev === undefined)
        Reflect.deleteProperty(process.env, "AGENTCORE_LOCAL_EXEC_SANDBOX");
      else process.env.AGENTCORE_LOCAL_EXEC_SANDBOX = prev;
      await rm(rootAbs, { recursive: true, force: true });
      await rm(outside, { force: true }).catch(() => {});
    }
  });
});
