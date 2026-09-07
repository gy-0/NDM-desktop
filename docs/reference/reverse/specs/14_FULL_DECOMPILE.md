# 14 · 全量反编译交付说明

## 用户目标

> 百分百、完全把人家代码抠出来。

## 实际交付

| 交付 | 状态 |
|------|------|
| arm64 二进制 **Ghidra 全函数反编译** | ✅ 2147/2147 成功 |
| 输出伪 C | `dumps/full_decompile/ghidra_c/` |
| ObjC 方法名保留 | ✅（metadata 未 strip） |
| C++ 原符号名 | ❌ 二进制 stripped → `FUN_地址` |
| 可编译还原工程 | ❌ 伪代码需人工整理 |
| 作者注释/原目录结构 | ❌ 仅字符串泄漏路径 |

## 与「原版源码」的差距

反编译 **≠** 从 Git 拉出 `NeatForMac-1.3.24`：

- 控制流、调用、常量：**可恢复**（本次已做）  
- 变量名、类布局、注释：**不可完整恢复**  
- 直接当商业产品「NDM 开源版」发布：**有版权风险**；应用方式是对照伪代码做 **clean-room 重写**

## 工具链

- Ghidra 12.1.2 `analyzeHeadless` + `tools/GhidraDecompileAll.java`
- radare2（点杀 AES / xref）
- Hopper（本机已装，可 GUI 复核）

## 如何继续抠引擎

见 `dumps/full_decompile/ENGINE_FUN_MAP.md` 的大函数列表与阅读顺序。
