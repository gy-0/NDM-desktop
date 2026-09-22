# URL 探测的真实 Electron 网络验收

生产规则测试不能证明 Chromium 实際遵守跳转策略。`qa-url-probe-wire.cjs` 加载生产探测模块，使用两个隔离 loopback HTTP 服务器、临时 Electron userData 和合成 Cookie；不访问用户浏览器资料。

在仓库根目录运行：

```sh
node_modules/.bin/esbuild src/main/urlContentType.ts --bundle --platform=node --format=cjs --external:electron --outfile=/tmp/ndm-probe-wire.cjs
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/qa-url-probe-wire.cjs /tmp/ndm-probe-wire.cjs
```

JSON `passed: true` 且退出码为 0 才算通过。覆盖同源 Cookie 保留、跨源 Cookie 清除及返回元数据一致、HTML 跳转后文件识别、HEAD 405 降级、无类型 GET 跳转、四次跳转上限、无响应超时、忽略 Range 的大响应在响应头后停止。输出仅记录合成请求的路径、方法、端口和是否带 Cookie，不输出 Cookie 内容。

2026-09-23 修复前，实际网络栈自动跟随跳转，同源 Cookie 保留、跨源 cookieUsed 元数据清除、应用层跳转上限三项失败；跨源实际 Cookie 本身未泄露。修复后全部通过。实现使用 Electron 的 manual redirect 事件逐跳返回给规则层，成功/失败都结束计时并中止当前探测，不缓存响应体。

API 语义核对：[Electron ClientRequest](https://www.electronjs.org/docs/latest/api/client-request)。本机实测中不能将 ClientRequest 的 close 回调单独当作请求失败，因此依靠 response/redirect/error 和超时完成请求。

此验收覆盖主进程网络模块，不替代真实网站登录或完整浏览器接管验收。

需要同时验收真实原生下载时，在命令末尾增加已构建的 NDMHost 绝对路径。脚本先以匿名请求得到登录页，再使用合成 Cookie 完成跨来源文件探测；将绑定到原始 URL 的会话交给隔离宿主创建任务，检查原地址收到 Cookie、CDN 没有 Cookie，并比对最终文件字节。`nativeSourceSession`、`nativeCDNAnonymous`、`nativeExactArtifact` 均须为 true。该宿主的支持目录、端口和偏好域均独立，退出后清理。

`cookieUsed` 仍描述探测最后一跳的 Cookie；`sourceCookie` 是成功分类所需的原始 URL 会话，包含严格绑定的 URL。任务创建只在地址完全一致、Header 不含换行时使用它，原生跳转边界继续负责禁止向 CDN 转交凭据。没有成功识别为文件时不返回该原始会话。

如需覆盖 renderer 的任务创建业务逻辑，先打包 `src/renderer/src/lib/store.ts` 为独立 CommonJS 文件，并把其绝对路径作为最后一个参数传入。脚本使用合成 IPC 适配器将实际 `addFromUrl` 连接到当前分类结果和真实宿主 RPC；`creationHeadersPreserved` 检查原请求的 Referer、自定义头没有被自动 Cookie 覆盖。它不操纵 DOM，也不等同于 GUI 验收。

```sh
node_modules/.bin/esbuild src/renderer/src/lib/store.ts --bundle --platform=node --format=cjs --outfile=/tmp/ndm-store-logic.cjs
# 在上面的 Electron 命令后依次追加 NDMHost 绝对路径和 /tmp/ndm-store-logic.cjs
```

带任务创建模块运行时还会探测 `/login.zip`：服务器明确返回 HTML，媒体探测返回无格式。`htmlFileRejected` 与 `htmlCreatedNoTask` 验证它不能以普通文件成功记录进入任务库。显式网页保存或带自定义请求头的调用另由单元测试覆盖，避免将匿名探测结论覆盖到另一种请求上下文。该检查不是通用文件内容扫描，也不覆盖所有绕过创建模块的下载入口。
