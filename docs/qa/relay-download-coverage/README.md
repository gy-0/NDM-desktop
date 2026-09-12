# Relay 普通文件下载覆盖

日期：2026-09-12。此改动追加在 PR #5 的前置接管冻结提交 `d6e46c0` 后。只修改 Relay、测试、验收脚本与文档；配套安全 Host 由 PR #6 维护。

## 问题与行为

原版 Chrome 扩展 1.9.92 的代码核查表明它可以接管部分 `sub_frame` / `other` 文件下载。此前 Relay 的响应头自动接管仅允许 `main_frame`，避免把隐藏 iframe、XHR、DAT/BIN 和媒体分片变成任务。真实 Chrome 基线验证了其中的产品缺口：命名 iframe 打开的 ZIP 实际类型为 `sub_frame`，iframe 内 `a[download]` 的 ZIP 为 `other`，二者在 `d6e46c0` 都只由 Chrome 完成。

修复保留原来的 `shouldInterceptNavigation` 护栏。响应为普通 HTTP(S) GET 文件时只记下短暂候选；实际 `downloads.onCreated` 出现后，才以 URL/重定向链、时间、来源文档与完整 referrer 匹配该下载项。多个候选、文档已变化、来源信息不足、其他扩展创建的项目或已经完成/暂停的项目均保留给 Chrome。来源校验使用浏览器提供的 tab/frame/document 信息，不使用当前活动标签页猜测。

`other` 下载的 `webRequest` 在真实 Chrome 中可能不暴露 Referer，尽管源服务器收到正确值。这种情况必须有精确的请求 documentId/frameId 与 content port 文档匹配，并在下载项出现后用它的实际 referrer 再核对；已有请求 Referer 时也必须一致。隐私模式与来源 tab 需一致。

真实 fixture 还区分了属性与网络行为：本次 Chrome 对 iframe 内 `a[download] + rel=noreferrer` 仍发送完整 Referer，NDM 保留的值与浏览器一致；frame 响应设置 `Referrer-Policy: no-referrer` 时，浏览器 GET 与 DownloadItem.referrer 均为空，扩展保持 Chrome 独占。不能只用场景名称或 DOM 属性代替实际请求证据。

确认后复用持久交接队列：先保存意图与 Chrome 项的对应关系，再暂停该项；只有 native 返回持久 accepted/deleted 才取消并清理浏览器历史。首次明确拒收会恢复 Chrome；丢回执后使用同一 requestId 与 payload 重试。重复发送后的拒收或 payload-mismatch 保持未确认，不能释放第二个下载拥有者。新项及恢复发送均严格要求 `durableHandoff: 1` 和 `safeFileRedirects: 1`。旧 main_frame 路径保留兼容语义。

候选仅在 worker 内存中保留 30 秒，最多 64 项；恢复 worker 后不能凭 URL 猜测旧候选。session outbox 读取失败、容量已满或保存失败时不得新暂停浏览器。新路径暂停失败或发现浏览器已完成时不再发起 native 任务。Chrome 项已经创建，所以本路径属于后置接管，不能计入零 DownloadItem。

## 覆盖范围

允许归档、安装包等明确后缀：zip、7z、rar、tar、gz、tgz、bz2、xz、dmg、pkg、exe、msi、iso、epub、jar。响应 MIME 若为 HTML、文本、JSON/XML、脚本、PDF、图片、音视频则排除，文件名像 ZIP 也不能覆盖这些排除。无扩展名、未知二进制、DAT/BIN、流分片与普通网页资源不靠猜测扩大自动覆盖。

这条新增路径对最终请求方法为 POST、blob/data、已观察到 Basic/Digest 挑战的来源、无有效 referrer、离线和缺安全能力的 Host 保持浏览器处理；不改写原有 main_frame 分类。POST 经 303 等重定向成为普通 GET 文件时可按最终 GET 接管，不转交原 POST body。浏览器开始观察前已有的 HTTP 认证缓存仍是既有识别边界。此修复恢复有实证的普通 GET 文件覆盖，不声称与原版所有分类及所有站点完全相同。

前置同源链接接管和媒体弹窗验收分别见 [前置接管](../relay-click-handoff/README.md)与[媒体弹窗](../relay-media-shelf/README.md)；原版证据与现代 API 边界见 [原版/API 核查](../relay-click-handoff/original-and-api.md)。

