"""Inline HTML for the demo-tape director console (dev-only control room)."""

from __future__ import annotations

# HTML/JS blob — line length is not meaningful here.
# ruff: noqa: E501

DIRECTOR_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Demo Tape · 控制室</title>
<style>
  :root {
    --bg: #0f1218;
    --bg2: #171c26;
    --bg3: #1e2533;
    --line: #2a3344;
    --text: #e8edf7;
    --muted: #8b96a8;
    --accent: #3d8bfd;
    --accent-dim: #1a3a66;
    --ok: #3ecf8e;
    --warn: #f0b429;
    --danger: #f07178;
    --await: #c792ea;
    --seek: #82aaff;
    --radius: 10px;
    --tap: 48px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body {
    font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.45;
    min-height: 100vh;
    padding: 16px 20px 32px;
  }
  .wrap { max-width: 920px; margin: 0 auto; }
  header {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 12px; margin-bottom: 16px; flex-wrap: wrap;
  }
  header h1 {
    margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0.02em;
  }
  header .sub { color: var(--muted); font-size: 13px; }
  .card {
    background: var(--bg2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 12px;
  }
  .card h2 {
    margin: 0 0 10px; font-size: 12px; font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted);
  }
  label.field { display: block; margin: 0 0 8px; font-size: 12px; color: var(--muted); }
  input[type=text], input[type=password], input[type=number], select {
    width: 100%; height: var(--tap); padding: 0 12px;
    border: 1px solid var(--line); border-radius: 8px;
    background: var(--bg3); color: var(--text); font-size: 15px;
  }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .row > * { min-width: 0; }
  .grow { flex: 1 1 160px; }
  button, .btn {
    appearance: none; border: 1px solid var(--line); background: var(--bg3);
    color: var(--text); border-radius: 8px; min-height: var(--tap);
    padding: 0 16px; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button:active { transform: translateY(1px); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.ghost { background: transparent; }
  button.active { background: var(--accent-dim); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }

  /* Auth */
  #authPanel.collapsed .auth-form { display: none; }
  #authPanel .auth-badge {
    display: none; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  #authPanel.collapsed .auth-badge { display: flex; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 600;
    background: var(--bg3); border: 1px solid var(--line);
  }
  .badge.ok { border-color: #2a6b4a; color: var(--ok); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }

  /* Hero status */
  .hero {
    display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center;
  }
  @media (max-width: 640px) { .hero { grid-template-columns: 1fr; } }
  .hero-state {
    font-size: clamp(28px, 5vw, 42px); font-weight: 800; letter-spacing: -0.02em;
    line-height: 1.1; margin: 0;
  }
  .hero-state[data-kind="playing"] { color: var(--ok); }
  .hero-state[data-kind="paused"] { color: var(--warn); }
  .hero-state[data-kind="awaiting"] { color: var(--await); }
  .hero-state[data-kind="awaiting_paused"] { color: var(--warn); }
  .hero-state[data-kind="seeking"] { color: var(--seek); }
  .hero-state[data-kind="idle"] { color: var(--muted); }
  .hero-state[data-kind="finished"] { color: var(--muted); }
  .hero-state[data-kind="error"] { color: var(--danger); }
  .hero-meta { color: var(--muted); font-size: 14px; margin-top: 6px; }
  .hero-meta strong { color: var(--text); font-weight: 700; }
  .speed-readout {
    font-size: 36px; font-weight: 800; font-variant-numeric: tabular-nums;
    text-align: right; color: var(--accent);
  }
  .speed-readout small { display: block; font-size: 12px; color: var(--muted); font-weight: 600; }

  /* Transport */
  #btnPlayPause {
    min-width: 140px; min-height: 64px; font-size: 20px; border-radius: 12px;
  }
  #btnPlayPause.is-playing { background: #3a2a14; border-color: var(--warn); color: var(--warn); }
  #btnPlayPause.is-paused { background: #143a28; border-color: var(--ok); color: var(--ok); }
  .speed-presets { display: flex; gap: 6px; flex-wrap: wrap; }
  .speed-presets button { min-width: 56px; padding: 0 10px; }
  .speed-custom { width: 88px; }

  /* Timeline */
  .time-row {
    display: flex; justify-content: space-between; align-items: baseline;
    font-variant-numeric: tabular-nums; margin-bottom: 8px;
  }
  .time-row .now { font-size: 28px; font-weight: 800; }
  .time-row .dur { color: var(--muted); font-size: 16px; }
  .scrub-wrap { position: relative; padding: 10px 0 18px; }
  .markers {
    position: absolute; left: 0; right: 0; top: 0; height: 10px; pointer-events: none;
  }
  .markers span {
    position: absolute; top: 0; width: 2px; height: 10px; background: var(--accent);
    opacity: 0.55; transform: translateX(-1px);
  }
  input[type=range] {
    -webkit-appearance: none; appearance: none; width: 100%; height: 28px;
    background: transparent; margin: 0; padding: 0;
  }
  input[type=range]::-webkit-slider-runnable-track {
    height: 10px; border-radius: 999px; background: var(--bg3); border: 1px solid var(--line);
  }
  input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 22px; height: 22px; border-radius: 50%;
    background: var(--accent); border: 2px solid #fff; margin-top: -7px; cursor: pointer;
  }
  input[type=range]::-moz-range-track {
    height: 10px; border-radius: 999px; background: var(--bg3); border: 1px solid var(--line);
  }
  input[type=range]::-moz-range-thumb {
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--accent); border: 2px solid #fff; cursor: pointer;
  }
  .seek-hint {
    margin-top: 8px; font-size: 12px; color: var(--muted);
    padding: 8px 10px; background: var(--bg3); border-radius: 8px; border: 1px dashed var(--line);
  }

  /* Chapters */
  .chapter-groups { display: flex; flex-direction: column; gap: 12px; }
  .chapter-group h3 {
    margin: 0 0 6px; font-size: 13px; color: var(--muted); font-weight: 600;
  }
  .chapter-wall { display: flex; flex-wrap: wrap; gap: 6px; }
  .chapter-wall button {
    min-height: 40px; padding: 6px 12px; font-size: 13px; font-weight: 600;
  }
  .chapter-wall button.current {
    background: var(--accent); border-color: var(--accent); color: #fff;
    box-shadow: 0 0 0 2px rgba(61,139,253,0.35);
  }
  .empty-guide {
    padding: 14px; border-radius: 8px; background: var(--bg3);
    border: 1px dashed var(--line); color: var(--muted); font-size: 14px;
  }
  .empty-guide strong { color: var(--text); }

  /* Log */
  details.log { border-top: 1px solid var(--line); margin-top: 4px; padding-top: 8px; }
  details.log summary {
    cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 600;
    user-select: none; list-style: none;
  }
  details.log summary::-webkit-details-marker { display: none; }
  #log {
    margin-top: 8px; max-height: 180px; overflow: auto;
    white-space: pre-wrap; font: 12px/1.4 ui-monospace, Consolas, monospace;
    color: var(--muted); background: var(--bg); padding: 8px; border-radius: 6px;
  }
  .raw-status {
    margin-top: 8px; font: 11px/1.35 ui-monospace, Consolas, monospace;
    color: var(--muted); white-space: pre-wrap; max-height: 120px; overflow: auto;
    opacity: 0.7;
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Demo Tape · 控制室</h1>
      <div class="sub">OBS 第二屏导演台 · 不上镜 · DEMO_TAPE_REPLAY_ENABLED</div>
    </div>
  </header>

  <section class="card" id="authPanel">
    <h2>连接</h2>
    <div class="auth-form">
      <div class="row">
        <label class="field grow">API base
          <input id="base" type="text" placeholder="默认当前 origin" />
        </label>
      </div>
      <div class="row">
        <label class="field grow">用户名
          <input id="user" type="text" value="dev" autocomplete="username" />
        </label>
        <label class="field grow">密码
          <input id="pass" type="password" value="devpassword" autocomplete="current-password" />
        </label>
        <button class="primary" id="btnLogin" type="button">登录</button>
      </div>
    </div>
    <div class="auth-badge">
      <span class="badge ok"><span class="dot"></span><span id="authBadgeText">已登录</span></span>
      <span class="badge" id="baseBadge"></span>
      <button class="ghost" id="btnLogout" type="button">退出 / 改连接</button>
    </div>
  </section>

  <section class="card" id="sessionCard">
    <h2>会话</h2>
    <div class="row">
      <label class="field grow">活跃回放
        <select id="sessionSelect"><option value="">选择会话…</option></select>
      </label>
      <button id="btnRefresh" type="button">刷新</button>
    </div>
    <label class="field" style="margin-top:8px">conversation_id
      <input id="cid" type="text" placeholder="或粘贴会话 UUID" spellcheck="false" />
    </label>
    <div id="sessionGuide" class="empty-guide">
      <strong>尚无活跃回放。</strong>
      请先在桌面端用命令面板「演示回放」准备/开播磁带，再点刷新。
      登录后下拉会列出本机进程内正在注入的会话。
    </div>
  </section>

  <section class="card" id="transportCard">
    <h2>传输</h2>
    <div class="hero">
      <div>
        <p class="hero-state" id="heroState" data-kind="idle">未连接</p>
        <div class="hero-meta" id="heroMeta">登录并选择会话后开始控制</div>
      </div>
      <div class="speed-readout"><span id="speedBig">—</span><small>倍速</small></div>
    </div>
    <div class="row" style="margin-top:14px">
      <button id="btnPlayPause" type="button" disabled>▶ 继续</button>
      <div class="speed-presets" id="speedPresets">
        <button type="button" data-speed="0.5">0.5×</button>
        <button type="button" data-speed="1">1×</button>
        <button type="button" data-speed="2">2×</button>
        <button type="button" data-speed="4">4×</button>
        <button type="button" data-speed="8">8×</button>
      </div>
      <input class="speed-custom" id="speedCustom" type="number" min="0.5" max="8" step="0.1" value="4" title="自定义倍速" />
      <button id="btnSpeedApply" type="button">应用</button>
    </div>
  </section>

  <section class="card" id="timelineCard">
    <h2>时间轴</h2>
    <div class="time-row">
      <span class="now" id="tNow">0:00</span>
      <span class="dur" id="tDur">/ 0:00 · —</span>
    </div>
    <div class="scrub-wrap">
      <div class="markers" id="markers"></div>
      <input id="scrub" type="range" min="0" max="0" value="0" step="1" />
    </div>
    <div class="row">
      <button class="primary grow" id="btnSeek" type="button">跳到此处</button>
    </div>
    <div class="seek-hint">向后跳 = 重启回放重建画面；跨授权卡自动代确认</div>
  </section>

  <section class="card" id="chaptersCard">
    <h2>章节</h2>
    <div class="chapter-groups" id="chapters"></div>
  </section>

  <section class="card">
    <details class="log" id="logDetails">
      <summary>操作日志 ▸</summary>
      <div id="log"></div>
    </details>
    <div class="raw-status" id="rawStatus"></div>
  </section>
</div>

<script>
(function () {
  const $ = (id) => document.getElementById(id);

  let token = localStorage.getItem("demo_tape_director_token") || "";
  let chapters = [];
  let lastStatus = null;
  let pollTimer = null;
  let scrubbing = false;

  function baseUrl() {
    const v = $("base").value.trim();
    if (v) return v.replace(/\\/$/, "");
    return location.origin;
  }

  function localTime() {
    return new Date().toLocaleTimeString(undefined, { hour12: false });
  }

  function log(msg) {
    const el = $("log");
    el.textContent = localTime() + "  " + msg + "\\n" + el.textContent;
  }

  function fmtMs(ms) {
    const n = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
    const m = Math.floor(n / 60);
    const s = Math.floor(n % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function canPoll() {
    return Boolean(token && $("cid").value.trim());
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPoll() {
    stopPoll();
    if (!canPoll()) return;
    pollTimer = setInterval(() => { pollStatus().catch(() => {}); }, 400);
  }

  function setAuthUI() {
    const panel = $("authPanel");
    if (token) {
      panel.classList.add("collapsed");
      $("authBadgeText").textContent = "已登录 · " + ($("user").value || "dev");
      $("baseBadge").textContent = baseUrl();
    } else {
      panel.classList.remove("collapsed");
    }
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (token) headers["Authorization"] = "Bearer " + token;
    const r = await fetch(baseUrl() + path, Object.assign({}, opts, { headers }));
    if (!r.ok) {
      const t = await r.text();
      throw new Error(r.status + " " + t.slice(0, 200));
    }
    if (r.status === 204) return null;
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return r.json();
    return r.text();
  }

  /** UI-facing transport label — soft_paused overrides bare state when awaiting. */
  function displayTransport(s) {
    if (!s) return { kind: "idle", title: "未连接", detail: "" };
    const soft = !!s.soft_paused;
    const st = String(s.state || "");
    if (st === "error") {
      return { kind: "error", title: "出错", detail: s.error || "" };
    }
    if (st === "finished") {
      return { kind: "finished", title: "已结束", detail: soft ? "导演软暂停仍开着" : "" };
    }
    if (st === "seeking") {
      return {
        kind: soft ? "paused" : "seeking",
        title: soft ? "导演暂停" : "跳转中",
        detail: soft ? "爆发注入已挂起 · 点继续恢复" : "爆发注入中",
      };
    }
    if (st === "awaiting_interaction") {
      if (soft) {
        return {
          kind: "awaiting_paused",
          title: "等待授权卡 · 已暂停",
          detail: "真交互停在授权卡；导演节拍已冻结（state 仍为 awaiting_interaction）",
        };
      }
      return {
        kind: "awaiting",
        title: "等待授权卡",
        detail: "桌面点「授权开赛」，或向前 seek 自动代确认",
      };
    }
    if (st === "paused" || soft) {
      return { kind: "paused", title: "导演暂停", detail: "节拍器已冻结 · 点继续恢复" };
    }
    if (st === "playing") {
      return { kind: "playing", title: "播放中", detail: (s.chapter_label || "") };
    }
    return { kind: "idle", title: st || "空闲", detail: s.chapter_label || "" };
  }

  function isEffectivelyPaused(s) {
    if (!s) return true;
    if (s.soft_paused) return true;
    return s.state === "paused" || s.state === "awaiting_interaction" || s.state === "finished" || s.state === "idle";
  }

  function updatePlayPauseButton(s) {
    const btn = $("btnPlayPause");
    const has = canPoll();
    btn.disabled = !has;
    if (!has) {
      btn.textContent = "▶ 继续";
      btn.className = "";
      return;
    }
    const paused = isEffectivelyPaused(s);
    // awaiting without soft_pause: still "waiting for card", resume is soft-only —
    // show 继续 only when soft_paused or state===paused; for pure awaiting show 暂停 to freeze metronome.
    if (s && s.state === "awaiting_interaction" && !s.soft_paused) {
      btn.textContent = "⏸ 暂停节拍";
      btn.className = "is-playing";
      btn.dataset.action = "pause";
      return;
    }
    if (paused) {
      btn.textContent = "▶ 继续";
      btn.className = "is-paused";
      btn.dataset.action = "resume";
    } else {
      btn.textContent = "⏸ 暂停";
      btn.className = "is-playing";
      btn.dataset.action = "pause";
    }
  }

  function highlightSpeed(speed) {
    const n = Number(speed);
    $("speedCustom").value = String(n);
    $("speedBig").textContent = Number.isFinite(n) ? n + "×" : "—";
    document.querySelectorAll("#speedPresets button").forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.speed) === n);
    });
  }

  function renderHero(s) {
    const d = displayTransport(s);
    const el = $("heroState");
    el.textContent = d.title;
    el.dataset.kind = d.kind;
    const parts = [];
    if (s) {
      parts.push("章节 <strong>" + (s.chapter_label || "—") + "</strong>");
      parts.push("事件 <strong>" + (s.event_index ?? "—") + "</strong>/" + (s.event_count ?? "—"));
      if (s.live) parts.push("live");
      if (s.soft_paused) parts.push("soft_paused");
      if (d.detail) parts.push(d.detail);
    } else {
      parts.push(d.detail || "登录并选择会话后开始控制");
    }
    $("heroMeta").innerHTML = parts.join(" · ");
    updatePlayPauseButton(s);
    if (s) highlightSpeed(s.speed);
  }

  function renderMarkers() {
    const box = $("markers");
    box.innerHTML = "";
    const dur = Number($("scrub").max) || 0;
    if (!dur || !chapters.length) return;
    for (const ch of chapters) {
      const pct = Math.min(100, Math.max(0, (ch.t_ms / dur) * 100));
      const sp = document.createElement("span");
      sp.style.left = pct + "%";
      sp.title = ch.label;
      box.appendChild(sp);
    }
  }

  function groupChapters(list) {
    const groups = [];
    const ensure = (title) => {
      let g = groups.find((x) => x.title === title);
      if (!g) { g = { title, items: [] }; groups.push(g); }
      return g;
    };
    for (const ch of list) {
      if (ch.id === "opening") ensure("开场").items.push(ch);
      else if (ch.id === "team_preview") ensure("组队授权").items.push(ch);
      else if (ch.id === "verdict") ensure("终审").items.push(ch);
      else {
        const m = /^r(\\d+)_/.exec(ch.id);
        if (m) ensure("第 " + m[1] + " 轮").items.push(ch);
        else ensure("其他").items.push(ch);
      }
    }
    return groups;
  }

  function renderChapters(currentLabel) {
    const root = $("chapters");
    root.innerHTML = "";
    if (!chapters.length) {
      root.innerHTML = '<div class="empty-guide">选择会话后加载章节表</div>';
      return;
    }
    for (const g of groupChapters(chapters)) {
      const sec = document.createElement("div");
      sec.className = "chapter-group";
      const h = document.createElement("h3");
      h.textContent = g.title;
      sec.appendChild(h);
      const wall = document.createElement("div");
      wall.className = "chapter-wall";
      for (const ch of g.items) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = ch.label;
        b.title = ch.label + " · " + fmtMs(ch.t_ms) + " · #" + ch.event_index;
        if (currentLabel && ch.label === currentLabel) b.classList.add("current");
        b.onclick = () => seekChapter(ch.id);
        wall.appendChild(b);
      }
      sec.appendChild(wall);
      root.appendChild(sec);
    }
  }

  function applyStatus(s) {
    lastStatus = s;
    renderHero(s);
    if (s.duration_ms != null) {
      $("scrub").max = String(s.duration_ms);
      renderMarkers();
    }
    if (!scrubbing) $("scrub").value = String(s.t_ms || 0);
    $("tNow").textContent = fmtMs(s.t_ms || 0);
    $("tDur").textContent = "/ " + fmtMs(s.duration_ms || 0) + " · " + (s.chapter_label || "—");
    renderChapters(s.chapter_label || "");
    $("rawStatus").textContent = JSON.stringify(s, null, 2);
  }

  async function login() {
    const body = { username: $("user").value, password: $("pass").value };
    const data = await api("/v1/auth/token", { method: "POST", body: JSON.stringify(body) });
    token = data.access_token;
    localStorage.setItem("demo_tape_director_token", token);
    setAuthUI();
    log("登录成功");
    await refreshSessions();
    startPoll();
  }

  function logout() {
    token = "";
    localStorage.removeItem("demo_tape_director_token");
    stopPoll();
    setAuthUI();
    lastStatus = null;
    renderHero(null);
    log("已退出");
  }

  async function refreshSessions() {
    if (!token) return;
    const data = await api("/v1/demo-tape/director/sessions");
    const sel = $("sessionSelect");
    const prev = $("cid").value.trim();
    sel.innerHTML = '<option value="">选择会话…</option>';
    const sessions = data.sessions || [];
    for (const s of sessions) {
      const opt = document.createElement("option");
      opt.value = s.conversation_id;
      opt.textContent = (s.tape_id || "?") + " · " + s.conversation_id.slice(0, 8) + " · " + s.state + " · " + (s.speed || "?") + "×";
      sel.appendChild(opt);
    }
    $("sessionGuide").hidden = sessions.length > 0;
    if (prev && sessions.some((s) => s.conversation_id === prev)) {
      sel.value = prev;
    } else if (sessions[0]) {
      $("cid").value = sessions[0].conversation_id;
      sel.value = sessions[0].conversation_id;
      await loadChapters();
      startPoll();
    } else {
      stopPoll();
    }
  }

  async function loadChapters() {
    const cid = $("cid").value.trim();
    if (!cid || !token) return;
    const data = await api("/v1/demo-tape/director/" + encodeURIComponent(cid) + "/chapters");
    chapters = data.chapters || [];
    const dur = chapters.reduce((m, c) => Math.max(m, c.t_ms || 0), 0);
    if (dur > 0) {
      $("scrub").max = String(Math.max(Number($("scrub").max) || 0, dur));
    }
    renderMarkers();
    renderChapters(lastStatus && lastStatus.chapter_label);
  }

  async function pollStatus() {
    if (!canPoll()) return;
    try {
      const s = await api("/v1/demo-tape/director/" + encodeURIComponent($("cid").value.trim()) + "/status");
      applyStatus(s);
    } catch (e) {
      $("rawStatus").textContent = String(e);
    }
  }

  async function togglePlayPause() {
    const cid = $("cid").value.trim();
    if (!cid) return;
    const action = $("btnPlayPause").dataset.action || "resume";
    if (action === "pause") {
      await api("/v1/demo-tape/director/" + encodeURIComponent(cid) + "/pause", { method: "POST", body: "{}" });
      log("暂停");
    } else {
      await api("/v1/demo-tape/director/" + encodeURIComponent(cid) + "/resume", { method: "POST", body: "{}" });
      log("继续");
    }
    await pollStatus();
  }

  async function setSpeed(speed) {
    const cid = $("cid").value.trim();
    if (!cid) return;
    const n = Math.max(0.5, Math.min(8, Number(speed)));
    await api("/v1/demo-tape/director/" + encodeURIComponent(cid) + "/speed", {
      method: "POST", body: JSON.stringify({ speed: n }),
    });
    log("倍速 " + n + "×");
    highlightSpeed(n);
    await pollStatus();
  }

  function snapTms(raw) {
    const t = Number(raw);
    if (!chapters.length) return t;
    // Prefer nearest event boundary among chapter marks + current scrub neighbors via chapter t_ms.
    // Full event snap is server-side on seek; UI snaps to nearest chapter tick for feel,
    // then server re-snaps to event boundary.
    let best = t;
    let bestDist = Infinity;
    for (const ch of chapters) {
      const d = Math.abs(ch.t_ms - t);
      if (d < bestDist) { bestDist = d; best = ch.t_ms; }
    }
    // If very close to a chapter mark (< 2s), snap to it; else keep scrub value (server snaps).
    if (bestDist <= 2000) return best;
    return t;
  }

  async function seek() {
    const cid = $("cid").value.trim();
    if (!cid) return;
    const t_ms = snapTms($("scrub").value);
    $("scrub").value = String(t_ms);
    await api("/v1/demo-tape/director/" + encodeURIComponent(cid) + "/seek", {
      method: "POST", body: JSON.stringify({ t_ms: Number(t_ms) }),
    });
    log("seek " + fmtMs(t_ms));
    await pollStatus();
  }

  async function seekChapter(id) {
    const cid = $("cid").value.trim();
    if (!cid) return;
    await api("/v1/demo-tape/director/" + encodeURIComponent(cid) + "/seek", {
      method: "POST", body: JSON.stringify({ chapter_id: id }),
    });
    log("章节 " + id);
    await pollStatus();
  }

  // Wire
  $("btnLogin").onclick = () => login().catch((e) => log(String(e)));
  $("btnLogout").onclick = () => logout();
  $("btnRefresh").onclick = () => refreshSessions().catch((e) => log(String(e)));
  $("btnPlayPause").onclick = () => togglePlayPause().catch((e) => log(String(e)));
  $("btnSpeedApply").onclick = () => setSpeed($("speedCustom").value).catch((e) => log(String(e)));
  $("btnSeek").onclick = () => seek().catch((e) => log(String(e)));
  document.querySelectorAll("#speedPresets button").forEach((b) => {
    b.onclick = () => setSpeed(b.dataset.speed).catch((e) => log(String(e)));
  });
  $("sessionSelect").onchange = () => {
    if ($("sessionSelect").value) {
      $("cid").value = $("sessionSelect").value;
      loadChapters().then(() => startPoll()).catch((e) => log(String(e)));
    } else {
      stopPoll();
    }
  };
  $("cid").onchange = () => {
    if (canPoll()) {
      loadChapters().then(() => startPoll()).catch((e) => log(String(e)));
    } else {
      stopPoll();
    }
  };
  $("scrub").addEventListener("pointerdown", () => { scrubbing = true; });
  $("scrub").addEventListener("pointerup", () => {
    scrubbing = false;
    const snapped = snapTms($("scrub").value);
    $("scrub").value = String(snapped);
    $("tNow").textContent = fmtMs(snapped);
  });
  $("scrub").addEventListener("input", () => {
    $("tNow").textContent = fmtMs($("scrub").value);
  });

  // Init — no poll until logged in + session selected
  $("base").value = "";
  $("base").placeholder = location.origin || "http://localhost:8000";
  setAuthUI();
  renderHero(null);
  renderChapters("");
  $("sessionGuide").hidden = false;
  if (token) {
    refreshSessions().catch(() => {});
    if ($("cid").value.trim()) {
      loadChapters().catch(() => {});
      startPoll();
    }
  }
})();
</script>
</body>
</html>
"""
