# @deepseek-ai/dsh-loopback-request

English | [中文](README.zh.md)

The loopback same-origin fence shared by Host plugins whose routes a browser on this machine reaches directly. `isLoopbackSameOriginRequest(request)` decides whether one request may reach such a route: `Host` must name a loopback authority, an explicit `Sec-Fetch-Site: cross-site` marker is refused, and an `Origin` the browser attached must match that authority exactly. An absent `Origin` passes, because the `Host` check has already bound the request and a plain-HTTP browser read carries no `Origin` at all. `isLoopbackHostname(hostname)` is the hostname half on its own: `localhost` and its subdomains, IPv6 loopback, and all of 127/8.

The fence exists because a browser-facing local route opens two confused-deputy paths — DNS rebinding, where `Host` names an attacker's domain while the socket lands here, and cross-site requests from a malicious page. A WebSocket upgrade is not covered by CORS at all, so for upgrade routes this is the only check standing between a hostile page and the route.

`dsh-meeting-minutes` and `dsh-live-assist` both consume it.

## Known Limitations and Deferred Work

- Loopback only, and deliberately so. A deployment that serves a LAN authority or a declared external host needs the broader `trustedHosts` policy owned by [`dsh-client-connection`](../../client/connection/README.md), which this package does not implement.
- Not an authentication layer. It decides only whether a request's origin markers are consistent with a local browser talking to a local route, never who is asking.
- `dsh-client-connection` keeps its own copy of the hostname predicate, because its fence spans browser and Host halves and admits configured non-loopback authorities. Folding the two is deferred until that policy needs to be shared rather than duplicated.
