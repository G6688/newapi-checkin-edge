// ===== NewAPI 中转站一键签到 - 后台 Service Worker =====
// 原理：直接用 host 权限跨域调用目标站 /api/user/checkin，无需任何服务端代理。
//   GET  /api/user/checkin?month=YYYY-MM  -> 获取签到开关/额度上下限/本月统计
//   POST /api/user/checkin               -> 执行当日签到
//   鉴权：Authorization: Bearer <系统访问令牌/PAT>，令牌唯一标识用户。

const KEY_PLATFORMS = "nacheckin.platforms";
const KEY_SETTINGS = "nacheckin.settings";
const KEY_LASTAUTO = "nacheckin.lastAuto";
const ALARM_NAME = "nacheckin.auto";
const BATCH_INTERVAL = 500; // 批量签到间隔(ms)，对齐原网站

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function currentMonth() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

// ---------- 存储 ----------
function getStore(key, fallback) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (res) => resolve(res[key] ?? fallback));
  });
}
function setStore(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}
const getPlatforms = () => getStore(KEY_PLATFORMS, []);
const savePlatforms = (list) => setStore({ [KEY_PLATFORMS]: list });
const getSettings = () =>
  getStore(KEY_SETTINGS, { autoEnabled: false, intervalHours: 6, notify: true });
const saveSettings = (s) => setStore({ [KEY_SETTINGS]: s });

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
  if (p.authMode === "cookie") return; // Cookie 模式：仅需站点地址 + 浏览器已登录该站点
  if (p.userId && !/^\d+$/.test(String(p.userId).trim()))
    throw new Error("请填写正确的 NewAPI 用户ID");
  if (!(p.accessToken || "").trim()) throw new Error("请填写访问令牌");
}

// 上游 NewAPI 鉴权错误码 → 友好中文提示（来源：QuantumNous/new-api middleware/auth.go）
const CODE_HINTS = {
  "AUTH_INSUFFICIENT_PRIVILEGE": "令牌校验通过，但该账号角色权限不足以调用签到接口（站点侧限制）。请确认填的是「个人设置」生成的系统访问令牌，而非「令牌管理」里的 API 令牌(sk-xxx)；若令牌正确则该账号无签到权限。",
  "AUTH_UNAUTHORIZED": "访问令牌无效或类型错误。请填「个人设置」页生成的系统访问令牌，而非「令牌管理」的 API 令牌。",
  "AUTH_USER_DISABLED": "该账号已被封禁。",
  "AUTH_TOKEN_EXPIRED": "登录会话已过期。",
  "AUTH_SESSION_REVOKED": "登录会话已被撤销。",
  "AUTH_USER_INVALID": "用户信息无效。",
};
// ---------- 核心：直连 NewAPI 签到接口 ----------
async function callCheckin(p, method = "GET", month) {
  validatePlatform(p);
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  if (p.authMode === "cookie") return await callViaTab(p, base, method, month);
  const url = new URL(base + "/api/user/checkin");
  const headers = { "Content-Type": "application/json" };
  const token = (p.accessToken || "").trim();
  if (token) headers["Authorization"] = "Bearer " + token;
  // 部分兼容站点需要通过 New-Api-User 指定用户ID
  const uid = String(p.userId || "").trim();
  if (uid && /^\d+$/.test(uid)) headers["New-Api-User"] = uid;

  const init = { method, headers, credentials: "omit" };
  if (method === "GET") {
    url.searchParams.set("month", month || currentMonth());
  }
  let res;
  try {
    res = await fetch(url.toString(), init);
  } catch (e) {
    throw new Error("网络请求失败：" + (e && e.message ? e.message : "无法连接站点"));
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("站点返回了无法解析的数据");
  }
  if (!res.ok || body.success === false) {
    const code = (body && body.code) || "";
    const hint = CODE_HINTS[code] || "";
    throw new Error((body.message || "请求失败（HTTP " + res.status + "）") + (hint ? " ｜ " + hint : ""));
  }
  if (!body.data || (method === "GET" && !body.data.stats))
    throw new Error("该站点不是兼容的 NewAPI 签到站点");
  return body;
}

