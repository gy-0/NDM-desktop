# NDM 体验审查：从能下载到值得付费

日期：2026-09-08。范围：当前 Electron 渲染器、相关交互代码，以及本轮重新构建后运行的隔离 UI QA。未连接用户真实下载引擎、未操作用户任务。此文是审查记录，不是产品规格或限制后续设计的指令。

## 证据与边界

- 构建：`npm run build` 成功，日志 `/tmp/ndm-experience-audit-build.log`。
- 当前运行：`NDM_QA_OUTPUT=/tmp/ndm-experience-audit-20260908 node scripts/qa-workspace.mjs`，32 项通过、渲染器错误为 0；记录 `/tmp/ndm-experience-audit-20260908/report.json`。
- QA 使用真实构建的 React UI 和模拟 preload/任务，证明布局和交互，不证明真实浏览器接管、下载成功率、macOS 权限、安装结果或付费意愿。
- 主任务同时修复了下述分段绘制公式；本文截图来自修复前的本轮基线。修复是否完成应以主任务后续测试为准。
- 采用 Product Design audit 的截图与证据分离原则。未引用历史截图来宣称当前已验证；未进行真实新用户访谈、VoiceOver 全流程或性能耗电测量。

## 已观察的路径

1. 空任务库 → 添加下载入口：可操作，首次价值展示仍弱。
2. 下载主界面 → 调整窗口 → 打开详情：适应宽度已修复，窄窗信息取舍仍值得优化。
3. 总进度与分段 → 开关动画：基础行为通过，发现普通动画模式的分段数值失真。
4. 批量操作部分失败 → 留下未成功任务：通过，反馈明确，值得保留。
5. 切换浅色 → 排序、复制、设置：相关 UI 检查通过；真实硬件与辅助功能仍需验证。

### 1. 空任务库

![首次使用空任务库](/tmp/ndm-experience-audit-20260908/11-first-download.png)

### 2. 1024 px 窗口和详情

![主列表和详情共同占据窗口](/tmp/ndm-experience-audit-20260908/responsive-1024-details.png)

### 3. 总进度与下方分段区域

![总进度基线](/tmp/ndm-experience-audit-20260908/16-total-and-segments.png)

### 4. 部分批量操作失败

![只保留待处理任务与明确失败反馈](/tmp/ndm-experience-audit-20260908/13-partial-batch-failure.png)

### 5. 浅色主题

![浅色主题与排序菜单](/tmp/ndm-experience-audit-20260908/09-light-theme.png)

## 七个值得投入的具体问题

### 1. 真实分段完成状态比动效更重要

**状态：本轮已修复，并新增普通动画与尾部分裂回归。优先级 P0。**

修复前 `src/renderer/src/components/Connections.tsx` 的 `paintHost`、shared-motion 和初始 render 三条路径，将每段填充度乘上 `min(1, segment.fill / overall)`。总体 50%、某段完成 100% 时，那个已完成段最终只能画到 50%。用户据此判断“连接完成了吗、为什么分段又变了”，会得到错误答案。默认 reduced-motion 的 QA 分支没有这个公式，因此 32 项 UI 检查全通过也不能覆盖它。

验收：普通动画下总体 50%，两段分别 100% / 0%，第一段应填满；总体进度严格等于总已下载字节/文件大小；尾部分裂不抹掉已下载区域；暂停和 reduced-motion 保留同样的数据语义。分段是文件范围，活跃请求是调度状态，不能把视觉分段数宣传成实时 TCP 连接数。

### 2. 浏览器接管安装仍像开发工具，并且可用状态缺乏证据

**状态：代码确认仍存在；真实首次安装待验证。优先级 P1。**

`src/renderer/src/components/Onboarding.tsx:179` 要求开启开发者模式并加载本地解压目录。`Settings.tsx:989` 一带的“本地可用”是固定文案，不依赖某浏览器扩展最近一次握手。把目录准备好与浏览器已接通混为一谈，会让用户以为已配置完，实际仍不能接管下载。

