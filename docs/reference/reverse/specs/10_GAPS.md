# 10 · 未闭合缺口（动态分析待办）

下列项静态分析无法 100% 钉死，需调试/抓包/更多样本后冻结。

## 已取消 / 降级

| ID | 原计划 | 现状 |
|----|--------|------|
| ~~原版 Chrome 扩展完整逆向~~ | 深挖 bg.js/ct.js | **取消**。Chrome 侧以 **BetterNDM** 为准（协议已兼容） |
| 扩展 UI/捕获逻辑 | 自己重写 | **复用 BetterNDM**，我们只实现宿主 WS 服务端 |

## P0（实现前建议补齐 —— 仅宿主）

| ID | 缺口 | 建议方法 |
|----|------|----------|
| G01 | ~~动态分段的精确最小段长与退避阈值~~ | **已关闭（反编译 + 运行日志）**：普通模式规划量子 `0x3A000`、候选父段阈值 `0x32000`；另一模式为 `0x88000` / `0x80000`。空闲 socket 持续拆取未完成尾部，段数可超过 32，并在失败时 rollback + merge |
| G02 | ~~`segments.bin` state 枚举~~ | **已关闭**：第二字段是 `segmentId`（`seg.xN`），不是状态 |
| G03 | WebSocket **服务端**与 BetterNDM 联调（握手 + `waiting`/`nowaiting`） | 用 BetterNDM 连原版/我们的实现各一次 |
| G04 | ~~AES256 密钥与 `encryptString`~~ | **已关闭（r2）**：密钥 `SG2921` 零填充 32B，AES-256-CBC，IV=0，PKCS7，Base64 → 见 `13_CRYPTO_AES.md` |
| G05 | NTLM / Digest 完整实现 | 对测试服务器抓包对比 |

## P1

| ID | 缺口 |
|----|------|
| G06 | HLS：master/media playlist 选择、密钥（AES-128 字符串存在）、断点 |
| G07 | MKV mux 规则（时间戳、轨道顺序） |
| G08 | `CategoryFolders` / `UseUAgent` 整型枚举语义（样本见 2） |
| G09 | SOCKS4/5 握手细节 |
| G10 | 检查更新文件格式 `checkVersionFile` |
| G11 | `urla` 与 MKV 双引擎启动完整条件 |
| G12 | ObjC 部分 superclass 在 otool 相对指针下解析偏差（以 methods/ivars 为准） |

## P2

| ID | 缺口 |
|----|------|
| G13 | Windows 版协议是否同构（本仓库仅 Mac 二进制） |
| G14 | 历史旧版本 segments 兼容 |
| G15 | 精确 UI 布局坐标（NIB 可另用 ibtool 导出） |

## 建议的动态分析会话清单

1. **干净 HTTP 大文件**：从 0 下完，保存完整 LogFile + segments 演化副本  
2. **中途暂停/继续**  
3. **改连接数 8→32** 观察段分裂  
4. **扩展右键下载** 抓 WS 明文  
5. **需要 Digest 的测试站**  
6. **m3u8 视频** 一次  
7. **YouTube 分轨**（若仍可用）看 MKV 窗  

## 已冻结（主路径可重写）

| 区域 | 规格 |
|------|------|
| 模块边界 | `12_MODULE_BOUNDARIES.md` + `00_OVERVIEW.md` |
| ObjC UI / 编排 | `02` `08` `11` |
| SQLite + 任务目录 | `05` + `fixtures/neatdb_schema.sql` |
| segments 布局 | `04` + fixtures + `parse_segments.py` |
| 引擎主路径 + 状态机 | `03` `09`（含 Merging、4125 样例） |
| 设置键 | `06` |
| 宿主 WS 服务端协议 | `07` + `protocol_message.py` |
| 偏好 AES 加密 | `13` + `ndm_crypto.py`（**r2 从指令级还原**） |
| Chrome 扩展 | **BetterNDM**（非宿主缺口） |

## 分析目标完成边界

本仓库分析交付 **不要求** 关闭 G05（Digest/NTLM 线级）。G01 动态切分公式与 G04 AES 密钥均已关闭。
这些列为 **实现前建议动态分析**，不阻塞「规格可指导功能等价重写」。

**结论：** 主路径规格已冻结；开放 P0 已显式登记，无静默空洞。
