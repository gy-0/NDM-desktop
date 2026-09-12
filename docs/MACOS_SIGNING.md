# 本机更新与文件夹授权

本机部署必须使用稳定的 Apple 代码签名身份。Ad-hoc 签名的 designated requirement 依赖代码哈希，重新构建会改变 macOS 用来匹配隐私授权的身份。

`scripts/sign-macos-bundle.mjs` 自动选用钥匙串中唯一可用的 Apple Development 或 Developer ID Application 身份；有多个身份时用 `NDM_SIGNING_IDENTITY` 明确指定。除外层 App，还显式签名 Resources 中的 NDMHost，并固定其标识符。不要在更新时更换签名身份。

从旧 ad-hoc 版本迁移后可能需要用户允许一次“下载”文件夹访问。后续更新应保持相同的 designated requirement。脚本不修改 TCC 数据库、不重置授权，也不需要保存电脑密码。本机开发签名不等同于公开分发所需的 Developer ID 签名与公证。

每次新构建先运行 `npm run version:next`，同步 package.json 与 lockfile 的日期版本，并递增当日构建号。`npm run deploy-app` 会拒绝安装构建号没有增加的包，避免代码更新但版本不变。

`npm run deploy-app` 先构建、验证和暂存，再确认没有正在下载、启动或合并的任务，正常退出旧应用并替换 `/Applications/NDM.app`；替换失败恢复旧包。用户已于 2026-09-08 明确授权：新应用启动且引擎响应后，永久删除本次部署生成的旧包，实际释放空间，不再移入废纸篓。启动验证失败则保留旧包并报告路径；不会清空用户废纸篓。`-- --skip-build` 可安装已经验证的构建。

需要保留本次更新的回退包时，使用 `npm run deploy-app -- --keep-backup`，或对已验证的构建使用 `npm run deploy-app -- --skip-build --keep-backup`。成功安装及任务恢复后，脚本保留旧 App，并输出实际 `/Applications/.NDM-backup-….app` 路径；首次安装没有旧包时明确说明。未传此选项时，仍按默认行为清理旧包。

CI 若明确需要无稳定隐私身份的临时产物，须显式设置 `NDM_ALLOW_ADHOC_SIGNING=1`；本机部署仍拒绝这种产物。

参考：[Apple TN3127: Inside Code Signing Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)。

2026-09-08 本机验证：用户完成从旧身份迁移的一次授权后，再打包更新 App 和 NDMHost；两者代码哈希改变，designated requirement 保持一致。02:16:53 的 DownloadsFolder 权限请求直接返回允许（authValue=2），没有再次进入 AUTHREQ_PROMPTING。
