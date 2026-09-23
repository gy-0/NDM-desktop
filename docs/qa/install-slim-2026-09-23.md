# 2026-09-23 本机安装与包体瘦身

用户授权安装当前改进版到 /Applications 并启动，同时减少旧包 944.6 MB 的体积。

将已经由 Vite 编译到 renderer 的 UI 依赖改为 devDependencies，避免 electron-builder 再复制完整模块。保留主进程使用的 hash-wasm 为生产依赖。保留 26 份原依赖许可/通知文件到 licenses/renderer-dependencies，并明确纳入发行文件。下载内核、辅助工具和它们的源码/许可未裁剪。

实际文件字节（递归常规文件，不重复计算符号链接）：旧版 944569061，新版 569408276，减少 375160785 字节，约 39.7%。这也包含前序已完成的 out 打包范围收窄；本批去除额外前端模块约 45 MiB。新版 app.asar 的 node_modules 仅剩 hash-wasm。

npm test：716 通过、8 跳过、0 失败；typecheck 通过；npm run package 完成原生 release、前端构建、打包和稳定 Apple 本机签名。codesign --verify --deep --strict 通过；新版与旧版的 designated requirement 相同。日志 /tmp/ndm-slim-{tests,types,package}.log。此为本机安装验收，不代表 Developer ID 公证发行。

使用官方 version:next 将本机安装版本递增至 2026.9.23 / 2026092301；版本字段留在工作区，不纳入瘦身提交。用户原有 package 文件先保存到 /tmp/ndm-before-install-package{,-lock}.json。

先复制完整新包到 Applications 暂存目录；确认没有活动或等待下载后通过正常退出菜单快捷键结束旧版，没有强杀。原 bundle 留在 /Applications/.NDM-backup-2026091901.app；新包安装为 /Applications/NDM.app 并通过原生 UI 启动。实际设置页显示 v2026.9.23 / Build 2026092301，界面正常渲染；返回全部下载后将窗口置前。

真实任务库安装前后均 3739 项：complete 335、error 419、incomplete 2979、paused 6。按 ID 排序的 ID/状态 SHA-256 安装前后相同，没有重置暂停项。保持原雾昼主题，未导出任务名称、下载地址或会话内容。

原整夜 goal 和 heartbeat 保持暂停，本次仅执行用户新增安装/瘦身请求。