// 上游返回校验（cookie/token 共用）
// strategy.triggerSelf=true 时，GET /api/user/self 成功即视为签到完成（不要求 stats）
function throwOnBadResult(result, method, strategy) {
  const body = result && result.body;
  const status = (result && result.status) || 0;
  if (!result || !result.ok) {
    const code = (body && body.code) || "";
    const hint = CODE_HINTS[code] || "";
    throw new Error((body && body.message) || ("请求失败（HTTP " + status + "）") + (hint ? " ｜ " + hint : ""));
  }
  if (!body) throw new Error("站点返回了无法解析的数据");
  if (body.success === false) {
    const code = body.code || "";
    const hint = CODE_HINTS[code] || "";
    throw new Error((body.message || "请求失败") + (hint ? " ｜ " + hint : ""));
  }
  // self 触发型：只要 success 即视为签到成功
  if (strategy && strategy.triggerSelf) {
    if (!body.data && body.success !== true && body.ret == null && body.code == null)
      throw new Error("该站点未返回有效用户数据");
    return body;
  }
  if (!body.data || (method === "GET" && !body.data.stats))
    throw new Error("该站点不是兼容的 NewAPI 签到站点");
  return body;
}

// 等待标签页加载完成（最长 12s）
function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, 12000);
  });
}

// 内容脚本内同源 fetch（自动携带站点登录 Cookie；MV3 无法在 SW 直接设 Cookie 头）
// 站点内的同源请求（自动携带登录 Cookie；含浏览器伪装头，绕过部分站点 UA/Referer 校验）
// args: [reqPath, method, month, userId, apiUserKey]
function tabFetchCheckin(reqPath, method, month, userId, apiUserKey, query) {
  return (async () => {
    const url = new URL(reqPath, location.origin);
    if (month) url.searchParams.set("month", month);
    if (query) for (const k of Object.keys(query)) url.searchParams.set(k, String(query[k]));
    const headers = {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    };
    if (userId) headers[(apiUserKey || "New-Api-User")] = String(userId);
    let res;
    try {
      res = await fetch(url.toString(), { method, headers, credentials: "include" });
    } catch (e) {
      return { ok: false, status: 0, body: { success: false, message: "网络请求失败：" + (e && e.message ? e.message : "无法连接站点") } };
    }
    let body = null;
    try { body = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body };
  })();
}

// Cookie 模式：复用已打开的同源标签页，没有则临时开一个后台标签页完成后关闭
// 平台签到策略：决定 Cookie 模式下用哪个路径/方法
// agentrouter.org 等站点无签到接口，GET /api/user/self 即触发签到（参考 millylee/anyrouter-check-in）
function cookieStrategy(p, base) {
  const h = (p && p.checkinPath || "").trim();
  if (h) {
    return {
      reqPath: h,
      reqMethod: (p.checkinMethod || "POST").toUpperCase(),
      apiUserKey: p.apiUserKey || "New-Api-User",
      triggerSelf: !!p.triggerSelf,
    };
  }
  // 默认与特殊站点
  if (/agentrouter\.org/i.test(base)) {
    return { reqPath: "/api/user/self", reqMethod: "GET", apiUserKey: "new-api-user", triggerSelf: true };
  }
  return { reqPath: "/api/user/checkin", reqMethod: "POST", apiUserKey: "New-Api-User", triggerSelf: false };
}

async function callViaTab(p, base, method, month) {
  const origin = new URL(base).origin;
  let tab = null;
  let createdTabId = null;
  const tabs = await chrome.tabs.query({ url: origin + "/*" }).catch(() => []);
  if (tabs && tabs.length) {
    tab = tabs.find((t) => t.url && !/\/(login|signin|register)/i.test(t.url)) || tabs[0];
  }
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: base, active: false });
      createdTabId = tab.id;
      await waitTabComplete(tab.id);
    } catch (e) {
      throw new Error("无法打开站点标签页：" + (e && e.message ? e.message : "未知错误"));
    }
  }
  try {
    let result;
    // Cookie 模式统一按平台策略决定路径/方法（agentrouter 等走 GET /api/user/self）
    const st = cookieStrategy(p, base);
    let reqUrl, reqMethod;
    if (st.triggerSelf) {
      reqUrl = st.reqPath;
      reqMethod = st.reqMethod; // GET
    } else if (method === "POST") {
      reqUrl = "/api/user/checkin";
      reqMethod = "POST";
    } else {
      reqUrl = "/api/user/checkin";
      reqMethod = "GET";
    }
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: tabFetchCheckin,
        args: [reqUrl, reqMethod, month || currentMonth() || null, String(p.userId || "").trim(), st.apiUserKey || null],
      });
      result = out && out[0] && out[0].result;
    } catch (e) {
      throw new Error("在站点标签页执行请求失败：" + (e && e.message ? e.message : "请先在浏览器登录该站点"));
    }
    return throwOnBadResult(result, reqMethod, st);
  } finally {
    if (createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
  }
}