付费价值：自动接管应当是用户最早体验到的省事能力；安装它反而比手动复制链接费事，会损失第一次成功。

验收：按浏览器提供准确安装入口；区分“扩展待安装”“等待连接”“已连接，版本 X”；提供无破坏性的测试接管。开发者加载只能标成测试安装路径。全新 macOS 用户不读开发文档，也能完成首次接管；记录完成时间与失败步骤，再制定转化指标。

### 3. 第一屏可用，但没有让用户迅速看到独特价值

**状态：截图确认当前现状；价值假设待用户研究。优先级 P1。**

`EmptyState.tsx` 当前只有“从一个链接开始”和添加按钮，左侧十余个空分类全部显示 0。它清楚，但用户仍需自己找到一个合适网址，才可能看见并行下载、媒体选轨、安装交付。界面没有回答“比浏览器下载好在哪里”。这不是再加一句夸张标语能解决的。

验收：用三种真实任务测试首日路径——大型普通文件、用户有权下载的网页视频、安装包。入口能直接到相应操作，并提供明确结果；演示必须主动触发且明确标识，不能偷偷下载示例或伪造速度。招募目标用户观察其第一次成功和第二次主动使用；在测量前不承诺“转化提高 X%”。

### 4. 响应式结构已修复，信息密度与详情层级还不够成熟

**状态：覆盖和裁切问题在隔离 QA 已修；信息组织仍存在改进空间。优先级 P2。**

1024 px 截图中详情真实占位，主列表缩到两列，状态移到文件次行。`components/ui/workspace.css:38` 的 container、`:47` 起的逐级隐藏以及统一内边距修复了旧截图中的横向溢出；主标题由 `LibraryToolbar.tsx:37` 固定为 20 px，没有随着详情开关缩字号。

但窄窗列表失去单个任务大小/速度/剩余时间，而详情首先占据大量链接和路径空间；用户为了查看“哪项还要多久”需要额外选择与搜索信息。长网址断行也在截图中占用两行，小字号的调节项和固定底部操作区进一步挤压详情。

验收：在 800/1024/1440 px、100% 和 125% 缩放下，当前状态与最有用的第二指标仍可直接辨认；完整网址/路径按需展开或复制，传输状态优先；列拖动、双击恢复、键盘调整维持稳定。用户能在 5 秒内回答某任务“进行到哪、还剩多久、下一步能做什么”，这一时间目标需要可用性测试验证。

### 5. 总进度与分段缺少肉眼可见的解释边界

**状态：本轮已补“分段进度”和“段数 · 活跃请求数”；陌生用户理解测试仍待执行。优先级 P2。**

`Hero.tsx` 已在分段上方渲染总进度并显示百分比，`Connections.tsx` 有包含分段数量的 aria-label；`Inspector.tsx:542` 也已区分配置上限、活跃请求和暂时限制。修复前截图中第二条线没有可见“文件分段”标签，普通用户容易把上下两条当重复装饰，也很难理解 32 路请求为何能有更多历史范围。

验收：按需出现简短说明，明确“总进度”“文件分段”，并可查看配置上限/当前请求数；不要永久增加一整行术语。HLS 应显示媒体片段语义，未知总长应明确不确定状态。用 32→31→32 的尾部接替录像向陌生用户测试解释是否足够，而不是只检查 DOM 存在两条 bar。

### 6. 已修细节应成为持续回归标准，不能又被主题或组件重构带回

**状态：多项已修；真实系统行为和辅助功能部分待验证。优先级 P2。**

- `TaskRow.tsx:219` 已安装 DMG 的“打开”指向默认打开磁盘映像；`:223` 调用 `openFile(filePath)`，不是启动已安装应用。本轮仅代码确认，未打开用户安装包。
- `lib/soundPolicy.ts` 全局排除 page/droplet/release，旧取消/导航声音调用不会重新响起。仍需实机听感评估剩余音效，不应仅凭“有音效”称为精致。
- 复制反馈 QA 验证了中间动画帧、成功确认、失败反馈与 reduced-motion。不能以动画结束代替实际写入确认。
- `index.css:47/67/87` 的 `--ok` 已是中性灰；组件名字 `text-sage` 不是当前显示绿色的证据。当前截图也未看到旧紫绿模板色。
- 快捷键总览按钮不常驻工具栏；搜索框自己的 ⌘F 提示仍保留，这是不同层级的提示。

