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
  if (p.authMode === "agentrouter_token" && !/^\d+$/.test(String(p.userId || "").trim()))
    throw new Error("Agent Router 签到模式必须填写数字用户ID");
  if (p.authMode === "agentrouter_token") return;
  if (!(p.accessToken || "").trim()) throw new Error("请填写访问令牌");
}

function isAgentRouterTokenMode(p) {
  return !!p && p.authMode === "agentrouter_token";
}

function isAgentRouterGithubMode(p) {
  return isAgentRouterTokenMode(p) ||
    (!!p && p.authMode === "cookie" && /agentrouter\.org/i.test(String(p.baseUrl || "")));
}

function isSelfTriggerMode(p) {
  const base = String((p && p.baseUrl) || "");
  return isAgentRouterTokenMode(p) ||
    (!!p && p.authMode === "cookie" && (/agentrouter\.org|ps\.air-outer\.com/i.test(base) || !!p.triggerSelf));
}

function verifyConfiguredUser(p, body) {
  const configured = String((p && p.userId) || "").trim();
  const actual = body && body.data && body.data.id != null ? String(body.data.id) : "";
  if (configured && actual && configured !== actual) {
    throw new Error("当前 Agent Router 用户ID为 " + actual + "，与配置的 " + configured + " 不一致");
  }
  return body;
}

async function isAgentRouterReauthPending(p) {
  if (!isAgentRouterGithubMode(p)) return false;
  const pending = await getStore(KEY_AGENTROUTER_REAUTH, null);
  if (!pending || !pending.origin || Date.now() - Number(pending.createdAt || 0) > 6 * 60 * 1000) return false;
  try { return pending.origin === new URL(p.baseUrl).origin; }
  catch { return false; }
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
  if (isAgentRouterGithubMode(p)) {
    if (opts && opts.reauth) return await runAgentRouterGithubCheckin(p, base);
    const account = await callAgentRouterAccountViaTab(p, base);
    if (account.warning) account.body._accountWarn = account.warning;
    return account.body;
  }
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

async function getAgentRouterPage(base) {
  const origin = new URL(base).origin;
  const tabs = await chrome.tabs.query({ url: origin + "/*" }).catch(() => []);
  let tab = tabs && tabs.find((t) => t.url && !/\/(login|signin|register)/i.test(t.url));
  let createdTabId = null;
  if (!tab) {
    tab = await chrome.tabs.create({ url: base, active: false }).catch(() => null);
    if (!tab) throw new Error("无法打开 Agent Router 标签页");
    createdTabId = tab.id;
    await waitTabComplete(tab.id);
  } else if (tab.status && tab.status !== "complete") {
    await waitTabComplete(tab.id);
  }
  return { tab, createdTabId };
}

async function callAgentRouterAccountViaTab(p, base) {
  const { tab, createdTabId } = await getAgentRouterPage(base);
  let result = null;
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: tabFetchAgentRouterAccount,
      args: [String(p.userId || "").trim()],
    });
    result = out && out[0] && out[0].result;
  } catch (e) {
    throw new Error("无法在 Agent Router 页面读取账户额度：" + (e && e.message ? e.message : "页面脚本执行失败"));
  } finally {
    if (createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
  }

  if (result && result.userMismatch) {
    throw new Error("当前浏览器登录的 Agent Router 用户ID为 " + result.actualUserId + "，与配置的 " + result.configuredUserId + " 不一致");
  }
  if (result && result.ok && result.body && result.body.data) {
    verifyConfiguredUser(p, result.body);
    return {
      body: result.body,
      warning: result.usedCachedAccount
        ? "用户接口连续返回异常零值，当前额度来自最近一次登录数据"
        : "",
    };
  }
  if (result && result.cachedUser) {
    const body = { success: true, data: result.cachedUser };
    verifyConfiguredUser(p, body);
    return { body, warning: "用户接口返回异常，当前额度来自最近一次登录数据" };
  }

  const detail = result && result.message ? result.message : "网站未返回账户数据";
  throw new Error("获取账户额度失败：" + detail);
}