// Cookie 模式通用同源请求：用于 /api/user/self、/api/log/self/stat 等
async function callViaTabRaw(p, base, reqPath, method, opts) {
  const origin = new URL(base).origin;
  let tab = null, createdTabId = null;
  const tabs = await chrome.tabs.query({ url: origin + "/*" }).catch(() => []);
  if (tabs && tabs.length) tab = tabs.find((t) => t.url && !/\/(login|signin|register)/i.test(t.url)) || tabs[0];
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: base, active: false });
      createdTabId = tab.id;
      await waitTabComplete(tab.id);
    } catch (e) {
      throw new Error("无法打开站点标签页：" + (e && e.message ? e.message : "未知错误"));
    }
  }
  try {
    let result;
    const apiUserKey = (opts && opts.apiUserKey) || "New-Api-User";
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: tabFetchCheckin,
        args: [reqPath, (method || "GET").toUpperCase(), opts && opts.month != null ? opts.month : null, String(p.userId || "").trim(), apiUserKey, opts && opts.query ? opts.query : null],
      });
      result = out && out[0] && out[0].result;
    } catch (e) {
      throw new Error("在站点标签页执行请求失败：" + (e && e.message ? e.message : "请先在浏览器登录该站点"));
    }
    const r = result || {};
    const body = r.body;
    if (!r.ok || (body && body.success === false)) {
      const code = (body && body.code) || "";
      const hint = CODE_HINTS[code] || "";
      throw new Error((body && body.message) || ("请求失败（HTTP " + r.status + "）") + (hint ? " ｜ " + hint : ""));
    }
    if (!body) throw new Error("站点返回了无法解析的数据");
    return body;
  } finally {
    if (createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
  }
}