验收：真实 DMG 打开遵循默认应用；安装完成不自动弹 Finder；取消全局静音；VoiceOver 和纯键盘可完成添加/复制/暂停/删除取消；背景与文字对比度实测达标。保留截图回归，同时补真实系统交互证据。

### 7. 商业化历史草稿必须继续与真实承诺隔离

**状态：当前已隔离，仍是发布准备风险。优先级 P1（开始收费前）。**

`lib/commercialization.ts` 当前关闭草稿入口，因此不能说用户现在被引导购买未完成能力。但 `lib/license.ts` 仍保留 $14.99/$24.99、永久更新、云同步/转换卖点，以及仅验证激活码格式的本地实现；`Inspector.tsx` 的 ProRow 解锁后会显示“即将推出”。这些内容不能作为需求研究结论，也不能通过一个 feature flag 就当成可售产品启用。

验收：正式付费能力逐项对应可以交付的路径与测试；定价由用户访谈/购买实验决定；明确更新权益和设备席位；实现可靠授权、恢复购买与退款支持。未完成功能不得出现在“已购买可用”清单。旧源码可保留作参考，但发布检查必须阻止草稿意外暴露。

## 建议顺序

先修进度真实性与浏览器首次接管，再测试窄窗信息层级和第一次成功路径。视觉上的惊喜应来自“任务做得完整且省心”：下载可靠结束、失败可恢复、拿到正确文件、安装交付自然。动效是这些行为的反馈，不替代这些行为本身。

本轮没有重做主题、引入组件库、改动真实用户数据或做 Git 提交。所有关于付费意愿、用户粘性和首次成功率的判断都是待验证产品假设，不是市场研究结果。
# Follow-up: completed segment recession

Read-only source audit after build 2026090804 found that `Connections.paintHost` and the shared-motion render branch scale every segment with `easedSegmentFill(segmentFill, trueFileFraction, paintedFileFraction)`. With two equal segments, A at 100% and B increasing from 0% to 20%, true file progress changes from 0.5 to 0.6 while painted progress can still be 0.5. A is then rendered at 0.5/0.6 ≈ 83.3% despite having no engine rollback.

Repair implemented for build 2026090806: all three segmented painting paths use independent range history. Render-only snapshots also record their authoritative target so a downward correction between animation frames is immediately visible. Pause/reduced motion settle once, removed IDs are pruned, and changed range geometry resets only its own history. The Hero retains one animation clock; the total bar and liquid front retain their shared overall motion.

Verification: old installed build 05 failed the actual renderer frame check with completed fill 0.833333. Updated development build sampled 62 frames with minimum completed fill exactly 1, intermediate progress on the advancing segment, aggregate area bounded by true progress, correct rollback [0.7, 0.1], paused fill [0.8, 0.2], isolated task switching and reduced-motion targets. Logs: `/tmp/ndm-segment-stability-red.log`, `/tmp/ndm-segment-stability-green.log`. Seven focused tests and 266 total script/UI-logic tests passed; typecheck and build passed. This proves measured rendering behavior, not broad subjective design quality or live website compatibility. Final signed-package validation and installation are recorded in the release log.

# Follow-up: compact transfer feedback

Build 2026090819 addresses finding 4 for active task rows: when columns collapse, speed and ETA remain in the subtitle; Inspector now includes ETA. At extremely small table widths, progress moves below the title/metrics rather than competing for a column. Collection rows preserve their height and progress. See [current verification and boundaries](COMPACT_TRANSFER_FEEDBACK_2026-09-08.md); OS/Electron zoom is not proven by CSS viewport simulation.
