/**
 * dsh-lan-access — 浏览器半边。
 *
 * 两件事：
 *  1. 把页面强制当作「本机页面」。dsh 的客户端在非回环地址下会把 settings 降级成内存态
 *     （`const persistence = ctx.remote.$host.isLoopback ? "host" : "memory"`），于是设置页
 *     报 `settings are unavailable in this browser`。这里把 connection.isLoopback 与
 *     api-gateway 的 $host.hostFacts 固定为 true。
 *  2. 在设置面板左侧导航里单独加一行「局域网使用」：绑定地址、端口、免 token 开关
 *     都能在设置页里改（读写本插件自己的 /lan-access/settings）。
 */

window.__ModuleLoader__.load({
  id: "dsh-lan-access",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const MARK = "[dsh-lan-access]";
    const API = "/lan-access";
    const ZH = (() => {
      try {
        return String(navigator.language ?? "").toLowerCase().startsWith("zh");
      } catch {
        return false;
      }
    })();

    /** @param {string} zh @param {string} en */
    const t = (zh, en) => (ZH ? zh : en);

    /** @param {...unknown} args */
    function warn(...args) {
      try {
        console.warn(MARK, ...args);
      } catch {
        /* ignore */
      }
    }

    async function apiJson(path, init) {
      const response = await fetch(path, {
        cache: "no-store",
        credentials: "same-origin",
        ...init,
      });
      const text = await response.text();
      let body;
      try {
        body = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        body = { error: text.slice(0, 400) };
      }
      if (!response.ok) {
        throw new Error(body?.error ?? `HTTP ${String(response.status)}`);
      }
      return body;
    }

    // ── 1. 强制「本机页面」 ──────────────────────────────────────────────────

    /** @param {any} holder @param {string} name */
    function service(holder, name) {
      if (holder === undefined || holder === null) return undefined;
      try {
        if (typeof holder.get === "function") {
          const resolved = holder.get(name);
          if (resolved !== undefined && resolved !== null) return resolved;
        }
      } catch {
        /* ignore */
      }
      return holder[name];
    }

    /** 让 api-gateway 的 $host.hostFacts 永远报告 isLoopback = true。 */
    function patchHostFacts(remote) {
      if (remote === undefined || remote === null) return;
      try {
        if (remote.hostFacts) remote.hostFacts.isLoopback = true;
      } catch {
        /* ignore */
      }
      try {
        const proto = Object.getPrototypeOf(remote);
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "$host") : undefined;
        if (!descriptor || typeof descriptor.get !== "function") return;
        if (descriptor.get.__lanAccess === true) return;
        const original = descriptor.get;
        const replacement = function $host() {
          const facts = original.call(this);
          if (facts && facts.isLoopback !== true) {
            try {
              facts.isLoopback = true;
            } catch {
              /* ignore */
            }
          }
          return facts;
        };
        replacement.__lanAccess = true;
        Object.defineProperty(proto, "$host", { ...descriptor, get: replacement });
      } catch (error) {
        warn("could not wrap $host:", error);
      }
    }

    /** @param {any} ctx */
    function forceLoopback(ctx) {
      const connection = service(ctx, "connection");
      if (connection !== undefined && connection !== null && connection.isLoopback !== true) {
        try {
          connection.isLoopback = true;
        } catch (error) {
          warn("could not set connection.isLoopback:", error);
        }
      }
      patchHostFacts(service(ctx, "remote"));
    }

    // ── 2. 设置面板 ─────────────────────────────────────────────────────────

    const label = () => t("局域网使用", "LAN access");

    const styles = {
      wrap: {
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        maxWidth: "760px",
        width: "100%",
        color: "var(--dsw-alias-label-primary)",
      },
      card: {
        border: ".5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l3, rgba(127,127,127,.35)))",
        borderRadius: "var(--dsw-radius-xl, 12px)",
        background: "var(--dsw-alias-settings-card-fill, transparent)",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      },
      row: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      hint: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "13px",
        lineHeight: "20px",
      },
      input: {
        border: ".5px solid var(--dsw-alias-border-l4, rgba(127,127,127,.45))",
        borderRadius: "var(--dsw-radius-md, 8px)",
        background: "var(--dsw-alias-bg-layer-1, transparent)",
        color: "var(--dsw-alias-label-primary, inherit)",
        font: "inherit",
        padding: "4px 8px",
        outline: "none",
      },
      button: {
        border: ".5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.45))",
        borderRadius: "var(--dsw-radius-sm, 6px)",
        color: "var(--dsw-alias-label-primary, inherit)",
        background: "transparent",
        font: "inherit",
        cursor: "pointer",
        padding: "4px 10px",
      },
      code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" },
      ok: { color: "var(--dsw-alias-state-success-primary, #2ea043)", fontSize: "12px" },
      err: { color: "var(--dsw-alias-state-error-primary, #f85149)", fontSize: "12px" },
    };

    /** 小标题 + 内容的一行。 */
    function Row({ title, children }) {
      return h("div", { style: styles.row }, h("span", { style: { minWidth: "96px", opacity: 0.85 } }, title), children);
    }

    function LanAccessPanel() {
      const [state, setState] = useState(null);
      const [form, setForm] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [message, setMessage] = useState("");

      const adopt = useCallback((data) => {
        setState(data);
        setForm({
          enabled: data.settings.enabled !== false,
          bindHost: data.settings.bindHost === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0",
          port: data.settings.port ?? "",
          disableAuth: data.settings.disableAuth !== false,
          trustedText: (data.settings.extraTrustedHosts ?? []).join(", "),
        });
      }, []);

      const load = useCallback(async () => {
        setError("");
        try {
          adopt(await apiJson(`${API}/settings`));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      }, [adopt]);

      useEffect(() => {
        void load();
      }, [load]);

      /** 重绑发生在响应之后，稍后回读真实状态与结果。 */
      const refreshAfterSave = useCallback(async () => {
        try {
          const data = await apiJson(`${API}/settings`);
          setState(data);
          setForm((previous) => (previous === null ? previous : { ...previous, port: data.settings.port ?? "" }));
          const where = (data.effective?.addresses ?? []).join("  ");
          const rebound = data.effective?.lastRebind;
          if (rebound && rebound.ok === false) {
            setError(
              `${t("端口没绑上，已回滚到", "bind failed, rolled back to")} ${String(rebound.host)}:${String(rebound.port)} — ${String(rebound.error)}`,
            );
            setMessage("");
          } else {
            setMessage(where.length > 0 ? `${t("已生效", "applied")} — ${where}` : t("已生效", "applied"));
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      }, []);

      const save = useCallback(async () => {
        if (form === null) return;
        setBusy(true);
        setError("");
        setMessage("");
        try {
          const rawPort = String(form.port ?? "").trim();
          const port = rawPort.length === 0 ? null : Number(rawPort);
          if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
            throw new Error(t("端口必须是 1-65535 的整数（留空表示沿用命令行/默认）", "port must be an integer in 1-65535 (empty = keep the CLI/default one)"));
          }
          const data = await apiJson(`${API}/settings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              enabled: form.enabled,
              bindHost: form.bindHost,
              port,
              disableAuth: form.disableAuth,
              extraTrustedHosts: String(form.trustedText ?? "")
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
            }),
          });
          adopt(data);
          setMessage(
            t("已保存，正在重绑…", "saved, rebinding…") +
              (data.rebound?.pending ? ` ${t("（端口变了的话，请用新地址重新打开本页）", "(if the port changed, reopen this page with the new address)")}` : ""),
          );
          setTimeout(() => {
            void refreshAfterSave();
          }, 1500);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      }, [adopt, form, refreshAfterSave]);

      const rescan = useCallback(async () => {
        setBusy(true);
        setError("");
        setMessage("");
        try {
          const data = await apiJson(`${API}/rescan`, { method: "POST" });
          adopt(data);
          setMessage(
            t(
              `已重新扫描并信任 ${(data.added ?? []).length} 个局域网地址`,
              `re-scanned and trusted ${(data.added ?? []).length} LAN address(es)`,
            ),
          );
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      }, [adopt]);

      const effective = state?.effective;
      const addresses = effective?.addresses ?? [];

      return h(
        "div",
        { style: styles.wrap },
        h("div", { style: { fontSize: "15px", fontWeight: 600 } }, label()),
        h(
          "div",
          { style: styles.hint },
          t(
            "让 dsh Web GUI 在局域网里可用。绑定地址与端口由本插件在运行时重绑实现，端口留空即沿用命令行/官方默认值。",
            "Make the dsh Web GUI reachable on the LAN. The bind address and port are applied by rebinding at runtime; leave the port empty to keep the CLI/official default.",
          ),
        ),

        h(
          "div",
          { style: styles.card },
          h("div", { style: { fontWeight: 600 } }, t("当前状态", "Current state")),
          h(
            "div",
            { style: styles.hint },
            effective
              ? `${t("监听", "listening")}: ${String(effective.host)}:${String(effective.port)} · ${t("免 token", "token-free")}: ${effective.disableAuth ? t("开", "on") : t("关", "off")}`
              : t("读取中…", "loading…"),
          ),
          addresses.length > 0
            ? h(
              "div",
              { style: { ...styles.hint, display: "flex", flexDirection: "column", gap: "2px" } },
              addresses.map((address) => h("a", {
                key: address,
                href: address,
                target: "_blank",
                rel: "noreferrer",
                style: styles.code,
              }, address)),
            )
            : null,
          effective?.settingsFile
            ? h("div", { style: { ...styles.hint, ...styles.code } }, `${t("设置文件", "settings file")}: ${effective.settingsFile}`)
            : null,
        ),

        form !== null
          ? h(
            "div",
            { style: styles.card },
            h(
              Row,
              { title: t("启用插件", "Enabled") },
              h("input", {
                type: "checkbox",
                checked: form.enabled,
                onChange: (event) => setForm({ ...form, enabled: event.target.checked }),
              }),
              h("span", { style: styles.hint }, t("关掉后不重绑、不改认证", "off = no rebind and no auth change")),
            ),
            h(
              Row,
              { title: t("绑定地址", "Bind host") },
              h(
                "select",
                {
                  style: styles.input,
                  value: form.bindHost,
                  onChange: (event) => setForm({ ...form, bindHost: event.target.value }),
                },
                h("option", { value: "0.0.0.0" }, "0.0.0.0"),
                h("option", { value: "127.0.0.1" }, "127.0.0.1"),
              ),
              h("span", { style: styles.hint }, t("0.0.0.0 = 局域网可达", "0.0.0.0 = reachable from the LAN")),
            ),
            h(
              Row,
              { title: t("端口", "Port") },
              h("input", {
                type: "number",
                min: 1,
                max: 65535,
                placeholder: t("留空 = 沿用命令行/默认", "empty = keep CLI/default"),
                style: { ...styles.input, width: "180px" },
                value: form.port,
                onChange: (event) => setForm({ ...form, port: event.target.value }),
              }),
            ),
            h(
              Row,
              { title: t("免 token", "Token-free") },
              h("input", {
                type: "checkbox",
                checked: form.disableAuth,
                onChange: (event) => setForm({ ...form, disableAuth: event.target.checked }),
              }),
              h(
                "span",
                { style: styles.hint },
                t("关掉即恢复官方 token 认证（需重新带 token 打开）", "off restores the official token auth"),
              ),
            ),
            h(
              Row,
              { title: t("额外信任", "Extra hosts") },
              h("input", {
                type: "text",
                placeholder: "app.internal, nas.local",
                style: { ...styles.input, minWidth: "260px" },
                value: form.trustedText,
                onChange: (event) => setForm({ ...form, trustedText: event.target.value }),
              }),
              h("span", { style: styles.hint }, t("反代域名，逗号分隔", "reverse-proxy domains, comma separated")),
            ),
            h(
              "div",
              { style: styles.row },
              h("button", { style: styles.button, disabled: busy, onClick: () => void save() }, busy ? t("处理中…", "working…") : t("保存并应用", "Save & apply")),
              h("button", { style: styles.button, disabled: busy, onClick: () => void rescan() }, t("重新扫描局域网地址", "Re-scan LAN addresses")),
              h("button", { style: styles.button, disabled: busy, onClick: () => void load() }, t("重新读取", "Reload")),
            ),
            message.length > 0 ? h("div", { style: styles.ok }, message) : null,
            error.length > 0 ? h("div", { style: styles.err }, error) : null,
            h(
              "div",
              { style: styles.hint },
              t(
                "提示：改端口会让当前页面立刻断开，请用上面的新地址重新打开。免 token 打开时，局域网内任何能访问该端口的人都能读写工作区、执行命令。",
                "Note: changing the port drops this page immediately — reopen it with the new address. With token-free access, anyone who can reach the port can read/write the workspace and run commands.",
              ),
            ),
          )
          : h(
            "div",
            { style: styles.card },
            h("div", { style: styles.hint }, t("读取中…", "loading…")),
            error.length > 0 ? h("div", { style: styles.err }, error) : null,
            h("button", { style: styles.button, onClick: () => void load() }, t("重新读取", "Reload")),
          ),
      );
    }

    return {
      name: "dsh-lan-access",
      inject: ["connection", "slots"],
      apply(ctx) {
        try {
          forceLoopback(ctx);
        } catch (error) {
          warn("force loopback failed:", error);
        }
        try {
          // 与 dsh-cost-meter / dsh-archive-manager 一致：settings.section 会在设置面板
          // 左侧导航里单独占一行（像「费用计量」「归档会话」那样），而不是塞进「内置插件」页。
          ctx.effect(
            () => ctx.slots.inject("settings.section", () => ctx.slots.register({
              name: "settings.section",
              id: "lan-access",
              order: 20,
              label,
            }, LanAccessPanel)),
            "dsh-lan-access: settings section",
          );
        } catch (error) {
          warn("could not register the settings section:", error);
        }
        // 服务可能在注入回调错过同步时机，稍后兜一次（幂等）。
        try {
          setTimeout(() => forceLoopback(ctx), 500);
        } catch {
          /* ignore */
        }
      },
    };
  },
});