// Token 模式通用请求（任意 path + query），headers 与签到一致
async function callApiPath(p, reqPath, method, opts) {
  validatePlatform(p);
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  const url = new URL(base + reqPath);
  if (opts && opts.month) url.searchParams.set("month", opts.month);
  if (opts && opts.query) for (const k of Object.keys(opts.query)) url.searchParams.set(k, String(opts.query[k]));
  const headers = { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*" };
  const token = (p.accessToken || "").trim();
  if (token) headers["Authorization"] = "Bearer " + token;
  const uid = String(p.userId || "").trim();
  if (uid && /^\d+$/.test(uid)) headers["New-Api-User"] = uid;
  let res;
  try {
    res = await fetch(url.toString(), { method, headers, credentials: "omit" });
  } catch (e) {
    throw new Error("网络请求失败：" + (e && e.message ? e.message : "无法连接站点"));
  }
  let body;
  try { body = await res.json(); } catch { throw new Error("站点返回了无法解析的数据"); }
  if (!res.ok || body.success === false) {
    const code = (body && body.code) || "";
    const hint = CODE_HINTS[code] || "";
    throw new Error((body.message || "请求失败（HTTP " + res.status + "）") + (hint ? " ｜ " + hint : ""));
  }
  return body;
}

// 按 authMode 分发：cookie 走 callViaTabRaw（自动用站点 apiUserKey），token 走 callApiPath
async function callApi(p, reqPath, method, opts) {
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  if (p.authMode === "cookie") {
    const st = cookieStrategy(p, base);
    const merged = Object.assign({ apiUserKey: st.apiUserKey }, opts || {});
    return await callViaTabRaw(p, base, reqPath, method, merged);
  }
  return await callApiPath(p, reqPath, method, opts);
}

// 签到
async function runCheckin(platform) {
  try {
    // agentrouter 等无专用签到接口的站点：GET /api/user/self 触发签到
    const isSelfTrigger = platform.authMode === "cookie" &&
      (/agentrouter\.org/i.test(platform.baseUrl || "") || !!platform.triggerSelf);
    const method = isSelfTrigger ? "GET" : "POST";
    const body = await callCheckin(platform, method);
    const awarded = body.data && body.data.quota_awarded;
    const uname = body.data && (body.data.username || body.data.display_name);
    let msg = body.message;
    if (!msg) {
      if (awarded != null) msg = "签到成功，获得额度 " + awarded;
      else if (isSelfTrigger) msg = (uname ? "用户「" + uname + "」" : "") + "信息请求成功，签到已自动完成";
      else msg = "签到请求成功";
    }
    return { ok: true, message: msg, data: body.data };
  } catch (e) {
    return { ok: false, message: e.message, error: e.message };
  }
}

// 统计（GET，也用于检测连接）
// 月份边界时间戳（秒）
function monthRangeTs(month) {
  const [y, m] = (month || currentMonth()).split("-");
  const Y = Number(y), M = Number(m);
  const start = Math.floor(new Date(Y, M - 1, 1, 0, 0, 0).getTime() / 1000);
  const end = Math.floor(new Date(Y, M, 1, 0, 0, 0).getTime() / 1000) - 1;
  return { start, end };
}

// 拉 /api/user/self 的账户数据（token 或 cookie 模式自适应）
// 分页累加月内所有日志的 prompt_tokens + completion_tokens（上游无现成 token 总数接口）
async function fetchMonthlyTokens(platform, month) {
  const { start, end } = monthRangeTs(month);
  let tokens = 0, total = null, page = 1, guard = 0, truncated = false;
  const per = 100;
  for (;;) {
    if (++guard > 40) { truncated = true; break; }
    let body;
    try {
      body = await callApi(platform, "/api/log/self", "GET", {
        query: { start_timestamp: start, end_timestamp: end, type: 0, p: page, per },
      });
    } catch (e) {
      return tokens > 0 ? { tokens, truncated: true } : null;
    }
    const data = body && body.data;
    let logs = null;
    if (Array.isArray(data)) logs = data;
    else if (data && Array.isArray(data.items)) { logs = data.items; if (total == null) total = data.total ?? null; }
    else if (data && Array.isArray(data.logs)) { logs = data.logs; if (total == null) total = data.total ?? null; }
    else if (data && Array.isArray(data.data)) { logs = data.data; }
    if (!logs) return tokens > 0 ? { tokens, truncated: true } : null;
    for (const it of logs) {
      tokens += Number(it.prompt_tokens || 0) + Number(it.completion_tokens || 0);
    }
    if (total == null) total = body.total ?? null;
    if (logs.length < per) break;
    if (total != null && page * per >= total) break;
    page++;
  }
  return { tokens, truncated };
}

async function fetchAccount(platform, month, reuseSelfData) {
  let selfData = reuseSelfData || null;
  let selfErr = "";
  if (!selfData) {
    try {
      const selfBody = await callApi(platform, "/api/user/self", "GET");
      selfData = (selfBody && selfBody.data) || null;
    } catch (e) { selfErr = e && e.message ? e.message : String(e); selfData = null; }
  }
  let monthlyTokens = null, tokensTruncated = false, tokenErr = "";
  try {
    const r = await fetchMonthlyTokens(platform, month);
    if (r) { monthlyTokens = r.tokens; tokensTruncated = !!r.truncated; }
    else tokenErr = "日志接口无数据";
  } catch (e) { tokenErr = e && e.message ? e.message : String(e); }
  if (!selfData && monthlyTokens == null) {
    throw new Error("获取账户额度失败：" + (selfErr || tokenErr || "账号接口不可用"));
  }
  const warn = tokensTruncated
    ? "本月Token为前若干页累计估算（超出截断）"
    : (monthlyTokens == null ? "本月Token接口不可用" : "");
  return {
    available: selfData ? selfData.quota : null,
    used: selfData ? selfData.used_quota : null,
    requestCount: selfData ? selfData.request_count : null,
    monthlyTokens,
    tokensTruncated,
    displayName: selfData ? (selfData.display_name || selfData.username) : null,
    _warn: warn,
  };
}

async function runStats(platform, month) {
  const base = (platform.baseUrl || "").trim().replace(/\/+$/, "");
  const isCookieSelf = platform.authMode === "cookie" && (/agentrouter\.org/i.test(base) || !!platform.triggerSelf);
  try {
    const body = await callCheckin(platform, "GET", month);
    const account = await fetchAccount(platform, month || currentMonth(), isCookieSelf && body.data ? body.data : null);
    return { ok: true, message: body.message || "统计数据已更新", data: body.data, account };
  } catch (e) {
    try {
      const account = await fetchAccount(platform, month || currentMonth(), null);
      if (account) return { ok: true, message: "额度已更新（签到统计不可用）", data: null, account };
    } catch {}
    return { ok: false, message: e.message, error: e.message };
  }
}

// 把统计/结果合并回单个 platform 对象
function mergeStats(platform, data, message, ok) {
  const next = { ...platform };
  next.message = message || next.message;
  next.error = ok ? "" : message;
  if (data) {
    next.stats = data.stats || next.stats || {};
    next.enabled = data.enabled;
    if (data.max_quota != null) next.stats.max_quota = data.max_quota;
    if (data.min_quota != null) next.stats.min_quota = data.min_quota;
  }
  return next;
}

// 分类签到结果：成功 / 今日已签到 / 失败
function classify(result) {
  if (result.ok) return "ok";
  const m = (result.message || "").toLowerCase();
  if (m.includes("已签到") || m.includes("已经") || m.includes("already") || m.includes("今日"))
    return "already";
  return "fail";
}

// ---------- 批量/自动签到（Service Worker 内执行，可脱离弹窗） ----------
async function runAutoCheckin(triggeredByUser = false) {
  const settings = await getSettings();
  if (!settings.autoEnabled && !triggeredByUser) return { skipped: true };
  const platforms = await getPlatforms();
  if (!platforms.length) return { skipped: true };
  // 并发签到：所有平台同时发起，互不等待（cookie 模式各站独立复用各自标签页，无冲突）
  const results = await Promise.all(platforms.map((p) => runCheckin(p)));
  let ok = 0, already = 0, fail = 0;
  const list = [];
  const cur = await getPlatforms();
  for (let i = 0; i < platforms.length; i++) {
    const r = results[i];
    const kind = classify(r);
    if (kind === "ok") ok++;
    else if (kind === "already") already++;
    else fail++;
    list.push({ id: platforms[i].id, name: platforms[i].name, ok: r.ok, message: r.message, kind });
    // 回写状态（统一一次落盘，避免并发读写竞争）
    const idx = cur.findIndex((x) => x.id === platforms[i].id);
    if (idx >= 0) {
      cur[idx].message = r.message;
      cur[idx].error = r.ok ? "" : r.message;
      cur[idx].lastCheckinAt = new Date().toISOString();
      // 跨天"今日已签到"锚点：成功或提示已签到即标记今天
      if (r.ok || /已签到|已经|already|今日|重复/i.test(r.message || "")) {
        cur[idx].stats = cur[idx].stats || {};
        cur[idx].stats.checked_in_today = true;
        cur[idx].statsDate = todayStr();
      }
    }
  }
  await savePlatforms(cur);
  const summary = {
    time: new Date().toISOString(),
    ok,
    already,
    fail,
    total: platforms.length,
    list,
  };
  await setStore({ [KEY_LASTAUTO]: summary });
  if (settings.notify !== false) {
    const title = (triggeredByUser ? "手动" : "自动") + "签到完成";
    notify(
      title,
      `共 ${summary.total} 个站点：成功 ${ok}，已签 ${already}，失败 ${fail}`,
    );
  }
  return summary;
}

function notify(title, message) {
  try {
    chrome.notifications.create("nacheckin-" + Date.now(), {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      priority: 2,
    });
  } catch (e) {
    /* 通知不可用时静默 */
  }
}

// ---------- 消息总线（popup <-> SW） ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "stats" || msg.type === "test") {
        const r = await runStats(msg.platform, msg.month);
        sendResponse(r);
      } else if (msg.type === "account") {
        try {
          const acc = await fetchAccount(msg.platform, msg.month || currentMonth(), null);
          const warn = acc && acc._warn ? acc._warn : "";
          sendResponse({ ok: true, message: warn ? "额度已更新（" + warn + "）" : "额度已更新", account: acc });
        } catch (e) {
          sendResponse({ ok: false, message: e && e.message ? e.message : "无法获取账户额度" });
        }
      } else if (msg.type === "checkin") {
        const r = await runCheckin(msg.platform);
        sendResponse(r);
      } else if (msg.type === "autoRun") {
        const summary = await runAutoCheckin(true);
        sendResponse({ ok: true, summary });
      } else if (msg.type === "getSettings") {
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (msg.type === "saveSettings") {
        await saveSettings(msg.settings || {});
        await syncAlarm();
        sendResponse({ ok: true, settings: msg.settings });
      } else if (msg.type === "getLastAuto") {
        const last = await getStore(KEY_LASTAUTO, null);
        sendResponse({ ok: true, last });
      } else {
        sendResponse({ ok: false, message: "未知请求" });
      }
    } catch (e) {
      sendResponse({ ok: false, message: e && e.message ? e.message : String(e) });
    }
  })();
  return true; // 异步响应
});

// ---------- 定时任务 ----------
async function syncAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (s.autoEnabled) {
    const minutes = Math.max(1, Number(s.intervalHours) * 60 || 360);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
  }
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_NAME) runAutoCheckin(false).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  // 浏览器启动时若已开启自动签到，补执行一次
  getSettings().then((s) => {
    if (s.autoEnabled) runAutoCheckin(false).catch(() => {});
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  await syncAlarm();
  await savePlatforms(await getPlatforms()); // 初始化存储键
});
// ---------- 侧边栏（Edge sidePanel API） ----------
// 点击工具栏图标打开侧边栏；setPanelBehavior 不可用时由 onClicked 兜底。
function setupSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  }
}
setupSidePanel();
chrome.runtime.onInstalled.addListener(setupSidePanel);
chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});
