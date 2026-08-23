// ===== NewAPI 中转站一键签到 - 后台 Service Worker =====
// 原理：直接用 host 权限跨域调用目标站 /api/user/checkin，无需任何服务端代理。
//   GET  /api/user/checkin?month=YYYY-MM  -> 获取签到开关/额度上下限/本月统计
//   POST /api/user/checkin               -> 执行当日签到
//   鉴权：Authorization: Bearer <系统访问令牌/PAT>，令牌唯一标识用户。

const KEY_PLATFORMS = "nacheckin.platforms";
const KEY_SETTINGS = "nacheckin.settings";
const KEY_LASTAUTO = "nacheckin.lastAuto";
const KEY_AUTOSTATE = "nacheckin.autoState";
const KEY_AGENTROUTER_REAUTH = "nacheckin.agentRouterReauth";
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
  getStore(KEY_SETTINGS, { autoEnabled: false, autoTime: "08:01", autoApprove: false, notify: true });
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
async function callCheckin(p, method = "GET", month, opts) {
  validatePlatform(p);
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  if (p.authMode === "cookie") return await callViaTab(p, base, method, month, opts);
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
    chrome.tabs.get(tabId).then((tab) => { if (tab && tab.status === "complete") finish(); }).catch(finish);
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
      "Cache-Control": "no-store",
    };
    if ((method || "GET").toUpperCase() !== "GET") headers["Content-Type"] = "application/json";
    if (userId) headers[(apiUserKey || "New-Api-User")] = String(userId);
    let res;
    try {
      res = await fetch(url.toString(), { method, headers, credentials: "include" });
    } catch (e) {
      return { ok: false, status: 0, body: { success: false, message: "网络请求失败：" + (e && e.message ? e.message : "无法连接站点") } };
    }
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    const htmlResponse = contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text);
    if (!body && htmlResponse) {
      body = { success: false, message: "登录会话已失效或站点触发了安全验证，请打开目标站点重新登录或完成验证后重试" };
    } else if (!body) {
      body = { success: false, message: text ? "站点返回了非 JSON 数据，请稍后重试" : "站点返回了空响应，请稍后重试" };
    }
    return { ok: res.ok, status: res.status, body, htmlResponse };
  })();
}

// agentrouter.org 需要重新建立登录会话后才会激活签到额度。
function tabLogout() {
  return (async () => {
    try {
      let userId = "-1";
      try {
        const user = JSON.parse(localStorage.getItem("user") || "null");
        if (user && user.id != null) userId = String(user.id);
      } catch {}
      const res = await fetch("/api/user/logout", {
        method: "GET",
        credentials: "include",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Cache-Control": "no-store",
          "New-API-User": userId,
        },
      });
      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
      if (!body && (contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text))) {
        body = { success: false, message: "登出请求被站点安全验证拦截" };
      } else if (!body && text) {
        body = { success: false, message: "登出接口返回了非 JSON 数据" };
      }
      if (res.ok && !(body && body.success === false)) {
        try { localStorage.removeItem("user"); } catch {}
      }
      return { ok: res.ok && !(body && body.success === false), status: res.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: { success: false, message: e && e.message ? e.message : "登出请求失败" } };
    }
  })();
}

function tabBuildGithubOauthUrl() {
  return (async () => {
    try {
      let status = null;
      try { status = JSON.parse(localStorage.getItem("status") || "null"); } catch {}
      if (!status || !status.github_client_id) {
        const statusRes = await fetch("/api/status", {
          credentials: "include",
          headers: { "Accept": "application/json, text/plain, */*", "Cache-Control": "no-store" },
        });
        const statusBody = await statusRes.json();
        status = statusBody && statusBody.data;
      }
      const clientId = status && status.github_client_id;
      if (!clientId) return { ok: false, message: "站点未提供 GitHub OAuth 配置" };
      const params = new URLSearchParams();
      const aff = localStorage.getItem("aff");
      if (aff) params.set("aff", aff);
      params.set("mode", "login");
      const stateRes = await fetch("/api/oauth/state?" + params.toString(), {
        credentials: "include",
        headers: { "Accept": "application/json, text/plain, */*", "Cache-Control": "no-store" },
      });
      const stateBody = await stateRes.json();
      if (!stateRes.ok || !stateBody || stateBody.success === false || !stateBody.data)
        return { ok: false, message: stateBody && stateBody.message ? stateBody.message : "无法生成 GitHub 登录状态" };
      localStorage.setItem("oauth_mode", "login");
      return {
        ok: true,
        url: "https://github.com/login/oauth/authorize?client_id=" + encodeURIComponent(clientId) +
          "&state=" + encodeURIComponent(stateBody.data) + "&scope=user%3Aemail",
      };
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : "无法启动 GitHub 登录" };
    }
  })();
}

