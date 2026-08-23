// ===== NewAPI 一键签到 - 弹窗/侧边栏/宽屏页 共用逻辑 =====
const KEY_PLATFORMS = "nacheckin.platforms";
const KEY_SETTINGS = "nacheckin.settings";
const BATCH_INTERVAL = 500;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let platforms = [];
let editingId = null;
let connectionPromise = null;
let deletingId = null;

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function currentMonth() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}
const $ = (id) => document.getElementById(id);
const esc = (v = "") => String(v).replace(/[&<>'"]/g, (c) => "&#" + c.charCodeAt(0) + ";");

function formatQuota(v) {
  return (Number(v || 0) / 500000).toFixed(4);
}
function fmtTokens(v, truncated) {
  if (v == null) return "—";
  const n = Number(v) || 0;
  return n.toLocaleString("en-US") + (truncated ? "+" : "");
}

function toast(text, error = false) {
  const el = $("toast");
  el.textContent = text;
  el.className = "show" + (error ? " error" : "");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => (el.className = ""), 1600);
}

// ---------- 主题切换 ----------
function currentTheme(){ return document.documentElement.getAttribute("data-theme")==="light"?"light":"dark"; }
function preferredTheme(){
  try{ var v=localStorage.getItem("nacheckin.theme"); if(v==="light"||v==="dark") return v; }catch(e){}
  try{ if(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches) return "light"; }catch(e){}
  return "dark";
}
function applyTheme(mode){
  document.documentElement.setAttribute("data-theme",mode);
  var b=$("themeToggle");
  if(b){ b.textContent = mode==="dark"?"☾":"☀"; b.title = mode==="dark"?"切换到浅色界面":"切换到深色界面"; b.setAttribute("aria-label",b.title); }
}
function saveTheme(mode){ try{ localStorage.setItem("nacheckin.theme",mode); }catch(e){} }
function toggleTheme(){
  var next = currentTheme()==="dark"?"light":"dark";
  applyTheme(next); saveTheme(next);
}

// ---------- 与后台通讯 ----------
function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, message: chrome.runtime.lastError.message });
        else resolve(resp);
      });
    } catch (e) {
      resolve({ ok: false, message: e.message });
    }
  });
}
const slim = (p) => ({ baseUrl: p.baseUrl, userId: p.userId, accessToken: p.accessToken, authMode: p.authMode });
const getStats = (p, month) =>
  send({ type: "stats", platform: slim(p), month: month || $("monthInput").value || currentMonth() });
const doCheckin = (p, reauth = true) => send({ type: "checkin", platform: slim(p), reauth });
const getAccount = (p, month) =>
  send({ type: "account", platform: slim(p), month: month || $("monthInput").value || currentMonth() });