// Agent Router 的当前前端在 OAuth/密码登录响应中通过 data.checked_in 返回签到结果。
// 正确流程是退出当前 Cookie 会话后重新登录，不需要预先用访问令牌请求 /api/user/self。
async function runAgentRouterGithubCheckin(p, base) {
  const { tab, createdTabId } = await getAgentRouterPage(base);
  let storedUser = null;
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: tabReadAgentRouterStoredUser,
    });
    storedUser = out && out[0] && out[0].result;
  } catch {}
  const configured = String(p.userId || "").trim();
  const actual = storedUser && storedUser.id != null ? String(storedUser.id) : "";
  if (configured && actual && configured !== actual) {
    if (createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
    throw new Error("当前浏览器登录的 Agent Router 用户ID为 " + actual + "，与配置的 " + configured + " 不一致");
  }

  let logoutResult = null;
  try {
    const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: tabLogout });
    logoutResult = out && out[0] && out[0].result;
  } catch {}
  if (createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
  if (storedUser && !logoutResult?.ok) {
    throw new Error((logoutResult && logoutResult.body && logoutResult.body.message) || "Agent Router 退出失败，无法开始重新登录签到");
  }

  let reauthTab = null;
  try { reauthTab = await startAgentRouterGithubReauth(base, p.userId); } catch {}
  if (!reauthTab) throw new Error("Agent Router GitHub 登录页启动失败");
  return {
    success: true,
    message: "已退出 Agent Router，正在通过 GitHub 重新登录并签到",
    data: storedUser || { id: configured || null },
    _reauthRequired: true,
    _logoutOk: !storedUser || !!(logoutResult && logoutResult.ok),
    _githubLoginStarted: true,
  };
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

function tabReadAgentRouterStoredUser() {
  try {
    const user = JSON.parse(localStorage.getItem("user") || "null");
    if (!user || user.id == null) return null;
    return {
      id: user.id,
      username: user.username || "",
      display_name: user.display_name || "",
      checked_in: !!user.checked_in,
    };
  } catch {
    return null;
  }
}

// 与 Agent Router 当前前端的 Axios 请求保持一致：页面主世界、Cookie、New-API-User 和 XHR。
function tabFetchAgentRouterAccount(configuredUserId) {
  const readStoredUser = () => {
    try {
      const user = JSON.parse(localStorage.getItem("user") || "null");
      if (!user || user.id == null) return null;
      return {
        id: user.id,
        username: user.username || "",
        display_name: user.display_name || "",
        quota: user.quota ?? null,
        available: user.available ?? null,
        available_quota: user.available_quota ?? null,
        remaining_quota: user.remaining_quota ?? null,
        used_quota: user.used_quota ?? null,
        usedQuota: user.usedQuota ?? null,
        used: user.used ?? null,
        request_count: user.request_count ?? null,
        requestCount: user.requestCount ?? null,
      };
    } catch {
      return null;
    }
  };

  return (async () => {
    const cachedUser = readStoredUser();
    const configured = String(configuredUserId || "").trim();
    const actual = cachedUser && cachedUser.id != null ? String(cachedUser.id) : "";
    if (configured && actual && configured !== actual) {
      return { userMismatch: true, configuredUserId: configured, actualUserId: actual };
    }

    const userId = actual || configured || "-1";
    const valueOf = (data, names) => {
      if (!data) return null;
      for (const name of names) {
        if (data[name] != null && data[name] !== "") return data[name];
      }
      return null;
    };
    const accountValues = (data) => ({
      quota: valueOf(data, ["quota", "available", "available_quota", "remaining_quota"]),
      used: valueOf(data, ["used_quota", "usedQuota", "used"]),
    });
    const isZero = (value) => value != null && value !== "" && Number(value) === 0;
    const looksLikeEmptyAccount = (data) => {
      const values = accountValues(data);
      return isZero(values.quota) && isZero(values.used);
    };
    const cachedValues = accountValues(cachedUser);
    const cachedHasBalance = [cachedValues.quota, cachedValues.used]
      .some((value) => value != null && value !== "" && Number(value) !== 0);

    const requestUser = (cacheBust) => new Promise((resolveRequest) => {
      let xhr;
      try {
        xhr = new XMLHttpRequest();
        const path = "/api/user/self" + (cacheBust ? "?_nacheckin=" + Date.now() : "");
        xhr.open("GET", path, true);
        xhr.withCredentials = true;
        xhr.timeout = 15000;
        xhr.setRequestHeader("Accept", "application/json, text/plain, */*");
        xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
        xhr.setRequestHeader("New-API-User", userId);
        xhr.setRequestHeader("Cache-Control", "no-cache, no-store, max-age=0");
        xhr.setRequestHeader("Pragma", "no-cache");
      } catch (e) {
        resolveRequest({ ok: false, message: e && e.message ? e.message : "无法创建账户请求" });
        return;
      }

      xhr.onload = () => {
        const text = String(xhr.responseText || "");
        const contentType = String(xhr.getResponseHeader("content-type") || "").toLowerCase();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && body && body.success !== false && body.data) {
          resolveRequest({ ok: true, status: xhr.status, responseUrl: xhr.responseURL, contentType, body });
          return;
        }
        const htmlResponse = contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text);
        const message = body && body.message
          ? body.message
          : htmlResponse
            ? "用户接口被重定向到网页（HTTP " + xhr.status + "，" + (xhr.responseURL || "/api/user/self") + "）"
            : "用户接口返回无效数据（HTTP " + xhr.status + "）";
        resolveRequest({ ok: false, status: xhr.status, responseUrl: xhr.responseURL, contentType, htmlResponse, message });
      };
      xhr.onerror = () => resolveRequest({ ok: false, status: xhr.status || 0, message: "用户接口网络请求失败" });
      xhr.ontimeout = () => resolveRequest({ ok: false, status: 0, message: "用户接口请求超时" });
      try { xhr.send(); }
      catch (e) { resolveRequest({ ok: false, status: 0, message: e && e.message ? e.message : "用户接口请求失败" }); }
    });

    let result = await requestUser(false);
    if (!result.ok || (cachedHasBalance && looksLikeEmptyAccount(result.body && result.body.data))) {
      const retry = await requestUser(true);
      if (retry.ok || !result.ok) result = retry;
    }

    if (result.ok && cachedHasBalance && looksLikeEmptyAccount(result.body.data)) {
      const liveUser = result.body.data;
      result.body = {
        ...result.body,
        data: {
          ...liveUser,
          quota: cachedValues.quota,
          used_quota: cachedValues.used,
          request_count: valueOf(cachedUser, ["request_count", "requestCount"])
            ?? valueOf(liveUser, ["request_count", "requestCount"]),
        },
      };
      result.usedCachedAccount = true;
    } else if (result.ok) {
      try {
        const stored = JSON.parse(localStorage.getItem("user") || "null") || {};
        localStorage.setItem("user", JSON.stringify({ ...stored, ...result.body.data }));
      } catch {}
    }

    return { ...result, cachedUser };
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
  try {
    const user = JSON.parse(localStorage.getItem("user") || "null");
    if (!user || user.id == null) return { ok: false };
    const configured = String(configuredUserId || "").trim();
    const actual = String(user.id);
    return {
      ok: !configured || configured === actual,
      userId: actual,
      checkedIn: !!user.checked_in,
    };
  } catch {
    return { ok: false };
  }
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
    // OAuth 回到 Agent Router 后，等待网站回调把登录响应（含 checked_in）写入 localStorage。
    let loggedIn = false;
    for (let i = 0; i < 8 && !loggedIn; i++) {
      if (i) await wait(1200);
      try {
        const out = await chrome.scripting.executeScript({ target: { tabId }, func: tabCheckAgentRouterLogin, args: [pending.userId || ""] });
        const loginState = out && out[0] && out[0].result;
        loggedIn = !!(loginState && loginState.ok);
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
// Cookie 模式下的只读账户请求策略；Agent Router 的实际签到由 GitHub 重登录完成。
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
  const contentType = String(res.headers && res.headers.get ? (res.headers.get("content-type") || "") : "").toLowerCase();
  let text = "";
  try { text = await res.text(); } catch { text = ""; }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!body) {
    if (contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text)) {
      throw new Error("Agent Router 用户接口返回了网页页面，可能是登录跳转或安全验证（HTTP " + res.status + "）");
    }
    throw new Error("Agent Router 用户接口返回了无法解析的数据（HTTP " + res.status + "）");
  }
  if (!res.ok || body.success === false) {
    const code = (body && body.code) || "";
    const hint = CODE_HINTS[code] || "";
    throw new Error((body.message || "请求失败（HTTP " + res.status + "）") + (hint ? " ｜ " + hint : ""));
  }
  return body;
}

// 按 authMode 分发：Cookie/Agent Router 复用网站原生会话，普通 token 由 Service Worker 直连。
async function callApi(p, reqPath, method, opts) {
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  if (p.authMode === "cookie" || isAgentRouterTokenMode(p)) {
    const st = cookieStrategy(p, base);
    const merged = Object.assign({ apiUserKey: st.apiUserKey }, opts || {});
    return await callViaTabRaw(p, base, reqPath, method, merged);
  }
  return await callApiPath(p, reqPath, method, opts);
}

// 签到
async function runCheckin(platform, options) {
  try {
    // Agent Router 通过退出并重新登录签到；其他自触发兼容站点仍使用 GET 请求。
    const isSelfTrigger = isSelfTriggerMode(platform);
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
    } else if (isAgentRouterTokenMode(platform)) {
      msg = (msg || "Agent Router 签到已触发") + "；如额度未到账，请在网页退出并重新登录";
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
  if (await isAgentRouterReauthPending(platform)) {
    throw new Error("Agent Router 正在通过 GitHub 重新登录，请在登录完成后刷新额度");
  }
  let selfData = reuseSelfData || null;
  let selfErr = "";
  let accountWarn = "";
  if (!selfData) {
    try {
      let selfBody;
      if (isAgentRouterGithubMode(platform)) {
        const result = await callAgentRouterAccountViaTab(
          platform,
          (platform.baseUrl || "").trim().replace(/\/+$/, ""),
        );
        selfBody = result.body;
        accountWarn = result.warning || "";
      } else {
        selfBody = await callApi(platform, "/api/user/self", "GET");
      }
      if (isAgentRouterGithubMode(platform)) verifyConfiguredUser(platform, selfBody);
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
  if (!selfData && monthlyTokens != null) {
    throw new Error("获取账户额度失败：用户接口不可用（" + (selfErr || "未返回账户额度") + "）；本月 Token 统计仍可用");
  }
  const warnings = [];
  if (accountWarn) warnings.push(accountWarn);
  if (tokensTruncated) warnings.push("本月Token为前若干页累计估算（超出截断）");
  else if (monthlyTokens == null) warnings.push("本月Token接口不可用");
  const quotaValue = (data, names) => {
    if (!data) return null;
    for (const name of names) {
      if (data[name] != null && data[name] !== "") return data[name];
    }
    return null;
  };
  return {
    available: quotaValue(selfData, ["quota", "available", "available_quota", "remaining_quota"]),
    used: quotaValue(selfData, ["used_quota", "usedQuota", "used"]),
    requestCount: quotaValue(selfData, ["request_count", "requestCount"]),
    monthlyTokens,
    tokensTruncated,
    displayName: selfData ? (selfData.display_name || selfData.displayName || selfData.username) : null,
    _warn: warnings.join("；"),
  };
}

async function runStats(platform, month) {
  const isSelfTrigger = isSelfTriggerMode(platform);
  try {
    const body = await callCheckin(platform, "GET", month);
    const account = await fetchAccount(platform, month || currentMonth(), isSelfTrigger && body.data ? body.data : null);
    return { ok: true, message: body.message || "统计数据已更新", data: body.data, account };
  } catch (e) {
    try {
      const account = await fetchAccount(platform, month || currentMonth(), null);
      if (account) return { ok: true, message: "额度已更新（签到统计不可用）", data: null, account };
    } catch {}
    return { ok: false, message: e.message, error: e.message };
  }
}

// ---------- 模型可用性与性能指标（全部只读，不触发签到） ----------
// 数据来自上游 NewAPI 自带接口，无需真实调用模型，也不消耗额度：
//   GET /api/status                     -> 版本、quota_per_unit、pricing 导航模块开关
//   GET /api/perf-metrics/summary       -> 各模型成功率/平均延迟/TPS（仅含近期有流量的模型）
//   GET /api/perf-metrics?model=xxx     -> 单模型分组明细，含首字延迟 avg_ttft_ms 与时间序列
//   GET /api/pricing                    -> 站点完整模型清单，用于左连接补齐"无流量"的模型
// 注意：success_rate 上游已是 0-100 的百分数，不要再乘 100。
const PERF_HOURS_DEFAULT = 24;

// 只读 GET：保留 HTTP 状态码，便于区分"版本不支持(404)"和"令牌无效(401)"。
// 不复用 callApiPath，避免把状态码丢进异常里，也避免影响既有签到链路。
async function rawGetJson(p, reqPath, query) {
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(base + reqPath);
  } catch {
    return { ok: false, status: 0, message: "站点地址格式不正确" };
  }
  if (query) for (const k of Object.keys(query)) url.searchParams.set(k, String(query[k]));
  const headers = { "Accept": "application/json, text/plain, */*" };
  const token = (p.accessToken || "").trim();
  if (token) headers["Authorization"] = "Bearer " + token;
  const uid = String(p.userId || "").trim();
  if (uid && /^\d+$/.test(uid)) headers["New-Api-User"] = uid;
  let res;
  try {
    res = await fetch(url.toString(), { method: "GET", headers, credentials: "omit" });
  } catch (e) {
    return { ok: false, status: 0, message: "网络请求失败：" + (e && e.message ? e.message : "无法连接站点") };
  }
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  let text = "";
  try { text = await res.text(); } catch { text = ""; }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!body) {
    const isHtml = contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text);
    return {
      ok: false,
      status: res.status,
      message: isHtml
        ? "站点返回了网页而非接口数据，可能被安全验证拦截（HTTP " + res.status + "）"
        : "站点返回了无法解析的数据（HTTP " + res.status + "）",
    };
  }
  if (!res.ok || body.success === false) {
    const hint = CODE_HINTS[(body && body.code) || ""] || "";
    return {
      ok: false,
      status: res.status,
      body,
      message: (body.message || "请求失败（HTTP " + res.status + "）") + (hint ? " ｜ " + hint : ""),
    };
  }
  return { ok: true, status: res.status, body };
}

// 只有「访问令牌」模式能由 Service Worker 直连；另两种模式复用站点登录态。
function isTokenAuthMode(p) {
  return !p || !p.authMode || p.authMode === "token";
}

// ---- Cookie / Agent Router 模式的只读取数通道 ----
// 新版 NewAPI 的 UserAuth() 只认 Authorization 头（middleware/auth.go 里
// classifyDashboardCredential 第一行就读该头，取不到直接判定凭证不匹配），
// 所以纯 Cookie 请求后台接口一律 401。POST /api/user/auth/refresh 可以用登录
// Cookie 换取有效期 15 分钟的 access token，但它挂了 SessionCookieOriginGuard()，
// 要求 Origin/Referer 与站点同源，Service Worker 直连会被判 403。
// 因此这两种模式与既有签到链路一致：统一在站点标签页内同源执行。
const SESSION_TOKEN_SKEW_MS = 60000;
const SESSION_TOKEN_FALLBACK_MS = 10 * 60 * 1000;
const sessionTokenCache = new Map();
const sessionTokenInflight = new Map();

// 站点页面内只读 GET：自动携带登录 Cookie，可按需附加 Authorization。
// 独立于 tabFetchCheckin，避免为了加一个请求头而改动既有签到链路。
function tabGetPerfJson(reqPath, query, bearer, apiUserKey, userId) {
  return (async () => {
    let url;
    try {
      url = new URL(reqPath, location.origin);
    } catch {
      return { status: 0, httpOk: false, netError: "接口路径不合法" };
    }
    if (query) for (const k of Object.keys(query)) url.searchParams.set(k, String(query[k]));
    const headers = { "Accept": "application/json, text/plain, */*", "Cache-Control": "no-store" };
    if (bearer) headers["Authorization"] = "Bearer " + bearer;
    if (userId && apiUserKey) headers[apiUserKey] = String(userId);
    let res;
    try {
      res = await fetch(url.toString(), { method: "GET", headers, credentials: "include" });
    } catch (e) {
      return { status: 0, httpOk: false, netError: "网络请求失败：" + (e && e.message ? e.message : "无法连接站点") };
    }
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    let text = "";
    try { text = await res.text(); } catch { text = ""; }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    const isHtml = contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text);
    return { status: res.status, httpOk: res.ok, body, isHtml };
  })();
}

