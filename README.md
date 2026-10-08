# dsh-lan-access

## ⚠️ 安全提醒

**不要在暴露于公网的服务器上安装本插件。**

本插件会关闭 dsh Web GUI 的 token 认证，并把监听地址改为 `0.0.0.0`。公网服务器每天都遭到自动化扫描、
暴力破解与漏洞探测，只要该端口能从公网访问，任何人都可以读写你的工作区、拿走 API Key 与其他凭据，
并在你的机器上执行命令。

请只在**可信内网**（家庭或办公局域网）中使用。如果服务器本身有公网入口，请把「绑定地址」改回
`127.0.0.1`，并在防火墙 / 安全组中禁止该端口对公网入站。

本项目以 MIT 协议按「现状」提供，不提供任何形式的担保，**不对因使用或误用本插件而造成的任何损失承担责任**。

---

DeepSeek Harness 的 `dsh web` 插件：让 Web GUI 在局域网中可用，并在设置面板里提供绑定地址、端口与访问认证的可视化配置。

- **默认不改端口**，端口留空即沿用 `dsh web --port <n>` 或官方默认值
- 绑定地址、端口、免 token 开关都在**设置 → 局域网使用**里修改，保存即生效，无需重启
- 绑定失败（如端口被占用）自动回滚到原地址，服务不会进入不可用状态
- 无第三方运行时依赖，只使用 Node.js 内置模块

## 背景

`dsh web` 默认只监听 `127.0.0.1`。仅把监听地址改为 `0.0.0.0` 仍会遇到两个问题：

1. 浏览器端将非本机来源判定为可降级的持久化环境，设置仅保存在内存中，导致「设置」「模型提供商」等页面报
   `加载提供商目录失败: settings are unavailable in this browser`；
2. 官方 token 认证要求每次访问都携带 `?token=`，局域网内换地址后需重新获取。

本插件对上述三处做运行时兼容处理：

| 处理 | 说明 |
| --- | --- |
| 监听重绑 | 插件运行时将 http server 重新绑定到设置中的地址与端口，默认地址 `0.0.0.0`，默认端口不变 |
| Host/Origin 信任 | 将本机网卡 IPv4 字面量追加到 `connection.trustedHosts`，避免合法局域网来源被 `403` 拒绝 |
| 本机语义 | 客户端将局域网来源视为本机，恢复设置持久化与提供商目录加载 |

认证默认关闭（免 token），可随时恢复官方 token 校验。所有改动均为运行时行为，可撤销。

## 兼容性

| 项目 | 版本 |
| --- | --- |
| dsh | 0.2.0-rc.2（`dshTarget`） |
| 运行平台 | Web（`dsh.client.platform: "web"`） |
| Node.js | >= 18（使用 `server.closeAllConnections()`，实际为 18.2+） |

## 安装

```bash
# GitHub 源
dsh plugin --profile web add https://github.com/luvsagiri/dsh-lan-access

# 仓库 tarball（一次性快照，不跟随仓库更新）
dsh plugin --profile web add https://github.com/luvsagiri/dsh-lan-access/archive/refs/heads/main.tar.gz
```

`--profile web` 为 Web GUI 使用的 profile，如有其他 profile 名请替换。
`git` 源需要系统已安装 `git`；没有 `git` 的环境（例如最小化容器）请改用上面的 tarball 方式。

安装后重启一次 dsh Web：

```bash
systemctl restart dsh-web     # systemd 部署
# 或前台部署时 Ctrl-C 后重新执行 dsh web --no-open
```