// ---------- 校验 ----------
function validatePlatform(p) {
  let url;
  try {
    url = new URL(p.baseUrl);
  } catch {
    throw new Error("NewAPI 站点地址格式不正确");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("站点地址必须使用 HTTP/HTTPS");
  if (p.authMode === "cookie") return p;
  if (p.userId && !/^\d+$/.test(String(p.userId).trim()))
    throw new Error("请填写正确的 NewAPI 用户ID");
  if (!(p.accessToken || "").trim()) throw new Error("请填写访问令牌");
  return p;
}

function isAlreadyCheckinMessage(message) {
  return /已签到|已经签到|签到过|重复签到|already\s+(?:checked\s+in|signed\s+in|today)|today\s+already/i.test(String(message || ""));
}

// ---------- 统计合并 ----------
function mergeStatsInto(id, data, message, ok, account) {
  const p = platforms.find((x) => x.id === id);
  if (!p) return;
  p.message = message || p.message;
  // 只在带 data（签到/统计响应）时才影响签到相关状态；纯刷新额度时不改动签到状态
  if (data) {
    p.error = ok ? "" : message;
    p.stats = data.stats || p.stats || {};
    p.statsDate = todayStr();
    p.enabled = data.enabled;
    if (data.max_quota != null) p.stats.max_quota = data.max_quota;
    if (data.min_quota != null) p.stats.min_quota = data.min_quota;
  } else if (!ok) {
    p.error = message;
  }
  if (account) p.account = account;
}

// ---------- 渲染 ----------
function status(p) {
  if (p.loading) return ["处理中", "badge-muted"];
  // checked_in_today 来自缓存，必须由 statsDate 锚定当天，否则跨天后视为待签到
  if (p.stats && p.stats.checked_in_today && p.statsDate === todayStr()) return ["今日已签到", "badge-success"];
  if (p.error) return ["请求失败", "badge-danger"];
  return ["待签到", "badge-warning"];
}

function render() {
  const grid = $("platformGrid");
  $("totalPlatforms").textContent = platforms.length;
  const today = todayStr();
  $("checkedPlatforms").textContent = platforms.filter((p) => p.stats && p.stats.checked_in_today && p.statsDate === today).length;
  $("monthCheckins").textContent = platforms.reduce((n, p) => n + ((p.stats && p.stats.checkin_count) || 0), 0);
  $("totalQuota").innerHTML =
    formatQuota(platforms.reduce((n, p) => n + (Number(p.account && p.account.available) || 0), 0)) + ' <small>$</small>';

  if (!platforms.length) {
    grid.innerHTML = '<div class="empty">还没有平台配置，点击下方「添加平台」开始使用。</div>';
    return;
  }
  grid.innerHTML = platforms
    .map((p) => {
      const [label, cls] = status(p);
      const q = p.stats || {};
      const acc = p.account || {};
      const qv = (v) => (v == null ? "—" : formatQuota(v));
      const qt = (v, trunc) => fmtTokens(v, trunc);
      return (
        '<article class="platform-card"><div class="card-top"><div>' +
        "<h3 class=\"platform-name\">" + esc(p.name) + "</h3>" +
        '<div class="address" title="' + esc(p.baseUrl) + '">' + esc(p.baseUrl) + "</div></div>" +
        '<span class="badge ' + cls + '">' + label + "</span></div>" +
        '<div class="card-stats">' +
        '<div class="mini-stat"><strong>' + qv(acc.available) + '</strong><span>可用额度</span></div>' +
        '<div class="mini-stat"><strong>' + qv(acc.used) + '</strong><span>已用额度</span></div>' +
        '<div class="mini-stat"><strong>' + qt(acc.monthlyTokens, acc.tokensTruncated) + '</strong><span>本月Token</span></div>' +
        "</div>" +
        '<p class="message' + (p.error ? " err" : "") + '">' + esc(p.message || p.note || "尚未获取最新统计") + "</p>" +
        '<div class="card-actions">' +
        '<button class="btn btn-primary" data-action="checkin" data-id="' + esc(p.id) + '"' + (p.loading ? " disabled" : "") + ">" + (p.loading ? "签到中…" : "立即签到") + "</button>" +
        '<button class="btn btn-light" data-action="stats" data-id="' + esc(p.id) + '">刷新</button>' +
        '<button class="btn btn-light" data-action="edit" data-id="' + esc(p.id) + '">编辑</button>' +
        '<button class="btn btn-danger" data-action="delete" data-id="' + esc(p.id) + '">删除</button>' +
        "</div></article>"
      );
    })
    .join("");
}

// ---------- 操作 ----------
async function checkin(id, options) {
  const p = platforms.find((x) => x.id === id);
  if (!p || p.loading) return;
  p.loading = true;
  p.error = "";
  render();
  const r = await doCheckin(p, !(options && options.reauth === false));
  p.message = r.message;
  p.error = r.ok ? "" : r.message;
  // 今日已签到判定：成功 或 站点明确提示重复签到，都锚定今天，防止跨天误显
  if (r.ok || isAlreadyCheckinMessage(r.message)) {
    p.stats = p.stats || {};
    if (r.data && r.data.stats) Object.assign(p.stats, r.data.stats);
    p.stats.checked_in_today = true;
    p.statsDate = todayStr();
  }
  p.loading = false;
  render();
  toast(p.name + "：" + r.message, !r.ok);
  await savePlatforms();
  if (r.ok && !r.reauthRequired) await refreshStats(id, true);
}

async function fetchStats(id, btnEl) {
  const p = platforms.find((x) => x.id === id);
  if (!p || p.loading) return;
  // 刷新只拉额度，不触发签到；不改动签到的 loading 标志，避免"立即签到"按钮被牵连
  const btn = btnEl || document.querySelector('button[data-action="stats"][data-id="' + CSS.escape(String(id)) + '"]');
  if (btn) btn.disabled = true;
  try {
    await refreshStats(id, false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshStats(id, silent) {
  const p = platforms.find((x) => x.id === id);
  if (!p) return;
  // 刷新只拉账户额度三项，不调用签到/统计接口，避免触发签到或干扰签到状态
  const r = await getAccount(p);
  mergeStatsInto(id, null, r.ok ? "额度已更新" : r.message, r.ok, r.account || null);
  await savePlatforms();
  render();
  if (!silent) toast(p.name + "：" + (r.ok ? "额度已更新" : r.message), !r.ok);
}

async function runBatch(action) {
  for (let i = 0; i < platforms.length; i++) {
    await action(platforms[i].id);
    if (i < platforms.length - 1) await wait(BATCH_INTERVAL);
  }
}

async function refreshAll() {
  if (!platforms.length) return toast("请先添加平台", true);
  $("refreshBtn").disabled = true;
  try {
    await runBatch((id) => refreshStats(id, true));
    toast("统计刷新完成");
  } finally {
    $("refreshBtn").disabled = false;
  }
}

// ---------- 添加/编辑 ----------
function formData() {
  return {
    name: $("name").value.trim(),
    baseUrl: $("baseUrl").value.trim().replace(/\/+$/, ""),
    userId: $("userId").value.trim(),
    accessToken: $("accessToken").value.trim(),
    note: $("note").value.trim(),
    authMode: $("authMode") ? $("authMode").value : "token",
  };
}

function openModal(p) {
  editingId = p ? p.id : null;
  $("modalTitle").textContent = p ? "编辑平台" : "添加平台";
  $("name").value = p ? p.name || "" : "";
  $("baseUrl").value = p ? p.baseUrl || "" : "";
  $("userId").value = p ? p.userId || "" : "";
  $("accessToken").value = p ? p.accessToken || "" : "";
  $("note").value = p ? p.note || "" : "";
  // 鉴权方式：agentrouter.org 默认 Cookie（其签到接口拒绝访问令牌自动签到）
  if (p && p.authMode) {
    $("authMode").value = p.authMode === "cookie" ? "cookie" : "token";
  } else {
    const u = $("baseUrl").value.trim();
    $("authMode").value = /agentrouter\.org/i.test(u) ? "cookie" : "token";
  }
  toggleAuthFields();
  $("connectionStatus").className = "connection-status";
  $("connectionStatus").textContent = "";
  $("modal").classList.add("open");
  $("name").focus();
}
// 鉴权方式切换：Cookie 模式时令牌/用户ID可留空，并提示
function toggleAuthFields() {
  const mode = $("authMode").value;
  const isCookie = mode === "cookie";
  const tokenInput = $("accessToken");
  const userIdInput = $("userId");
  tokenInput.required = !isCookie;
  userIdInput.required = false;
  const hint = $("authHint");
  if (hint) hint.textContent = isCookie ? "Cookie 模式：需已在浏览器登录该站点。agentrouter.org 签到后会在临时标签页自动发起 GitHub 重新登录，成功进入首页后自动关闭；若 GitHub 要求验证码或授权，请手动完成。" : "令牌模式：填「个人设置」生成的系统访问令牌（约32位），非「令牌管理」的 API 令牌(sk-xxx)。";
}

function editPlatform(id) {
  openModal(platforms.find((p) => p.id === id));
}

function connectionStatus(text, type) {
  const el = $("connectionStatus");
  el.textContent = text;
  el.className = "connection-status show " + (type || "loading");
}

async function testConnection() {
  if (connectionPromise) return connectionPromise;
  const data = formData();
  try {
    validatePlatform(data);
  } catch (e) {
    connectionStatus(e.message, "error");
    throw e;
  }
  $("testBtn").disabled = true;
  connectionStatus("正在检测站点和令牌，请稍候…");
  connectionPromise = (async () => {
    try {
      const r = await send({ type: "test", platform: slim(data), month: $("monthInput").value || currentMonth() });
      if (r.ok) {
        const needsUserId = data.userId ? "当前站点已使用用户ID鉴权。" : "当前站点无需用户ID即可连接。";
        connectionStatus("连接成功：" + (r.message || "签到接口可用") + " " + needsUserId, "success");
        return r;
      }
      const hint = !data.userId ? " 若该站点要求 New-Api-User，请填写用户ID后重试。" : "";
      connectionStatus("连接失败：" + r.message + hint, "error");
      throw new Error(r.message);
    } catch (e) {
      connectionStatus("连接失败：" + (e.message || "未知错误"), "error");
      throw e;
    } finally {
      connectionPromise = null;
      $("testBtn").disabled = false;
    }
  })();
  return connectionPromise;
}

function removePlatform(id) {
  const p = platforms.find((x) => x.id === id);
  if (!p) return;
  deletingId = id;
  $("deleteMessage").textContent = '确定删除"' + p.name + '"吗？删除后无法恢复。';
  $("deleteModal").classList.add("open");
}
function closeDelete() {
  deletingId = null;
  $("deleteModal").classList.remove("open");
}

// ---------- 设置 ----------
async function applySettings(s) {
  if (!s) s = { autoEnabled: false, autoTime: "08:01", autoApprove: false, notify: true };
  $("autoEnabled").checked = !!s.autoEnabled;
  $("autoTime").value = /^([01]\d|2[0-3]):[0-5]\d$/.test(s.autoTime || "") ? s.autoTime : "08:01";
  $("autoApprove").checked = !!s.autoApprove;
  $("notifyEnabled").checked = s.notify !== false;
}
async function saveSettings() {
  const settings = {
    autoEnabled: $("autoEnabled").checked,
    autoTime: $("autoTime").value || "08:01",
    autoApprove: $("autoApprove").checked,
    notify: $("notifyEnabled").checked,
  };
  await send({ type: "saveSettings", settings });
  toast(settings.autoEnabled ? "已开启定时自动签到" : "已关闭定时自动签到");
}
async function renderLastAuto() {
  const r = await send({ type: "getLastAuto" });
  const el = $("lastAutoMsg");
  if (r && r.last) {
    const t = new Date(r.last.time);
    el.textContent =
      "上次签到：" + t.toLocaleString() + " · 成功 " + r.last.ok + " / 已签 " + r.last.already + " / 失败 " + r.last.fail;
  } else {
    el.textContent = "尚未执行过自动签到。";
  }
}

// ---------- 导入/导出 ----------
function exportConfig() {
  const clean = platforms.map(({ loading, error, ...rest }) => rest);
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "newapi-checkin-config.json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("配置已导出");
}
async function importConfig(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error("配置格式必须是数组");
    platforms = data.map((p) => ({
      id: /^[A-Za-z0-9_-]{1,64}$/.test(p.id) ? p.id : Date.now().toString() + Math.random().toString(16).slice(2, 8),
      authMode: p.authMode === "cookie" ? "cookie" : "token",
      name: p.name || "",
      baseUrl: p.baseUrl || "",
      userId: String(p.userId || ""),
      accessToken: p.accessToken || "",
      note: p.note || "",
      stats: p.stats || {},
      message: p.message || "",
    }));
    await savePlatforms();
    render();
    toast("已导入 " + platforms.length + " 个平台");
  } catch (e) {
    toast("导入失败：" + e.message, true);
  }
}

// ---------- 存储 ----------
function loadStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([KEY_PLATFORMS, KEY_SETTINGS], (res) => {
      platforms = Array.isArray(res[KEY_PLATFORMS]) ? res[KEY_PLATFORMS] : [];
       resolve(res[KEY_SETTINGS] || { autoEnabled: false, autoTime: "08:01", autoApprove: false, notify: true });
    });
  });
}
function savePlatforms() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [KEY_PLATFORMS]: platforms }, resolve);
  });
}