// 站点页面内用登录 Cookie 换取 access token（同源发起才能过 Origin 校验）。
function tabRefreshAuthToken() {
  return (async () => {
    let res;
    try {
      res = await fetch(new URL("/api/user/auth/refresh", location.origin).toString(), {
        method: "POST",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        credentials: "include",
        body: "{}",
      });
    } catch (e) {
      return { status: 0, httpOk: false, netError: "网络请求失败：" + (e && e.message ? e.message : "无法连接站点") };
    }
    let text = "";
    try { text = await res.text(); } catch { text = ""; }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    const data = body && body.data ? body.data : null;
    return {
      status: res.status,
      httpOk: res.ok,
      success: body ? body.success !== false : false,
      token: data && data.access_token ? String(data.access_token) : "",
      expiresAt: data && data.access_expires_at != null ? Number(data.access_expires_at) : null,
      message: body && body.message ? String(body.message) : "",
      code: body && body.code ? String(body.code) : "",
    };
  })();
}

// access_expires_at 可能是秒级或毫秒级时间戳，统一成毫秒。
function normalizeTokenExpiry(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Date.now() + SESSION_TOKEN_FALLBACK_MS;
  return n < 1e12 ? n * 1000 : n;
}

function sessionTokenKey(base, userId) {
  let origin = base;
  try { origin = new URL(base).origin; } catch {}
  return origin + "#" + (userId || "");
}