## 实际验收

使用真实 Chrome 扩展及 PR #6 的冻结 Host `409448a1f73a28727bf4bcb7b61d2577d6852d5c`，二进制 SHA-256 `f60857dfdf23ad76d995e644fef920c43d0ff9a72e171184a8c04bc2606206e2`。所有文件为合成 2,097,152 字节，期望 SHA-256 `1e075c8d478ad21844e33e830a695ef03a4d2488b69ee275bd8947618bb1be1e`。旧 Host 场景单独记录真实缺能力二进制。

分类冻结阶段 18/18 真实场景通过。随后发现并修复绑定下载项前单次 session 写入失败的双拥有者问题，只改 `browser-handoff.js` 的失败分支，按影响补测 7/7：两类正常交接、首次保存失败、绑定保存失败、pause API 失败、首次拒收和丢 ACK。两项新故障加入后，共覆盖 20 个不同场景；没有把未重跑的分类报告标成最终 helper 全量验收。

| 实际下载 | 对应基线 | 修复后 | Chrome 创建 / interrupted / 擦除 | NDM 任务 |
|---|---|---|---:|---:|
| 命名 iframe ZIP（sub_frame） | d6e46c0：Chrome 完成 | NDM 完成 | 1 / 1 / 1 | 1 |
| iframe download 属性（other） | d6e46c0：Chrome 完成 | NDM 完成 | 1 / 1 / 1 | 1 |
| 绑定前存储只失败一次 | 修复中间态会同时发 native | Chrome 完成 | 1 / 0 / 0 | 0 |

第三行对比的是修复中间态，不是 `d6e46c0`：旧冻结 helper 的真实故障注入已复现未暂停 Chrome 却发送 native；最终 helper 下同一故障为 0 发送、0 暂停、0 native 任务，Chrome 文件完整。准备保存失败与暂停 API 失败也保持 Chrome；首次 native 明确拒收恢复下载，丢真实 ACK 则重试同一 ID 并只建立一个 native 任务。

最终 Relay syntax + Node **227/227** 通过，新增策略、后台来源关联与持久交接边界共 24 项。独立审查重放了精确单次写入失败，也验证终态保存再次失败时不会恢复用户自行暂停的 Chrome 项。

最终源码的 4/4 核心回归与 45/45 浏览器回归也通过：普通前置点击和双击仍为零 Chrome 项；首拒收的 bypass 保持 Chrome，query main_frame 仍走原持久后置流程。完整逐场景结果、各阶段源码/脚本/Host 哈希、实际请求类型与文档证明见 [机器可读验收](verified-results.json)。所有报告的隔离清理均通过。桌面 430 项测试、typecheck 与 build 已在前置冻结阶段通过；本次未改桌面或 native 源码。

## 复现

```sh
npm run fetch:mac-tools
NDM_QA_HOST_PATH=/absolute/path/to/safe/NDMHost \
NDM_QA_UNSAFE_HOST_PATH=/absolute/path/to/legacy/NDMHost \
npm run qa:relay-download-coverage
```

入口 [qa-relay-download-coverage.mjs](../../../scripts/qa-relay-download-coverage.mjs) 复用已有隔离 Chrome/Host 事件与产物验收，并使用 [专用 fixture](../../../scripts/qa-relay-coverage-fixtures.mjs)。`NDM_QA_BROWSER_PATH` 指定 Chrome for Testing；`NDM_QA_CASE` 选择场景，`NDM_QA_OUTPUT_DIR` 指定报告目录，`NDM_QA_EXTENSION_SOURCE` 选择冻结扩展。`NDM_QA_RECORD_ONLY=1` 只用于记录修复前实际行为，不能当作修复通过。

旧 Host 场景使用真实缺能力二进制。队列满使用合成 admission reservations；准备保存与绑定前保存故障分别只拒绝一次指定 session 写入，暂停故障只拒绝一次 pause API；首次拒收由代理截住尚未进入 Host 的请求再返回拒收；丢 ACK 只丢弃第一个真实回执。其余 Chrome 请求、下载事件、Host 任务、文件 SHA-256 与清理均实际验证，不用最终空下载列表替代 onCreated 事件计数。