// ---------- 初始化 ----------
async function init() {
  applyTheme(preferredTheme());
  // 宽屏管理页（popup.html，body 始终带 tab-mode）：隐藏「展开」按钮
  // 侧边栏（sidebar.html，body 带 sidebar-mode）：保留「展开」按钮，打开宽屏页
  if (
    new URLSearchParams(location.search).get("tab") === "1" ||
    document.body.classList.contains("tab-mode")
  ) {
    document.body.classList.add("tab-mode");
    $("openTabBtn").style.display = "none";
  }

  const settings = await loadStorage();
  await applySettings(settings);
  $("monthInput").value = currentMonth();
  render();
  renderLastAuto();

  // 事件委托：所有卡片按钮统一处理
  $("platformGrid").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === "checkin") checkin(id);
    else if (action === "stats") fetchStats(id, btn);
    else if (action === "edit") editPlatform(id);
    else if (action === "delete") removePlatform(id);
  });

  $("authMode").onchange = toggleAuthFields;
  $("baseUrl").addEventListener("input", () => {
    if (!editingId && $("authMode")) {
      const u = $("baseUrl").value.trim();
      const want = /agentrouter\.org/i.test(u) ? "cookie" : "token";
      if ($("authMode").value !== want) { $("authMode").value = want; toggleAuthFields(); }
    }
  });
  $("addBtn").onclick = () => openModal();
  $("closeBtn").onclick = () => $("modal").classList.remove("open");
  $("cancelBtn").onclick = () => $("modal").classList.remove("open");
  $("modal").onclick = (e) => {
    if (e.target === $("modal")) $("modal").classList.remove("open");
  };
  $("testBtn").onclick = () => testConnection().catch(() => {});
  $("accessToken").addEventListener("blur", () => {
    if ($("baseUrl").value.trim() && $("accessToken").value.trim()) testConnection().catch(() => {});
  });
  $("platformForm").onsubmit = async (e) => {
    e.preventDefault();
    const data = formData();
    const submit = e.submitter;
    if (submit) submit.disabled = true;
    try {
      const r = await testConnection();
      data.stats = r.data ? r.data.stats || {} : {};
      if (r.data && r.data.max_quota != null) data.stats.max_quota = r.data.max_quota;
      if (editingId) {
        Object.assign(platforms.find((p) => p.id === editingId) || {}, data);
      } else {
        platforms.push({ id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(), ...data });
      }
      await savePlatforms();
      render();
      $("modal").classList.remove("open");
      toast("连接检测成功，平台配置已保存");
    } catch {
      toast("保存前检测失败，请检查配置", true);
    } finally {
      if (submit) submit.disabled = false;
    }
  };

  $("deleteCloseBtn").onclick = closeDelete;
  $("deleteCancelBtn").onclick = closeDelete;
  $("deleteModal").onclick = (e) => {
    if (e.target === $("deleteModal")) closeDelete();
  };
  $("deleteConfirmBtn").onclick = async () => {
    if (!deletingId) return;
    platforms = platforms.filter((p) => p.id !== deletingId);
    await savePlatforms();
    render();
    closeDelete();
    toast("平台已删除");
  };

  $("batchBtn").onclick = async () => {
    if (!platforms.length) return toast("请先添加平台", true);
    $("batchBtn").disabled = true;
    try {
      // 并发签到：所有平台立即同时发起，互不等待
      await Promise.all(platforms.map((p) => checkin(p.id)));
      toast("批量签到完成");
    } finally {
      $("batchBtn").disabled = false;
    }
  };
  $("refreshBtn").onclick = refreshAll;

  $("exportBtn").onclick = exportConfig;
  $("importBtn").onclick = () => $("fileInput").click();
  if ($("importBtn2")) $("importBtn2").onclick = () => $("fileInput").click();
  $("fileInput").onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await importConfig(file);
    e.target.value = "";
  };

  // 「展开」：在标签页打开宽屏管理页
  $("openTabBtn").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  if ($("themeToggle")) $("themeToggle").onclick = toggleTheme;

  $("autoEnabled").onchange = saveSettings;
  $("autoTime").onchange = saveSettings;
  $("autoApprove").onchange = saveSettings;
  $("notifyEnabled").onchange = saveSettings;
  $("runNowBtn").onclick = async () => {
    $("runNowBtn").disabled = true;
    try {
      const r = await send({ type: "autoRun" });
      if (r && r.ok && r.summary) {
        toast("执行完成：成功 " + r.summary.ok + " / 已签 " + r.summary.already + " / 失败 " + r.summary.fail);
      } else {
        toast("没有需要签到的平台", true);
      }
      await refreshAll();
      renderLastAuto();
    } finally {
      $("runNowBtn").disabled = false;
    }
  };
}
init();