function readSessionToken(key) {
  const hit = sessionTokenCache.get(key);
  if (!hit) return "";
  if (hit.expiresAt - Date.now() <= SESSION_TOKEN_SKEW_MS) {
    sessionTokenCache.delete(key);
    return "";
  }
  return hit.token;
}

// /api/user/auth/refresh 带 CriticalRateLimit() 且会轮换 refresh Cookie，
// 同一站点的并发请求必须共用同一次换取结果，避免限流与刷新竞争。
async function acquireSessionToken(tabId, key, staleToken) {
  const cached = readSessionToken(key);
  if (cached && cached !== staleToken) return { ok: true, token: cached };
  const running = sessionTokenInflight.get(key);
  if (running) return await running;
  const task = (async () => {
    let out;
    try {
      out = await chrome.scripting.executeScript({ target: { tabId }, func: tabRefreshAuthToken });
    } catch (e) {
      return { ok: false, message: "在站点标签页换取会话令牌失败：" + (e && e.message ? e.message : "请先在浏览器登录该站点") };
    }
    const r = (out && out[0] && out[0].result) || null;
    if (!r) return { ok: false, message: "站点标签页没有返回会话令牌" };
    if (r.netError) return { ok: false, message: r.netError };
    if (!r.httpOk || !r.success || !r.token) {
      sessionTokenCache.delete(key);
      if (r.status === 404) {
        return { ok: false, status: 404, message: "该站点没有 /api/user/auth/refresh 接口，无法用登录状态读取后台指标。" };
      }
      const hint = CODE_HINTS[r.code || ""] || "";
      const detail = r.message || "HTTP " + r.status;
      return {
        ok: false,
        status: r.status,
        message: "无法用登录状态换取会话令牌（" + detail + "）" + (hint ? " ｜ " + hint : "") +
          "，请先在浏览器中打开并登录该站点，然后重试。",
      };
    }
    sessionTokenCache.set(key, { token: r.token, expiresAt: normalizeTokenExpiry(r.expiresAt) });
    return { ok: true, token: r.token };
  })();
  sessionTokenInflight.set(key, task);
  try {
    return await task;
  } finally {
    sessionTokenInflight.delete(key);
  }
}

