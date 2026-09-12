# 普通文件 HTTP 重定向与凭据边界

Relay 的早期点击接管会让 native 收到浏览器尚未完成重定向的原始 URL。因此 Host 必须同时约束 HEAD 探测、bootstrap GET、完整 GET、每个新建或恢复的 Range 请求及其重定向链。`safeFileRedirects: 1` 是 Host 显式启用且存在持久接管处理器时才公告的能力；旧 Host 和默认 BrowserBridge 不公告。Relay 还须同时检查 `durableHandoff: 1`。

## 实现约定

- 来源由 scheme、hostname 和有效端口共同定义。同源重定向保留捕获的请求头；跨源仅保留 User-Agent、Accept 系列、Range、If-Range。Cookie、Authorization、Proxy-Authorization、Referer、Origin 及任意命名的站点私有头均移除。多跳离开来源后，即使回到原来源，也不在该链内恢复凭据。
- 关闭会话 cookie/credential storage 和自动 cookie 处理，防止 Foundation 在清理请求头后通过 cookie jar 再添加凭据。显式捕获的 Cookie 仍可用于原来源及同源请求。
- 非 HTTP(S)、带 userinfo 的 Location、HTTPS 降级到 HTTP、跨源保留请求体的重定向均拒绝。配置认证 HTTP 代理时跨源重定向也明确拒绝，不把原代理认证重新注入目标或反复错误重签；有效 SOCKS 代理不受此 HTTP 头限制。
- DownloadEngine 当前始终从保存的原 URL 重建后续请求，不将 HTTP 最终 URL 写回 DownloadRequest。所有请求在添加捕获头和认证后再次按原来源限定；重定向 delegate 逐跳限定。跨源 401 不触发原来源凭据重试。
- 原始请求 fingerprint 保留完整 URL、方法、请求体和会话上下文，没有去掉 query/token。发生重定向时，version 2 representation 额外绑定最终资源完整 URL 的 SHA-256。每个 Range 在打开数据写入目标前同时验证最终 URL、强校验器、Content-Range 和总长度。改变最终 URI，即使 ETag 和大小相同，也不能拼接旧字节。
- 非重定向记录保持 version 1 的现有存储 hash。旧 version 1 数据在当前仍重定向时因缺少目标绑定而保留并拒绝恢复；旧记录本身不能证明历史上是否曾重定向。若历史 A→B、现在 A 直接返回同大小同 ETag，本次保留的兼容路径无法从旧元数据辨别，不应把这类历史记录声称为已验证安全。

重定向通过 [URLSessionTaskDelegate 的重定向回调](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession(_:task:willperformhttpredirection:newrequest:completionhandler:))返回修改后的请求或拒绝跟随。敏感头按来源重新评估遵循 [RFC 9110 第 15.4 节](https://www.rfc-editor.org/rfc/rfc9110.html#name-redirection-3xx)；此实现采用保守允许列表，不能推断未知自定义头不含凭据。

## 可重复验证

```sh
swift test --package-path native --filter 'HTTPRedirectSecurityTests|BrowserBridgeIntegrationTests|DigestEngineRegressionTests|NTLMEngineIntegrationTests|RepresentationStorageContextTests|DownloadResumeProtectionTests'
npm run build:native
node native/Scripts/qa-link-renewal.mjs --host native/.build/release/NDMHost --expect protected
```

`HTTPRedirectSecurityTests` 使用独立 NWListener 和真实 DownloadEngine。只发送合成 Cookie、Basic/Bearer 和自定义密钥，在每个本地 HTTP 跳记录实际方法、头、Range 和请求体；下载完成后验证 SHA-256。包含同源和跨源 302/307、多跳返回来源、HEAD 405 后的 byte probe 与无 validator 全 GET、跨源原始/挑战式 401、POST 307、Location userinfo、真实暂停后重建引擎恢复、相同 ETag/大小但目标 URI 变化，以及旧未绑定重定向恢复记录。

HTTPS 降级、来源端口和认证代理重定向限制由直接策略测试验证，不冒充真实 TLS/代理链测试。已有 Digest/NTLM 实网测试验证非重定向认证路径，不能据此声称带 Digest 的同源换路径重定向已经验证。

BrowserBridge 的能力测试通过真实本地 WebSocket Hello 检查默认关闭、缺少持久处理器、明确启用三个状态。浏览器点击到 Host 的完整链由 Relay 所属 worktree 的隔离 QA 负责，须记录冻结 Host 的 SHA-256；本测试不安装应用、不更换用户扩展、不访问真实会话或下载目录。
