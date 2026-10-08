/**
 * dsh-lan-access — Host 半边。
 *
 * 目标：让 dsh Web GUI 在局域网里可用，同时把「端口 / 认证」做成可在设置页里改的选项。
 *
 * 设计原则
 *   1. 不改磁盘上 dsh 自己的任何文件，也不覆盖官方 `webserver` 行的 config
 *      （覆盖那行就得把官方的 `port`/`compression*` 键一起重述，官方一改键就崩）。
 *   2. 绑定地址与端口由本插件在运行时「重绑」实现：官方先按 `127.0.0.1:<官方端口>` 绑好，
 *      我们再把同一个 http server 关掉、按设置重新 listen。
 *   3. 端口默认不动（`port: null` = 沿用命令行 `--port` 或官方默认），只在设置页里改了才生效。
 *   4. 免 token 也是运行时覆盖（`connection` 服务的方法），且可开关。
 *   5. 设置存放在 `<dsh home>/storages/lan-access/settings.json`（沿用官方插件的 storages
 *      约定，例如 `~/.dsh/storages/cost-meter/`），通过本插件自己的 HTTP 路由读写，
 *      路由挂在 `/lan-access` 前缀下，不需要任何 dsh 内部依赖。
 *
 * 设置页在浏览器半边（client.js）里，注册进 Settings 的 `settings.section`。
 */

import { networkInterfaces } from "node:os";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const MARK = "[dsh-lan-access]";
const PATCHED = Symbol.for("dsh-lan-access.patched");
const ROUTE = "/lan-access";

/** @param {unknown} error */
function reason(error) {
  return error instanceof Error ? error.message : String(error);
}

function log(...args) {
  console.log(MARK, ...args);
}

function warn(...args) {
  console.warn(MARK, ...args);
}

/** dsh home：环境变量优先，其次 `~/.dsh`。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME ?? process.env.DSH_HOME_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".dsh");
}

/** 设置文件位置：`<dsh home>/storages/lan-access/settings.json`。 */
function settingsFile() {
  return join(dshHome(), "storages", "lan-access", "settings.json");
}

/** 非回环 IPv4 地址（与官方 `resolveLanTrust` 的推导口径一致：无端口的 IP 字面量）。 */
function lanAddresses() {
  /** @type {string[]} */
  const out = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const info of entries ?? []) {
      if (info.internal) continue;
      if (info.family !== "IPv4") continue;
      if (!out.includes(info.address)) out.push(info.address);
    }
  }
  return out;
}

/** @param {any} value */
function normalize(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const bindHost = source.bindHost === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0";
  const port = Number.isInteger(source.port) && source.port > 0 && source.port <= 65535
    ? source.port
    : null;
  return {
    enabled: source.enabled !== false,
    bindHost,
    port,
    disableAuth: source.disableAuth !== false,
    extraTrustedHosts: Array.isArray(source.extraTrustedHosts)
      ? source.extraTrustedHosts.filter((entry) => typeof entry === "string" && entry.length > 0)
      : [],
  };
}

function loadSettings() {
  const file = settingsFile();
  let fromFile = {};
  try {
    fromFile = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") warn(`could not read ${file}: ${reason(error)}`);
  }
  const merged = normalize(fromFile);
  // 环境变量覆盖（运维方便，且优先于设置文件）
  if (process.env.DSH_LAN_BIND === "127.0.0.1") merged.bindHost = "127.0.0.1";
  const envPort = Number(process.env.DSH_LAN_PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) merged.port = envPort;
  if (process.env.DSH_LAN_NOAUTH === "0") merged.disableAuth = false;
  if (process.env.DSH_LAN_NOAUTH === "1") merged.disableAuth = true;
  if (process.env.DSH_LAN_DISABLE === "1") merged.enabled = false;
  return merged;
}

/** @param {any} settings */
function saveSettings(settings) {
  const file = settingsFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return file;
}

/**
 * Host plugin body.
 * @param {any} ctx - Cordis context.
 * @param {any} config - This plugin's row config.
 */
