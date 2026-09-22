# Relay 商店安装入口

正式分发使用本产品自己的 Chrome Web Store 条目。不得引用历史参考文档中其他产品的扩展 ID，也不能凭搜索结果或占位 ID 构建发行包。

商店条目发布并核实归属、名称、版本与权限后，构建前设置 `NDM_RELAY_STORE_URL` 为完整条目 HTTPS 地址，再运行现有 `npm run package`。该值在 electron-vite 构建主进程时固定，运行时环境变量不能重定向已构建应用的安装入口。只接受 `chromewebstore.google.com/detail/<slug>/<32位扩展ID>` 或无 slug 的条目 URL；查询参数、片段、凭据及非官方域名会使构建失败。

欢迎页和设置页共用安装组件：

- 已配置有效条目：显示商店入口；打开失败可重试，安装后继续由真实 worker 握手检测连接。
- 正式包未配置：说明当前版本尚未提供商店入口，保留粘贴链接下载，不提供开发者模式安装。
- 开发构建未配置：额外提供折叠的“开发测试安装”。

当前仓库没有真实商店条目配置。本次仅完成发行入口实现，未创建或发布商店条目。URL 格式校验不证明条目存在、归属正确或已审核；正式发行前须在目标浏览器从真实条目安装并验收一次文件接管和视频发送。

## 生成商店上传候选包

在仓库根目录运行（需要 Python 3 标准库，无额外 Python 依赖）：

```sh
npm run test:relay
python3 -m unittest discover -s scripts -p test_package_relay_store.py -v
python3 scripts/package-relay-store.py --output dist/NDMRelay-1.4.17-store.zip
```

脚本保留运行脚本、弹窗、图标、字体、语言目录和第三方 LICENSE；排除 tests、package.json、开发说明和隐藏开发文件。校验 manifest/package 版本一致、Manifest V3、本地化名称/简介、声明资源、importScripts、HTML/CSS 本地引用，以及 ZIP 中每个文件的字节内容。manifest.json 位于 ZIP 根目录，固定文件顺序和时间戳，同一环境同一源码重复生成可得到一致 SHA-256；已有输出会拒绝覆盖。

CI 的 Linux 作业生成 `relay-store-upload-candidate` 产物。这是开发者上传候选文件，不是客户侧安装方式，也不代表商店审核通过。商店元数据、隐私披露、截图、条目归属和真实安装验收仍须完成；脚本不审定这些内容，不上传到商店，不分配扩展 ID。

依据：[Chrome 官方发布准备要求](https://developer.chrome.com/docs/webstore/prepare)，上传 ZIP 必须将 manifest 放在根目录，更新版本需递增。首次上架后的具体版本以真实条目为准，本脚本不擅自递增版本。
