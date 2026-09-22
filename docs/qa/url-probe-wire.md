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