function tabCheckAgentRouterLogin(configuredUserId) {
  return (async () => {
    try {
      let userId = String(configuredUserId || "-1");
      try {
        const user = JSON.parse(localStorage.getItem("user") || "null");
        if (user && user.id != null) userId = String(user.id);
      } catch {}
      const res = await fetch("/api/user/self", {
        method: "GET",
        credentials: "include",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Cache-Control": "no-store",
          "New-API-User": userId,
        },
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
      return { ok: res.ok && !!(body && body.success !== false && body.data), body };
    } catch {
      return { ok: false };
    }
  })();
}

async function startAgentRouterGithubReauth(base, userId) {
  const old = await getStore(KEY_AGENTROUTER_REAUTH, null);
  if (old && old.tabId != null) await chrome.tabs.remove(old.tabId).catch(() => {});
  const tab = await chrome.tabs.create({ url: base + "/login", active: true });
  await setStore({
    [KEY_AGENTROUTER_REAUTH]: {
      tabId: tab.id,
      base,
      origin: new URL(base).origin,
      userId: String(userId || ""),
      githubClicked: false,
      createdAt: Date.now(),
    },
  });
  await waitTabComplete(tab.id);
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  handleAgentRouterReauthTab(tab.id, current && current.url).catch(() => {});
  return tab;
}

const agentRouterReauthProcessing = new Set();
async function handleAgentRouterReauthTab(tabId, tabUrl) {
  const pending = await getStore(KEY_AGENTROUTER_REAUTH, null);
  if (!pending || pending.tabId !== tabId || agentRouterReauthProcessing.has(tabId)) return;
  // 六分钟仍未完成通常意味着 GitHub 要求用户输入凭据/验证码；保留页面，不再自动关闭。
  if (Date.now() - Number(pending.createdAt || 0) > 6 * 60 * 1000) {
    await setStore({ [KEY_AGENTROUTER_REAUTH]: null });
    return;
  }
  agentRouterReauthProcessing.add(tabId);
  try {
    const url = String(tabUrl || "");
    if (!url.startsWith(pending.origin + "/") && url !== pending.origin) return;
    if (/\/login(?:[/?#]|$)/i.test(url)) {
      if (pending.githubClicked) return;
      let oauth = null;
      try {
        const out = await chrome.scripting.executeScript({ target: { tabId }, func: tabBuildGithubOauthUrl });
        oauth = out && out[0] && out[0].result;
      } catch {}
      if (oauth && oauth.ok && oauth.url) {
        const updated = await chrome.tabs.update(tabId, { url: oauth.url, active: true }).catch(() => null);
        if (updated) {
          pending.githubClicked = true;
          await setStore({ [KEY_AGENTROUTER_REAUTH]: pending });
        }
      } else {
        notify("Agent Router 自动登录未启动", (oauth && oauth.message) || "请在登录页手动点击「使用 GitHub 继续」");
      }
      return;
    }
    // OAuth 回到 Agent Router 后，给前端一点时间写入 localStorage 和登录 Cookie。
    let loggedIn = false;
    for (let i = 0; i < 8 && !loggedIn; i++) {
      if (i) await wait(1200);
      try {
        const out = await chrome.scripting.executeScript({ target: { tabId }, func: tabCheckAgentRouterLogin, args: [pending.userId || ""] });
        loggedIn = !!(out && out[0] && out[0].result && out[0].result.ok);
      } catch {}
    }
    if (!loggedIn) return;
    await chrome.tabs.update(tabId, { url: pending.base + "/", active: true }).catch(() => {});
    await waitTabComplete(tabId);
    await wait(1800);
    await chrome.tabs.remove(tabId).catch(() => {});
    await setStore({ [KEY_AGENTROUTER_REAUTH]: null });
  } finally {
    agentRouterReauthProcessing.delete(tabId);
  }
}

// 在目标站点页面内完成 Turnstile 验证，再用同一页面上下文提交签到。
// Turnstile site key 受域名限制，不能在 Service Worker 或扩展页面中渲染。
function tabFetchTurnstileCheckin(accessToken, userId) {
  return new Promise((resolve) => {
    const overlayId = "__nacheckin_turnstile_overlay";
    const old = document.getElementById(overlayId);
    if (old) old.remove();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const el = document.getElementById(overlayId);
      if (el) el.remove();
      resolve(value);
    };
    const fail = (message, verified = false) => finish({ ok: false, status: 0, body: { success: false, message }, verified });
    const overlay = document.createElement("div");
    overlay.id = overlayId;
    overlay.style.cssText = "position:fixed;z-index:2147483647;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif;color:#1f2937";
    const card = document.createElement("div");
    card.style.cssText = "width:min(420px,calc(100vw - 32px));background:#fff;border-radius:12px;padding:24px;box-shadow:0 16px 48px rgba(0,0,0,.3);text-align:center";
    const title = document.createElement("div");
    title.textContent = "请完成安全验证后签到";
    title.style.cssText = "font-size:18px;font-weight:600;margin-bottom:8px";
    const hint = document.createElement("div");
    hint.textContent = "验证通过后将自动提交签到，请不要关闭此页面。";
    hint.style.cssText = "color:#6b7280;margin-bottom:16px";
    const widget = document.createElement("div");
    widget.style.cssText = "display:flex;justify-content:center;min-height:65px";
    card.append(title, hint, widget);
    overlay.appendChild(card);
    (document.body || document.documentElement).appendChild(overlay);

    const headers = { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*" };
    if (accessToken) headers.Authorization = "Bearer " + accessToken;
    if (userId && /^\d+$/.test(String(userId))) headers["New-Api-User"] = String(userId);
    let submitted = false;
    const submit = async (token) => {
      if (submitted) return;
      submitted = true;
      try {
        const res = await fetch("/api/user/checkin?turnstile=" + encodeURIComponent(token), {
          method: "POST", headers, credentials: "include",
        });
        let body = null;
        try { body = await res.json(); } catch {}
        finish({ ok: res.ok, status: res.status, body, verified: true });
      } catch (e) {
        fail("签到请求失败：" + (e && e.message ? e.message : "无法连接站点"), true);
      }
    };
    const render = (siteKey) => {
      if (!siteKey) return fail("站点未返回 Turnstile site key");
      if (!window.turnstile || typeof window.turnstile.render !== "function") return fail("Turnstile 组件加载失败，请刷新页面重试");
      try {
        window.turnstile.render(widget, {
          sitekey: siteKey,
          callback: (token) => submit(token),
          "error-callback": () => fail("Turnstile 验证失败，请刷新页面重试"),
          "expired-callback": () => fail("Turnstile 验证已过期，请刷新页面重试"),
        });
      } catch (e) {
        fail("Turnstile 初始化失败：" + (e && e.message ? e.message : "未知错误"));
      }
    };
    const load = (siteKey) => {
      if (window.turnstile) return render(siteKey);
      let script = document.querySelector('script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]');
      if (!script) {
        script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      const started = Date.now();
      const poll = () => {
        if (window.turnstile) return render(siteKey);
        if (Date.now() - started > 15000) return fail("Turnstile 组件加载超时，请刷新页面重试");
        setTimeout(poll, 200);
      };
      poll();
    };
    fetch("/api/status", { credentials: "include" })
      .then((r) => r.json())
      .then((body) => load(body && body.data && body.data.turnstile_site_key))
      .catch(() => fail("无法读取站点 Turnstile 配置"));
    setTimeout(() => fail("等待 Turnstile 验证超时"), 120000);
  });
}

function isTurnstileMissingMessage(message) {
  return /Turnstile\s*(?:token\s*)?(?:为空|empty|missing)|turnstile token is empty/i.test(String(message || ""));
}

async function runTurnstileCheckin(platform) {
  validatePlatform(platform);
  const base = (platform.baseUrl || "").trim().replace(/\/+$/, "");
  const origin = new URL(base).origin;
  let tab = null;
  let createdTabId = null;
  const tabs = await chrome.tabs.query({ url: origin + "/*" }).catch(() => []);
  if (tabs && tabs.length) tab = tabs.find((t) => t.url && !/(login|signin|register)/i.test(t.url)) || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: base, active: true });
    createdTabId = tab.id;
  }
  if (tab && tab.id != null) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  if (tab && tab.id != null && ((createdTabId != null && tab.status !== "complete") || (createdTabId == null && tab.status && tab.status !== "complete"))) await waitTabComplete(tab.id);
  let result;
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: tabFetchTurnstileCheckin,
      args: [platform.authMode === "cookie" ? "" : String(platform.accessToken || "").trim(), String(platform.userId || "").trim()],
    });
    result = out && out[0] && out[0].result;
  } catch (e) {
    throw new Error("无法在站点页面启动 Turnstile 验证：" + (e && e.message ? e.message : "请先打开目标站点"));
  }
  const verified = !!(result && result.verified);
  try {
    return throwOnBadResult(result, "POST", { triggerSelf: false });
  } finally {
    if (verified && createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
  }
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

async function callViaTab(p, base, method, month, opts) {
  const origin = new URL(base).origin;
  let tab = null;
  let createdTabId = null;
  let keepCreatedTab = false;
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
        args: [reqUrl, reqMethod, st.triggerSelf ? null : (month || currentMonth() || null), String(p.userId || "").trim(), st.apiUserKey || null],
      });
      result = out && out[0] && out[0].result;
    } catch (e) {
      throw new Error("在站点标签页执行请求失败：" + (e && e.message ? e.message : "请先在浏览器登录该站点"));
    }
    if (result && result.htmlResponse && /agentrouter\.org/i.test(base)) {
      // WAF 挑战只有在真实页面导航中才会执行；fetch 拿到挑战 HTML 时先打开接口页，完成挑战后重试一次。
      try {
        await chrome.tabs.update(tab.id, { url: new URL(reqUrl, base).toString(), active: true });
        await wait(5000);
        await chrome.tabs.update(tab.id, { url: base, active: true });
        await waitTabComplete(tab.id);
      } catch {}
      try {
        const retry = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: tabFetchCheckin,
          args: [reqUrl, reqMethod, st.triggerSelf ? null : (month || currentMonth() || null), String(p.userId || "").trim(), st.apiUserKey || null],
        });
        result = retry && retry[0] && retry[0].result;
      } catch {}
    }
    if (result && result.htmlResponse && /agentrouter\.org/i.test(base)) {
      await chrome.tabs.update(tab.id, { url: base + "/login", active: true }).catch(() => {});
      keepCreatedTab = true;
    }
    const body = throwOnBadResult(result, reqMethod, st);
    if (opts && opts.reauth && st.triggerSelf && /agentrouter\.org/i.test(base)) {
      let logoutResult = null;
      try {
        const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: tabLogout });
        logoutResult = out && out[0] && out[0].result;
      } catch {}
      let reauthTab = null;
      try { reauthTab = await startAgentRouterGithubReauth(base, p.userId); } catch {}
      body._reauthRequired = true;
      body._logoutOk = !!(logoutResult && logoutResult.ok);
      body._githubLoginStarted = !!(reauthTab && reauthTab.id != null);
    }
    return body;
  } finally {
    if (createdTabId != null && !keepCreatedTab) await chrome.tabs.remove(createdTabId).catch(() => {});
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
async function runCheckin(platform, options) {
  try {
    // agentrouter 等无专用签到接口的站点：GET /api/user/self 触发签到
    const isSelfTrigger = platform.authMode === "cookie" &&
      (/agentrouter\.org/i.test(platform.baseUrl || "") || !!platform.triggerSelf);
    const method = isSelfTrigger ? "GET" : "POST";
    let body;
    try {
      body = await callCheckin(platform, method, null, {
        reauth: !!(options && options.reauth),
      });
    } catch (e) {
      if (!isTurnstileMissingMessage(e && e.message)) throw e;
      body = await runTurnstileCheckin(platform);
    }
    let data = body.data;
    // 部分兼容站点的 POST 只返回奖励额度；追加一次只读 GET，补齐本月统计。
    if (!isSelfTrigger && !(data && data.stats)) {
      try {
        const statsBody = await callCheckin(platform, "GET", currentMonth());
        if (statsBody && statsBody.data) data = { ...(data || {}), ...statsBody.data };
      } catch {
        // 签到已经成功，统计接口不可用时保留签到结果，不将整体降级为失败。
      }
    }
    const awarded = data && data.quota_awarded;
    const uname = data && (data.username || data.display_name);
    let msg = body.message;
    if (body._reauthRequired) {
      if (body._githubLoginStarted) {
        msg = "签到成功，正在通过 GitHub 自动重新登录；完成后临时页面会自动关闭";
      } else {
        msg = body._logoutOk
          ? "签到成功，请在 Agent Router 登录页使用 GitHub 重新登录以激活额度"
          : "签到已提交，请退出并重新登录 Agent Router 以激活额度";
      }
    } else if (isSelfTrigger && !(options && options.reauth)) {
      msg = (msg || "签到成功") + "；请退出并重新登录 Agent Router 以激活额度";
    }
    if (!msg) {
      if (awarded != null) msg = "签到成功，获得额度 " + awarded;
      else if (isSelfTrigger) msg = (uname ? "用户「" + uname + "」" : "") + "信息请求成功，签到已自动完成";
      else msg = "签到请求成功";
    }
    return {
      ok: true,
      message: msg,
      data,
      reauthRequired: !!body._reauthRequired,
      githubLoginStarted: !!body._githubLoginStarted,
    };
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
  if (isAlreadyCheckinMessage(result.message))
    return "already";
  return "fail";
}

function isAlreadyCheckinMessage(message) {
  return /已签到|已经签到|签到过|重复签到|already\s+(?:checked\s+in|signed\s+in|today)|today\s+already/i.test(String(message || ""));
}

// ---------- 批量/自动签到（Service Worker 内执行，可脱离弹窗） ----------
async function runAutoCheckin(triggeredByUser = false, selectedPlatforms = null) {
  const settings = await getSettings();
  if (!settings.autoEnabled && !triggeredByUser) return { skipped: true };
  const platforms = selectedPlatforms || await getPlatforms();
  if (!platforms.length) return { skipped: true };
  // 并发签到：所有平台同时发起，互不等待（cookie 模式各站独立复用各自标签页，无冲突）
  const results = await Promise.all(platforms.map((p) => runCheckin(p, { reauth: true })));
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
      // 跨天"今日已签到"锚点：成功或站点明确提示重复签到即标记今天
      if (r.ok || isAlreadyCheckinMessage(r.message)) {
        cur[idx].stats = cur[idx].stats || {};
        if (r.data && r.data.stats) Object.assign(cur[idx].stats, r.data.stats);
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

function autoTimeReached(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ""));
  if (!m) return false;
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= Number(m[1]) * 60 + Number(m[2]);
}

async function findUncheckedPlatforms(platforms) {
  const results = await Promise.all(platforms.map(async (p) => {
    if (p.stats && p.stats.checked_in_today && p.statsDate === todayStr()) return null;
    try {
      const body = await callCheckin(p, "GET", currentMonth());
      if (body && body.data && body.data.stats && body.data.stats.checked_in_today) return null;
    } catch {
      // 只读状态不可用时仍尝试签到，由签到接口返回最终结果。
    }
    return p;
  }));
  return results.filter(Boolean);
}

async function saveAutoState(date, state) {
  await setStore({ [KEY_AUTOSTATE]: { date, state } });
}

function autoConfirmNotificationId(date) {
  return "nacheckin-confirm-" + date;
}

async function checkScheduledAuto() {
  const settings = await getSettings();
  if (!settings.autoEnabled || !autoTimeReached(settings.autoTime || "08:01")) return { skipped: true };
  const date = todayStr();
  const state = await getStore(KEY_AUTOSTATE, null);
  if (state && state.date === date && state.state !== "pending") return { skipped: true };
  if (state && state.date === date && state.state === "pending") return { pending: true };

  const platforms = await getPlatforms();
  if (!platforms.length) {
    await saveAutoState(date, "done");
    return { skipped: true };
  }
  const unchecked = await findUncheckedPlatforms(platforms);
  if (!unchecked.length) {
    await saveAutoState(date, "done");
    return { skipped: true, already: true };
  }
  if (settings.autoApprove) {
    await saveAutoState(date, "approved");
    await runAutoCheckin(false, unchecked);
    await saveAutoState(date, "done");
    return { started: true, automatic: true };
  }
  await saveAutoState(date, "pending");
  const id = autoConfirmNotificationId(date);
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "到达自动签到时间",
    message: "今天还有站点未签到，是否立即执行一键签到？",
    priority: 2,
    buttons: [{ title: "允许签到" }, { title: "跳过今天" }],
  }).catch(() => {});
  return { pending: true };
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

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (!notificationId.startsWith("nacheckin-confirm-")) return;
  const date = notificationId.slice("nacheckin-confirm-".length);
  await chrome.notifications.clear(notificationId).catch(() => {});
  if (buttonIndex !== 0) {
    await saveAutoState(date, "declined");
    return;
  }
  const settings = await getSettings();
  if (!settings.autoEnabled || date !== todayStr()) return;
  const unchecked = await findUncheckedPlatforms(await getPlatforms());
  await saveAutoState(date, "approved");
  if (unchecked.length) await runAutoCheckin(false, unchecked);
  await saveAutoState(date, "done");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && !changeInfo.url) return;
  handleAgentRouterReauthTab(tabId, changeInfo.url || (tab && tab.url) || "").catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getStore(KEY_AGENTROUTER_REAUTH, null).then((pending) => {
    if (pending && pending.tabId === tabId) return setStore({ [KEY_AGENTROUTER_REAUTH]: null });
  }).catch(() => {});
});