export async function apply(ctx, config) {
  const options = {
    route: typeof config?.route === "string" && config.route.startsWith("/") ? config.route : ROUTE,
    verbose: config?.verbose !== false,
  };
  /** @param {...unknown} args */
  const say = (...args) => {
    if (options.verbose) log(...args);
  };

  let settings = loadSettings();
  /** 认证补丁的还原函数（enable/disable 切换时用）。 */
  let revertAuth = () => {};
  /** 当前生效的监听信息。 */
  const listening = { host: undefined, port: undefined };
  /** 最近一次重绑结果：设置页在保存后回读它，就能区分「已生效」和「端口占用已回滚」。 */
  let lastRebind = { ok: true, changed: false, at: Date.now() };

  const webCtx = await new Promise((resolve) => {
    ctx.inject(["webServer"], (ready) => resolve(ready));
  });
  const webServer = webCtx.webServer;
  const connectionCtx = await new Promise((resolve) => {
    ctx.inject(["connection"], (ready) => resolve(ready));
  });
  const connection = connectionCtx.connection;

  // ── 认证开关 ───────────────────────────────────────────────────────────────
  /** @param {boolean} disable */
  function applyAuth(disable) {
    revertAuth();
    revertAuth = () => {};
    if (!disable || connection === undefined || connection === null) return;

    /** @type {Array<() => void>} */
    const undo = [];

    const originalRejection = connection.requestRejection;
    if (typeof originalRejection === "function" && originalRejection[PATCHED] !== true) {
      const replacement = function requestRejectionLanAccess(request) {
        const rejection = originalRejection.call(this, request);
        // 401 = 未认证 → 放行；403 = Host/Origin 围栏 → 原样保留
        return rejection === 401 ? undefined : rejection;
      };
      replacement[PATCHED] = true;
      connection.requestRejection = replacement;
      undo.push(() => {
        connection.requestRejection = originalRejection;
      });
    }

    const originalAuthorizeIndex = connection.authorizeIndex;
    if (typeof originalAuthorizeIndex === "function" && originalAuthorizeIndex[PATCHED] !== true) {
      const replacement = function authorizeIndexLanAccess() {
        return true;
      };
      replacement[PATCHED] = true;
      connection.authorizeIndex = replacement;
      undo.push(() => {
        connection.authorizeIndex = originalAuthorizeIndex;
      });
    }

    const auth = connection.browserAuth;
    if (auth !== undefined && auth !== null) {
      for (const method of ["isAuthenticated", "authorizeIndex"]) {
        const original = auth[method];
        if (typeof original !== "function" || original[PATCHED] === true) continue;
        const replacement = method === "isAuthenticated"
          ? function isAuthenticatedLanAccess() {
            return true;
          }
          : function authorizeIndexLanAccess() {
            return true;
          };
        replacement[PATCHED] = true;
        auth[method] = replacement;
        undo.push(() => {
          auth[method] = original;
        });
      }
    }

    const originalUrl = connection.authenticatedUrl;
    if (typeof originalUrl === "function" && originalUrl[PATCHED] !== true) {
      const replacement = function authenticatedUrlLanAccess(baseUrl) {
        return String(baseUrl);
      };
      replacement[PATCHED] = true;
      connection.authenticatedUrl = replacement;
      undo.push(() => {
        connection.authenticatedUrl = originalUrl;
      });
    }

    revertAuth = () => {
      for (const revert of undo.reverse()) {
        try {
          revert();
        } catch (error) {
          warn("revert failed:", reason(error));
        }
      }
      revertAuth = () => {};
    };
  }

  // ── Host/Origin 围栏白名单 ─────────────────────────────────────────────────
  /**
   * 把本机所有非回环 IPv4 加进 `/api` 的信任围栏。
   * 官方 `resolveLanTrust` 只在「启动时 bind host 已经是 0.0.0.0」时才推导这些字面量，
   * 而我们是启动后重绑的，所以这里自己补上。
   */
  function trustLanAddresses() {
    if (connection === undefined || connection === null || !Array.isArray(connection.trustedHosts)) return [];
    const wanted = settings.bindHost === "127.0.0.1" ? [] : lanAddresses();
    /** @type {string[]} */
    const added = [];
    for (const entry of [...wanted, ...settings.extraTrustedHosts]) {
      if (entry.length === 0) continue;
      if (connection.trustedHosts.includes(entry)) continue;
      connection.trustedHosts.push(entry);
      added.push(entry);
    }
    return added;
  }

  // ── 重绑监听 ───────────────────────────────────────────────────────────────

  /**
   * 关闭监听，含 keep-alive 连接，并带超时兜底。
   *
   * 关键：`server.close()` 只会等所有连接结束才回调，而「正在处理本次请求的那条连接」
   * 恰好就在这些连接里 —— 若在响应前 close，就是死锁。所以先 end 响应，再延迟调用这里，
   * 并且用 `closeAllConnections()` 把空闲的 keep-alive 连接一并清掉。
   * @param {any} server @param {number} timeoutMs
   */
  function closeServer(server, timeoutMs) {
    return new Promise((resolve) => {
      if (server.listening !== true) {
        resolve(undefined);
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(undefined);
      };
      try {
        server.closeAllConnections?.();
      } catch (error) {
        warn("closeAllConnections failed:", reason(error));
      }
      try {
        server.close(() => finish());
      } catch (error) {
        warn("close failed:", reason(error));
        finish();
      }
      setTimeout(finish, timeoutMs).unref?.();
    });
  }

  /** @param {any} server @param {number} port @param {string} host */
  function listenServer(server, port, host) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("error", onError);
        reject(error);
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve(undefined);
      });
    });
  }

  /**
   * 把监听改到「设置里的地址/端口」。
   * 端口为 null 时沿用当前实际端口（也就是 `--port` 或官方默认值）。
   * 绑定失败会回滚到原来的地址，绝不把服务留在死状态。
   * @param {boolean} force
   */
  async function rebind(force) {
    const server = webServer?.server;
    if (server === undefined || server === null) {
      lastRebind = { ok: false, error: "webserver has no http server", at: Date.now() };
      return { ok: false, error: "webserver has no http server" };
    }
    const actual = server.address();
    const previousHost = typeof actual?.address === "string" ? actual.address : (listening.host ?? webServer.host);
    const previousPort = Number.isInteger(actual?.port) ? actual.port : (listening.port ?? webServer.port ?? 0);
    const targetHost = settings.bindHost;
    const targetPort = Number.isInteger(settings.port) ? settings.port : previousPort;
    if (!force && previousHost === targetHost && previousPort === targetPort) {
      listening.host = previousHost;
      listening.port = previousPort;
      lastRebind = { ok: true, changed: false, host: previousHost, port: previousPort, at: Date.now() };
      return { ok: true, changed: false };
    }

    await closeServer(server, 3000);
    try {
      await listenServer(server, targetPort, targetHost);
    } catch (error) {
      warn(`rebind to ${targetHost}:${String(targetPort)} failed: ${reason(error)} — rolling back`);
      let rolledBack = false;
      try {
        await closeServer(server, 3000);
        await listenServer(server, previousPort, previousHost);
        listening.host = previousHost;
        listening.port = Number.isInteger(server.address()?.port) ? server.address().port : previousPort;
        rolledBack = true;
      } catch (rollbackError) {
        warn("rollback failed too:", reason(rollbackError));
      }
      // 目标端口没绑上（比如被占用），就把设置里的端口还原成「沿用当前端口」，
      // 否则设置文件会一直记着一个绑不上的值，下次启动又失败一遍。
      if (rolledBack && Number.isInteger(settings.port) && settings.port !== listening.port) {
        settings = { ...settings, port: null };
        try {
          saveSettings(settings);
        } catch (saveError) {
          warn("could not persist the rollback:", reason(saveError));
        }
      }
      lastRebind = {
        ok: false,
        error: reason(error),
        rolledBack,
        host: listening.host,
        port: listening.port,
        at: Date.now(),
      };
      return {
        ok: false,
        error: reason(error),
        rolledBack: rolledBack ? { host: listening.host, port: listening.port } : false,
      };
    }
    // 让 webServer.host / .config 反映新值（后续读它的人看到一致状态）
    try {
      webServer.config.host = targetHost;
      webServer.config.port = targetPort;
    } catch {
      /* config 可能不可写：下面再用实例 getter 遮蔽 */
    }
    if (webServer.host !== targetHost) {
      try {
        Object.defineProperty(webServer, "host", {
          configurable: true,
          get: () => targetHost,
        });
      } catch (error) {
        warn("could not shadow webServer.host:", reason(error));
      }
    }
    listening.host = targetHost;
    listening.port = Number.isInteger(server.address()?.port) ? server.address().port : targetPort;
    const added = trustLanAddresses();
    say(`rebound to ${targetHost}:${String(listening.port)}${added.length > 0 ? ` (+${added.length} lan trust)` : ""}`);
    lastRebind = { ok: true, changed: true, host: listening.host, port: listening.port, at: Date.now() };
    return { ok: true, changed: true };
  }

  /** 把当前状态整理给设置页。 */
  function snapshot() {
    const port = listening.port ?? webServer?.port ?? settings.port ?? 0;
    const addresses = settings.bindHost === "127.0.0.1"
      ? [`http://127.0.0.1:${String(port)}/`]
      : lanAddresses().map((address) => `http://${address}:${String(port)}/`);
    return {
      settings,
      effective: {
        host: listening.host ?? webServer?.host,
        port,
        disableAuth: settings.disableAuth,
        trustedHosts: Array.isArray(connection?.trustedHosts) ? [...connection.trustedHosts] : [],
        settingsFile: settingsFile(),
        addresses,
        lastRebind,
        node: process.version,
      },
    };
  }

  /**
   * 保存设置，并让设置页立刻看到新状态。
   * 真正的重绑由调用方在**响应之后**触发（见路由里的 setTimeout）。
   * @param {any} next
   */
  function stage(next) {
    const merged = normalize({ ...settings, ...(next ?? {}) });
    const file = saveSettings(merged);
    settings = merged;
    applyAuth(settings.disableAuth);
    const actual = webServer?.server?.address?.();
    listening.host = settings.bindHost;
    if (Number.isInteger(settings.port)) listening.port = settings.port;
    else if (Number.isInteger(actual?.port)) listening.port = actual.port;
    say(`settings saved to ${file}`);
    return { ...snapshot(), rebound: { ok: true, changed: true, pending: true } };
  }

  // ── 启动时应用 ─────────────────────────────────────────────────────────────
  if (!settings.enabled) {
    say("disabled by settings (enabled: false); nothing applied");
  } else {
    applyAuth(settings.disableAuth);
    const trusted = trustLanAddresses();
    const rebound = await rebind(false);
    if (trusted.length > 0) say(`/api fence trusts: ${trusted.join(", ")}`);
    if (!rebound.ok && settings.bindHost !== "0.0.0.0") warn("rebind skipped or failed:", rebound.error ?? "");
    if (rebound.ok) {
      const info = snapshot();
      say(`ready — LAN: ${info.effective.addresses.join("  ") || "(no lan address)"}`);
    }
  }

  // ── 设置路由 ───────────────────────────────────────────────────────────────
  /** @param {any} req @param {any} res */
  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.slice(options.route.length) || "/";
    const send = (code, body) => {
      const text = JSON.stringify(body);
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(text);
    };
    try {
      if (path === "/settings" && (req.method === "GET" || req.method === "HEAD")) {
        send(200, snapshot());
        return;
      }
      if (path === "/settings" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = {};
        if (raw.trim().length > 0) {
          try {
            body = JSON.parse(raw);
          } catch {
            send(400, { error: "invalid json body" });
            return;
          }
        }
        // 先回响应再重绑：server.close() 会等这条 keep-alive 连接结束，
        // 在响应前 close 必然死锁。
        send(200, stage(body));
        setTimeout(() => {
          void rebind(true);
        }, 150);
        return;
      }
      if (path === "/rescan" && req.method === "POST") {
        const added = trustLanAddresses();
        send(200, { ...snapshot(), added, rebound: { ok: true, changed: false } });
        return;
      }
      send(404, { error: `no such endpoint: ${path}` });
    } catch (error) {
      warn("request failed:", reason(error));
      send(500, { error: reason(error) });
    }
  }

  const route = { kind: "prefix", path: options.route, handler: (req, res) => handle(req, res) };
  webCtx.effect(() => webCtx.webServer.register(route), "dsh-lan-access: settings route");

  ctx.effect(
    () => () => {
      revertAuth();
    },
    "dsh-lan-access: revert auth patches",
  );

  say(`active — settings API at ${options.route}/settings`);
}