// 把注入结果归一化成与 rawGetJson 一致的契约：{ ok, status, body, message }
async function injectGetJson(tabId, reqPath, query, bearer, apiUserKey, userId) {
  let out;
  try {
    out = await chrome.scripting.executeScript({
      target: { tabId },
      func: tabGetPerfJson,
      args: [reqPath, query || null, bearer || null, apiUserKey || null, userId || null],
    });
  } catch (e) {
    return { ok: false, status: 0, message: "在站点标签页执行请求失败：" + (e && e.message ? e.message : "请先在浏览器登录该站点") };
  }
  const r = (out && out[0] && out[0].result) || null;
  if (!r) return { ok: false, status: 0, message: "站点标签页没有返回数据" };
  if (r.netError) return { ok: false, status: r.status || 0, message: r.netError };
  if (!r.body) {
    return {
      ok: false,
      status: r.status,
      message: r.isHtml
        ? "站点返回了网页而非接口数据，可能是登录跳转或安全验证（HTTP " + r.status + "）"
        : "站点返回了无法解析的数据（HTTP " + r.status + "）",
    };
  }
  if (!r.httpOk || r.body.success === false) {
    const hint = CODE_HINTS[(r.body && r.body.code) || ""] || "";
    return {
      ok: false,
      status: r.status,
      body: r.body,
      message: (r.body.message || "请求失败（HTTP " + r.status + "）") + (hint ? " ｜ " + hint : ""),
    };
  }
  return { ok: true, status: r.status, body: r.body };
}

// 复用已打开的站点标签页；没有就临时开一个后台标签页，结束后关掉。
async function withSiteTab(base, fn) {
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    throw new Error("站点地址格式不正确");
  }
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
    return await fn(tab.id);
  } finally {
    if (createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
  }
}

// 取数通道：token 模式由 Service Worker 直连；Cookie / Agent Router 模式在站点
// 标签页内同源请求。先不带 Authorization 试一次（旧内核 TryUserAuth 允许匿名读，
// 这样对它们零副作用），只有明确 401 时才换会话令牌重试。
async function withInsightReader(platform, fn) {
  const base = (platform.baseUrl || "").trim().replace(/\/+$/, "");
  if (isTokenAuthMode(platform)) {
    return await fn((reqPath, query) => rawGetJson(platform, reqPath, query));
  }
  const st = cookieStrategy(platform, base);
  const apiUserKey = st.apiUserKey || "New-Api-User";
  const userId = String(platform.userId || "").trim();
  const key = sessionTokenKey(base, userId);
  return await withSiteTab(base, async (tabId) => {
    const read = async (reqPath, query) => {
      const bearer = readSessionToken(key);
      const first = await injectGetJson(tabId, reqPath, query, bearer, apiUserKey, userId);
      if (first.ok || first.status !== 401) return first;
      const got = await acquireSessionToken(tabId, key, bearer);
      if (!got.ok) return { ok: false, status: first.status, message: got.message || first.message };
      if (got.token === bearer) return first;
      return await injectGetJson(tabId, reqPath, query, got.token, apiUserKey, userId);
    };
    return await fn(read);
  });
}