// Service Worker 休眠后恢复时，继续接管尚未完成的 OAuth 临时标签页。
getStore(KEY_AGENTROUTER_REAUTH, null).then(async (pending) => {
  if (!pending || pending.tabId == null) return;
  const tab = await chrome.tabs.get(pending.tabId).catch(() => null);
  if (!tab) return setStore({ [KEY_AGENTROUTER_REAUTH]: null });
  handleAgentRouterReauthTab(tab.id, tab.url || "").catch(() => {});
}).catch(() => {});

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
        const r = await runCheckin(msg.platform, { reauth: msg.reauth !== false });
        sendResponse(r);
      } else if (msg.type === "autoRun") {
        const summary = await runAutoCheckin(true);
        sendResponse({ ok: true, summary });
      } else if (msg.type === "getSettings") {
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (msg.type === "saveSettings") {
        await saveSettings(msg.settings || {});
        await syncAlarm();
        if (msg.settings && msg.settings.autoEnabled) checkScheduledAuto().catch(() => {});
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
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_NAME) checkScheduledAuto().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  // 浏览器当天首次启动时，按用户设定时间补检一次。
  getSettings().then((s) => {
    if (s.autoEnabled) checkScheduledAuto().catch(() => {});
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  await syncAlarm();
  await savePlatforms(await getPlatforms()); // 初始化存储键
});
// ---------- 侧边栏（Chrome / Edge sidePanel API） ----------
// 优先让浏览器原生处理工具栏点击；API 不可用时退化为宽屏管理页。
async function setupSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      return true;
    } catch {}
  }
  return false;
}
let sidePanelReady = setupSidePanel();
chrome.runtime.onInstalled.addListener(() => {
  sidePanelReady = setupSidePanel();
});
chrome.action.onClicked.addListener(async (tab) => {
  // setPanelBehavior 成功时，Chrome / Edge 会自行打开侧边栏。
  if (await sidePanelReady) return;
  if (chrome.sidePanel && chrome.sidePanel.open && tab && tab.windowId != null) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    } catch {}
  }
  // 较旧的 Chrome 或其他 Chromium 浏览器没有 sidePanel 时仍可正常使用。
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") }).catch(() => {});
});
