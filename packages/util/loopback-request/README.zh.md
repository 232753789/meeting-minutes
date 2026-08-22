# @deepseek-ai/dsh-loopback-request

[English](README.md) | 中文

供路由被本机浏览器直接访问的 Host 插件共用的 loopback 同源屏障。`isLoopbackSameOriginRequest(request)` 判定一个请求是否可以到达这类路由：`Host` 必须指向 loopback 授权方，显式的 `Sec-Fetch-Site: cross-site` 标记会被拒绝，浏览器附带的 `Origin`（若有）必须与该授权方完全一致。缺少 `Origin` 视为通过，因为 `Host` 检查已经约束了该请求，而纯 HTTP 的浏览器读取根本不携带 `Origin`。`isLoopbackHostname(hostname)` 是其中的主机名判定部分：`localhost` 及其子域、IPv6 loopback，以及整个 127/8 段。

这道屏障之所以存在，是因为面向浏览器的本地路由打开了两条 confused deputy 路径——DNS 重绑定（`Host` 指向攻击者域名，而 socket 落在本机）以及来自恶意页面的跨站请求。WebSocket 升级完全不受 CORS 保护，因此对 upgrade 路由而言，这是恶意页面与该路由之间唯一的检查。

`dsh-meeting-minutes` 与 `dsh-live-assist` 都消费它。

## Known Limitations and Deferred Work

- 仅限 loopback，且这是刻意为之。需要服务 LAN 授权方或已声明外部主机的部署，应使用 [`dsh-client-connection`](../../client/connection/README.md) 拥有的更宽的 `trustedHosts` 策略，本包不实现它。
- 不是认证层。它只判定请求的来源标记是否符合「本机浏览器访问本机路由」这一情形，从不判定请求者是谁。
- `dsh-client-connection` 保留了自己的一份主机名判定，因为它的屏障横跨浏览器与 Host 两侧，并且接纳已配置的非 loopback 授权方。合并两者推迟到该策略确实需要共享而非重复时再做。