安装成功时，profile 的 `package.json` 会在 `dsh.profile.bundles` 末尾追加 `dsh-lan-access`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-lan-access"]
    }
  }
}
```

也可以在 Web 界面「插件 → 添加插件」中通过 URL 安装。

## 使用

在 Web 界面打开**设置 → 局域网使用**，可查看当前监听状态并修改以下配置：

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 启用插件 | 开 | 关闭后不重绑监听、不修改认证，等效于未安装该插件 |
| 绑定地址 | `0.0.0.0` | `0.0.0.0` 允许局域网访问；`127.0.0.1` 仅本机访问（官方默认行为） |
| 端口 | 空 | 留空沿用 `dsh web --port <n>` 或官方默认端口；填写后覆盖 |
| 免 token | 开 | 关闭后恢复官方 token 认证，访问时需携带 `?token=` |
| 额外信任 | 空 | 反向代理场景下追加信任的 Host，逗号分隔，例如 `dsh.internal,10.0.0.5` |

面板上的其他操作：

- **保存并应用**：端口或地址变更后当前页面会立即断开，需使用面板显示的新地址重新打开
- **重新扫描局域网地址**：重新枚举网卡 IPv4 并补入信任名单，适用于更换网络或新增网卡后
- **重新读取**：重新获取一次当前状态

## 配置

配置持久化在 `${DSH_HOME:-~/.dsh}/storages/lan-access/settings.json`，与官方插件的 storage 约定一致
（例如 `~/.dsh/storages/cost-meter/ledger.json`）：

```json
{
  "enabled": true,
  "bindHost": "0.0.0.0",
  "port": null,
  "disableAuth": true,
  "extraTrustedHosts": []
}
```

`port` 为 `null` 表示沿用命令行/官方默认端口。

可通过环境变量覆盖（适用于写入 systemd unit）：

| 变量 | 作用 |
| --- | --- |
| `DSH_LAN_DISABLE=1` | 停用插件 |
| `DSH_LAN_BIND=127.0.0.1` | 指定绑定地址 |
| `DSH_LAN_PORT=8080` | 指定端口 |
| `DSH_LAN_NOAUTH=0` | 恢复 token 认证 |

插件在 dsh Web 的同一端口上提供以下接口：

```
GET  /lan-access/settings    读取设置与生效状态
POST /lan-access/settings    修改设置（JSON），响应优先于重绑
POST /lan-access/rescan      重新扫描局域网地址并补入信任名单
```

## 工作原理

**监听重绑**（host 侧）——不覆盖 profile 中的 `webserver` 配置行（覆盖会整段替换官方 config 并钉死端口），
而是在 http server 已启动后重新绑定：

```js
await closeServer(server, 3000)   // 含 closeAllConnections()，避免 keep-alive 连接阻塞重绑
await listenServer(server, targetPort, targetHost)
webServer.config.host = targetHost
Object.defineProperty(webServer, "host", { get: () => targetHost })
```

`targetPort` 在「端口留空」时取当前实际端口，实现对命令行/官方默认值的透传。

**Host/Origin 信任**（host 侧）——官方 `resolveLanTrust` 仅在启动时绑定地址已是 `0.0.0.0` 的前提下推导局域网字面量，
本插件为启动后重绑，因此自行补入：

```js
for (const address of [...lanAddresses(), ...settings.extraTrustedHosts]) {
  if (!connection.trustedHosts.includes(address)) connection.trustedHosts.push(address)
}
```

跨站请求围栏（`403`）保持官方行为，仅处理合法局域网地址被误判的情况。

**认证开关**（host 侧）——采用可撤销的方法包装，并以 `Symbol.for("dsh-lan-access.patched")` 标记：

```js
connection.requestRejection = async (request) => {
  const rejected = await original.call(connection, request)
  if (rejected?.status === 401) return undefined        // 仅放开未认证，403 围栏不变
  return rejected
}
connection.authorizeIndex = async () => true
connection.authenticatedUrl = (baseUrl) => String(baseUrl)   // URL 不再附带 ?token=
```

**本机语义**（客户端侧）——修复设置持久化降级的根因：

```js
connection.isLoopback = true
// 同时遮蔽 $host 的 getter，使重建后的 hostFacts 亦返回 isLoopback: true
```

## 安全说明

- 启用「免 token」且绑定 `0.0.0.0` 后，**能访问该端口的任何网络主体都可以读写工作区并执行命令**。
  建议配合防火墙或网段限制使用；仅本机使用时将绑定地址改回 `127.0.0.1`。
- 插件不弱化 `403` 跨站请求围栏，也不会信任任意外来 Host，仅本机网卡地址与手工填写的「额外信任」会进入白名单。
- 所有修改均为运行时行为：关闭「免 token」或停用插件即恢复官方行为。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 设置页报 `settings are unavailable in this browser` | 客户端半边未生效：确认插件已写入 `dsh.profile.bundles`，重启 dsh web 后硬刷新页面 |
| 局域网访问返回 `403` | 该地址不在信任名单：点击「重新扫描局域网地址」，或在「额外信任」中手工添加 |
| 局域网访问返回 `401` | 「免 token」处于关闭状态：使用启动日志中的 `?token=` 访问，或重新开启免 token |
| 修改端口后页面无法打开 | 使用面板显示的新地址访问；如需回到默认端口，重启 dsh web（恢复为 `--port` 的值） |
| 日志出现 `rebind ... failed` | 端口被占用（`EADDRINUSE`）：插件已自动回滚，更换端口即可 |

## 卸载

```bash
dsh plugin --profile web remove dsh-lan-access
systemctl restart dsh-web
```

配置文件 `~/.dsh/storages/lan-access/settings.json` 可保留，重新安装后继续生效。

## License

MIT
