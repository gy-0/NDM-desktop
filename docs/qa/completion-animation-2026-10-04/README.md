# 完成烟花与黑屏回归验证

用户要求保留完成烟花并修复播放前卡顿。本次恢复完成烟花，将 canvas-confetti 切到 Worker，挂载时用零粒子预热画布，CSP 仅新增 worker-src self/blob 许可。保留减少动态效果、操作期间清除、每次真实状态转换触发的边界。

隔离 Electron 实例注入合成下载完成快照；不操作真实下载。安装版第一次最大 RAF 帧间隔 633.6 ms，随后 92.2/75.2 ms。开发版第一轮 91.7/9.4/9.4 ms，独立重复启动一轮为 9.4/9.4/9.4 ms。已观察 blob Worker，并截图确认粒子可见。数据是界面事件回放，不是网络下载端到端、Windows 实机或绝对无卡顿保证；首次 91.7 ms 的波动保留，不只报告最好结果。

最初 QA 把合法 compressed 类别误写为 archive，触发未定义图标 React #130，清空界面。该次没有动画的帧测量作废；测试数据已纠正，Marks 与 CompletionPocket 增加未知类别通用图标兜底，并通过未知类别快照运行回归验证。已关闭本次隔离实例；未替换安装 App。

验证：npm test 731 通过、8 跳过；typecheck 与 build 通过。

复现：`node scripts/qa-completion-frame-audit.mjs`。用 NDM_QA_APP_PATH 指定安装版可测基线；NDM_FRAME_REPORT 指定 JSON；NDM_FRAME_SCREENSHOT 指定粒子截图。截图采集会影响帧测量，性能数据须在不设截图参数的独立运行采集。