// 解析 /api/status 里的 pricing 导航模块：决定 perf-metrics 是否可用/是否要求登录。
function parsePricingModule(statusData) {
  let nav = statusData && statusData.HeaderNavModules;
  if (typeof nav === "string") {
    try { nav = JSON.parse(nav); } catch { nav = null; }
  }
  const pricing = nav && nav.pricing;
  if (pricing == null) return { present: false, enabled: null, requireAuth: null };
  if (typeof pricing === "boolean") return { present: true, enabled: pricing, requireAuth: null };
  return {
    present: true,
    enabled: pricing.enabled !== false,
    requireAuth: pricing.requireAuth === true,
  };
}

function normalizePerfEntry(entry) {
  if (!entry) return null;
  const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    successRate: num(entry.success_rate),
    avgLatencyMs: num(entry.avg_latency_ms),
    avgTps: num(entry.avg_tps),
    avgTtftMs: num(entry.avg_ttft_ms),
    recentSuccessRates: Array.isArray(entry.recent_success_rates)
      ? entry.recent_success_rates.map(num).filter((v) => v != null)
      : [],
  };
}

// 以 /api/pricing 的完整模型清单为骨架左连接 perf 指标；
// perf 里出现但 pricing 未返回的模型（例如你的分组看不到但站点有流量）也补进来并标记。
function joinModelInsight(catalog, perfModels) {
  const perfMap = new Map();
  for (const m of perfModels) {
    const name = String((m && m.model_name) || "").trim();
    if (name) perfMap.set(name, m);
  }
  const rows = [];
  const seen = new Set();
  for (const item of catalog) {
    const name = String((item && item.model_name) || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({
      model: name,
      vendor: String((item && item.owner_by) || ""),
      groups: Array.isArray(item && item.enable_groups) ? item.enable_groups : [],
      inCatalog: true,
      perf: normalizePerfEntry(perfMap.get(name)),
    });
  }
  for (const m of perfModels) {
    const name = String((m && m.model_name) || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({ model: name, vendor: "", groups: [], inCatalog: false, perf: normalizePerfEntry(m) });
  }
  return rows;
}

// ---- 无 perf-metrics 站点的降级指标：从「我的调用日志」聚合 ----
// 老版 new-api 分支（例如 Agent Router，/api/status 的 version 形如
// init-2026xxxx-xxxxxxx、且没有 HeaderNavModules 字段）没有 perf_metrics 模块，
// /api/perf-metrics 一律 404。它们的 /api/log/self 里有足够的信息可以还原
// 成功率与延迟：type=2 是消费（成功），type=5 是错误（失败），use_time 是秒，
// other 里的 frt 是首字毫秒。据此聚合出的是「你自己的调用表现」而非站点全局。
const LOG_PAGE_SIZE = 100;
const LOG_MAX_PAGES = 6;
const LOG_TYPE_CONSUME = 2;
const LOG_TYPE_ERROR = 5;

function parseLogOther(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

// /api/log/self/ 返回 { success, data: { items, page, page_size, total } }
async function fetchSelfLogs(read, hours, modelName) {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - Math.max(1, Number(hours) || PERF_HOURS_DEFAULT) * 3600;
  const items = [];
  let lastError = "";
  for (let page = 1; page <= LOG_MAX_PAGES; page++) {
    const query = {
      p: page,
      page_size: LOG_PAGE_SIZE,
      type: 0,
      start_timestamp: startTs,
      end_timestamp: endTs,
    };
    if (modelName) query.model_name = modelName;
    const res = await read("/api/log/self/", query);
    if (!res.ok) {
      lastError = res.message || "无法读取调用日志";
      break;
    }
    const data = (res.body && res.body.data) || {};
    const batch = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
    for (const it of batch) items.push(it);
    if (batch.length < LOG_PAGE_SIZE) break;
  }
  return { items, error: lastError, startTs, endTs };
}

function finishLogAccumulator(acc) {
  const ok = acc.total - acc.fail;
  return {
    successRate: acc.total ? Number(((ok / acc.total) * 100).toFixed(2)) : null,
    avgLatencyMs: acc.useTimeN ? Math.round((acc.useTimeSum / acc.useTimeN) * 1000) : null,
    avgTtftMs: acc.frtN ? Math.round(acc.frtSum / acc.frtN) : null,
    avgTps: acc.tokenTime > 0 ? Number((acc.tokens / acc.tokenTime).toFixed(2)) : null,
    recentSuccessRates: [],
    sampleCount: acc.total,
  };
}

function newLogAccumulator() {
  return { total: 0, fail: 0, useTimeSum: 0, useTimeN: 0, frtSum: 0, frtN: 0, tokens: 0, tokenTime: 0 };
}

function accumulateLogEntry(acc, it) {
  const type = Number(it && it.type);
  if (type !== LOG_TYPE_CONSUME && type !== LOG_TYPE_ERROR) return false;
  acc.total++;
  if (type === LOG_TYPE_ERROR) acc.fail++;
  const use = Number(it.use_time);
  if (Number.isFinite(use) && use > 0) {
    acc.useTimeSum += use;
    acc.useTimeN++;
  }
  const other = parseLogOther(it.other);
  const frt = other && other.frt != null ? Number(other.frt) : null;
  if (frt != null && Number.isFinite(frt) && frt > 0) {
    acc.frtSum += frt;
    acc.frtN++;
  }
  const completion = Number(it.completion_tokens);
  if (type === LOG_TYPE_CONSUME && Number.isFinite(completion) && completion > 0 && Number.isFinite(use) && use > 0) {
    acc.tokens += completion;
    acc.tokenTime += use;
  }
  return true;
}

// 聚合成与 normalizePerfEntry 同构的对象，好让左连接与渲染逻辑复用。
function aggregateLogPerf(items) {
  const byModel = new Map();
  for (const it of items) {
    const name = String((it && it.model_name) || "").trim();
    if (!name) continue;
    let acc = byModel.get(name);
    if (!acc) {
      acc = newLogAccumulator();
      byModel.set(name, acc);
    }
    accumulateLogEntry(acc, it);
  }
  const out = new Map();
  for (const [name, acc] of byModel) {
    if (acc.total > 0) out.set(name, finishLogAccumulator(acc));
  }
  return out;
}

// 按整小时分桶，产出与 perf-metrics series 同构的趋势点。
function aggregateLogSeries(items) {
  const buckets = new Map();
  for (const it of items) {
    const created = Number(it && it.created_at);
    if (!Number.isFinite(created) || created <= 0) continue;
    const bucket = Math.floor(created / 3600) * 3600;
    let acc = buckets.get(bucket);
    if (!acc) {
      acc = newLogAccumulator();
      buckets.set(bucket, acc);
    }
    accumulateLogEntry(acc, it);
  }
  return [...buckets.entries()]
    .filter(([, acc]) => acc.total > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([ts, acc]) => {
      const done = finishLogAccumulator(acc);
      return {
        ts,
        success_rate: done.successRate,
        avg_latency_ms: done.avgLatencyMs,
        avg_tps: done.avgTps,
      };
    });
}

// 用日志把清单左连接成 rows（与 joinModelInsight 结构一致）
function joinLogInsight(catalog, logPerf) {
  const rows = [];
  const seen = new Set();
  for (const item of catalog) {
    const name = String((item && item.model_name) || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({
      model: name,
      vendor: String((item && item.owner_by) || ""),
      groups: Array.isArray(item && item.enable_groups) ? item.enable_groups : [],
      inCatalog: true,
      perf: logPerf.get(name) || null,
    });
  }
  for (const [name, perf] of logPerf) {
    if (seen.has(name)) continue;
    seen.add(name);
    rows.push({ model: name, vendor: "", groups: [], inCatalog: false, perf });
  }
  return rows;
}

// 站点是否可能压根没有 perf_metrics 模块：新版内核才会下发 HeaderNavModules。
function looksLikeLegacyKernel(site) {
  return !!site && !site.pricingModule.present;
}

function legacyKernelNote(site) {
  const ver = site && site.version ? "（版本 " + site.version + "）" : "";
  const kind = looksLikeLegacyKernel(site) ? "该站点是较旧的 NewAPI 分支" : "该站点";
  return kind + ver + "没有性能指标接口，下表成功率与延迟来自你自己近期的调用日志，不代表站点全局水平。";
}

// perf-metrics 返回 404 时的降级：模型清单 + 我的调用日志聚合。
async function buildLogFallbackInsight(read, platform, site, range, pricingRes) {
  const catalog = (pricingRes.ok && pricingRes.body && Array.isArray(pricingRes.body.data))
    ? pricingRes.body.data
    : [];
  const logs = await fetchSelfLogs(read, range, "");
  const logPerf = aggregateLogPerf(logs.items);
  const rows = joinLogInsight(catalog, logPerf);
  if (!rows.length) {
    return {
      ok: false,
      status: 404,
      site,
      hours: range,
      message: "该站点没有性能指标接口，也读不到模型清单和调用日志" +
        (logs.error ? "（" + logs.error + "）" : "") + "。",
    };
  }
  const warnings = [legacyKernelNote(site)];
  if (!pricingRes.ok) {
    warnings.push("模型清单不可用（" + (pricingRes.message || "接口异常") + "），仅列出你调用过的模型。");
  }
  if (logs.error) {
    warnings.push("调用日志读取不完整（" + logs.error + "）。");
  }
  if (!logPerf.size) {
    warnings.push("你在近 " + range + " 小时内没有调用记录，所以只能列出模型清单，没有可用性数据。");
  }
  if (!isTokenAuthMode(platform)) {
    warnings.push("指标经站点登录会话读取，需保持浏览器已登录该站点。");
  }
  return {
    ok: true,
    hours: range,
    site,
    metricsSource: "log",
    catalogOk: pricingRes.ok,
    catalogTotal: catalog.length,
    perfTotal: logPerf.size,
    rows,
    warnings,
    message: "已读取 " + rows.length + " 个模型（其中 " + logPerf.size + " 个有你的调用记录）",
  };
}

// 单模型明细的同源降级：把日志按小时分桶，产出一条「我的调用记录」分组。
async function buildLogFallbackDetail(read, name, range) {
  const logs = await fetchSelfLogs(read, range, name);
  const acc = newLogAccumulator();
  let counted = 0;
  for (const it of logs.items) {
    if (accumulateLogEntry(acc, it)) counted++;
  }
  if (!counted) {
    return {
      ok: false,
      status: 404,
      message: "该站点没有性能指标接口，且近 " + range + " 小时内没有你对「" + name + "」的调用记录" +
        (logs.error ? "（" + logs.error + "）" : "") + "。",
    };
  }
  const done = finishLogAccumulator(acc);
  return {
    ok: true,
    model: name,
    hours: range,
    source: "log",
    groups: [{
      group: "我的调用记录",
      avgTtftMs: done.avgTtftMs,
      avgLatencyMs: done.avgLatencyMs,
      successRate: done.successRate,
      avgTps: done.avgTps,
      series: aggregateLogSeries(logs.items),
    }],
  };
}

async function runModelInsight(platform, hours) {
  try {
    validatePlatform(platform);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : "平台配置无效" };
  }

  const range = Number(hours) > 0 ? Number(hours) : PERF_HOURS_DEFAULT;
  try {
    return await withInsightReader(platform, async (read) => {
      const [statusRes, perfRes, pricingRes] = await Promise.all([
        read("/api/status"),
        read("/api/perf-metrics/summary", { hours: range }),
        read("/api/pricing"),
      ]);

      const statusData = statusRes.ok && statusRes.body ? statusRes.body.data : null;
      const site = {
        version: statusData ? statusData.version || "" : "",
        systemName: statusData ? statusData.system_name || "" : "",
        quotaPerUnit: statusData && statusData.quota_per_unit != null ? Number(statusData.quota_per_unit) : null,
        pricingModule: parsePricingModule(statusData),
      };

      if (!perfRes.ok) {
        // 老版内核（例如 Agent Router）没有 perf_metrics 模块，退回日志聚合而不是直接报错
        if (perfRes.status === 404) {
          return await buildLogFallbackInsight(read, platform, site, range, pricingRes);
        }
        let message = perfRes.message || "无法读取模型性能指标";
        if (perfRes.status === 401) {
          message = isTokenAuthMode(platform)
            ? "访问令牌无效或已过期：" + message
            : "站点登录状态不可用：" + message;
        } else if (perfRes.status === 403) {
          message = site.pricingModule.present && site.pricingModule.enabled === false
            ? "站点已关闭 pricing 模块，性能指标接口不对外开放。"
            : "无权访问性能指标接口：" + message;
        }
        return { ok: false, status: perfRes.status, site, hours: range, message };
      }

      const perfModels = (perfRes.body && perfRes.body.data && Array.isArray(perfRes.body.data.models))
        ? perfRes.body.data.models
        : [];
      const catalog = (pricingRes.ok && pricingRes.body && Array.isArray(pricingRes.body.data))
        ? pricingRes.body.data
        : [];

      const warnings = [];
      if (!pricingRes.ok) {
        warnings.push("模型清单不可用（" + (pricingRes.message || "接口异常") + "），仅显示近期有流量的模型。");
      }
      if (!perfModels.length) {
        warnings.push("该站点近 " + range + " 小时没有性能采样数据。");
      }
      if (!isTokenAuthMode(platform)) {
        warnings.push("指标经站点登录会话读取，需保持浏览器已登录该站点。");
      }

      const rows = joinModelInsight(catalog, perfModels);
      return {
        ok: true,
        hours: range,
        site,
        metricsSource: "perf",
        catalogOk: pricingRes.ok,
        catalogTotal: catalog.length,
        perfTotal: perfModels.length,
        rows,
        warnings,
        message: "已读取 " + rows.length + " 个模型（其中 " + perfModels.length + " 个有近期指标）",
      };
    });
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : "无法读取模型指标" };
  }
}

// 单模型明细：分组维度的首字延迟与时间序列。
async function runModelDetail(platform, model, hours) {
  const name = String(model || "").trim();
  if (!name) return { ok: false, message: "缺少模型名称" };
  try {
    validatePlatform(platform);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : "平台配置无效" };
  }
  const range = Number(hours) > 0 ? Number(hours) : PERF_HOURS_DEFAULT;
  try {
    return await withInsightReader(platform, async (read) => {
      const res = await read("/api/perf-metrics", { model: name, hours: range });
      if (!res.ok) {
        if (res.status === 404) return await buildLogFallbackDetail(read, name, range);
        return { ok: false, status: res.status, message: res.message || "无法读取模型明细" };
      }
      const data = (res.body && res.body.data) || {};
      const groups = Array.isArray(data.groups) ? data.groups : [];
      return {
        ok: true,
        model: data.model_name || name,
        hours: range,
        groups: groups.map((g) => ({
          group: String(g.group || ""),
          avgTtftMs: g.avg_ttft_ms == null ? null : Number(g.avg_ttft_ms),
          avgLatencyMs: g.avg_latency_ms == null ? null : Number(g.avg_latency_ms),
          successRate: g.success_rate == null ? null : Number(g.success_rate),
          avgTps: g.avg_tps == null ? null : Number(g.avg_tps),
          series: Array.isArray(g.series) ? g.series : [],
        })),
      };
    });
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : "无法读取模型明细" };
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
    // /api/user/self 本身会触发 Agent Router 签到，不能把它当作只读预检接口调用。
    if (isSelfTriggerMode(p)) return p;
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
      } else if (msg.type === "modelInsight") {
        sendResponse(await runModelInsight(msg.platform, msg.hours));
      } else if (msg.type === "modelDetail") {
        sendResponse(await runModelDetail(msg.platform, msg.model, msg.hours));
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
