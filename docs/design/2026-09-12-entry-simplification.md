# 设置与添加下载入口收拢

普通下载设置不再要求用户决定是否开启“智能连接调节”。连接数量放到默认折叠的“高级连接设置”，需要排障时仍可调整；日常页面继续显示任务并行和限速。添加下载页去掉空闲页脚的“支持链接、磁力链与批量粘贴”宣传，单链接路径保持原样。

生产改动仅在 `Settings.tsx` 与 `Composer.tsx`。移除的本地状态和回调只服务于旧智能开关；引擎设置类型、读写接口和后台策略保留。未做设置迁移：默认目标上限 32、应用不限速、智能关闭均未改变；已有用户设置按引擎返回值读取。32 是目标上限，不是固定实际连接数。

已有多链接解析、去重、无效输入提示、目的地、草稿恢复和创建回执路径未改动。`qa-settings-persistence.mjs` 现在先展开高级区再操作连接数。

## 真实应用验证

运行 `node scripts/qa-entry-simplification.mjs --before` 保存改动前画面，统一构建后运行 `node scripts/qa-entry-simplification.mjs`。两轮均通过；Electron `pageerror` 为 0。

最终复验基于源码提交 `44feaaa93dfb6ed5931c33d5c40645d731e6dc52`，使用冻结构建 `index-BqdmHPzQ.js` / `index-DQsuxpx-.css`。所有场景再次通过，7 张 after 截图已更新，1220 × 820 逻辑视口均无横向溢出，页面错误为 0。renderer JS 的 SHA-256 为 `7061313fcce6ed74b5c5a6d6c27240413a0a7c0f7b64e57c4beeaf7821f7849d`；main、preload 与 CSS 的完整指纹保存在[最终运行记录](assets/2026-09-12-entry-simplification/after/result.json)。

- 打开下载设置没有发出设置写入；普通界面没有智能开关，连接数默认折叠。
- 初始 32 / 智能关闭 / 不限速保持原值。注入连接数保存失败后，界面仍选中 32，并显示“未能保存连接数。请重试。”；重试成功才切到 16。
- 已有 8 / 智能开启 / 5 MB/s 配置，打开界面不写回。手动改为 16 后，智能开启和 5 MB/s 保留。
- 单链接粘贴保持直接表单，不自动创建任务；无效输入显示错误，不创建任务。
- 粘贴两个不同链接和一个重复链接得到两项清单，不自动创建任务。关闭并重开后，真实隔离草稿恢复这两项。
- 明确点击“下载 2 项”后，fixture 收到两次创建请求，各自带有创建键、32 路目标及已选目录，并返回逐项回执。

另外，现有 `settingsCapabilities`、`composerBatch`、`composerDraft`、`composerDraftSession`、`sharedLink` 聚焦检查共 **42/42 通过**，使用仓库同等 esbuild 转译方式。QA 脚本语法检查与 `git diff --check` 通过。

## 前后证据

| 场景 | 之前 | 之后 |
| --- | --- | --- |
| 下载性能 | [截图](assets/2026-09-12-entry-simplification/before/settings-performance-1220.png) | [截图](assets/2026-09-12-entry-simplification/after/settings-performance-1220.png) |
| 添加下载空闲状态 | [截图](assets/2026-09-12-entry-simplification/before/composer-idle-1220.png) | [截图](assets/2026-09-12-entry-simplification/after/composer-idle-1220.png) |
| 单链接 | [截图](assets/2026-09-12-entry-simplification/before/composer-single-link-1220.png) | [截图](assets/2026-09-12-entry-simplification/after/composer-single-link-1220.png) |
| 多链接清单 | [截图](assets/2026-09-12-entry-simplification/before/composer-batch-review-1220.png) | [截图](assets/2026-09-12-entry-simplification/after/composer-batch-review-1220.png) |

[高级连接设置展开](assets/2026-09-12-entry-simplification/after/settings-advanced-1220.png) · [保存失败反馈](assets/2026-09-12-entry-simplification/after/settings-save-failure-1220.png) · [之前运行记录](assets/2026-09-12-entry-simplification/before/result.json) · [之后运行记录](assets/2026-09-12-entry-simplification/after/result.json)

两轮记录包含实际 main、preload、renderer 构建文件的 SHA-256。截图来自真实 Electron，使用新建临时数据目录、私有 TCP fixture 引擎和合成任务；草稿使用真实主进程的隔离持久化路径。下载和设置引擎回执为 fixture，不代表真实网络下载、Swift 引擎或原生安装验证。没有连接真实下载库或覆盖主应用。
