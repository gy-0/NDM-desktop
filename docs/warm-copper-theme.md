# 暖铜（teak/copper）主题 accent 预处理与将来落地清单

> 历史设计探索，未获选为当前产品方向。下面的色值与测试数量仅对应当时快照；新的设计以当前用户反馈和实际视觉评审为准。

> 目标：把此前"暖铜配色升级建议"从**设计调研**推进到**可安全落地的候选状态**，
> 但**不**未经预览就全局更换 `--accent`。本文档给出三主题暖铜候选的完整前后对照、
> 对比度自证结果、被测试锁定的色值清单，以及将来落地（验收、开开关、迁移 `text-copper`）的最小步骤。

## 1. 背景与约束

- 全站 `--accent` 至今是中性色（墨夜 `#f0f0f2`、雾昼 `#25262a`、白昼 `#303238`）。
- `themeColorSystem.test.mjs` 锁定了（对**当前**三主题色值）：

  | 断言 | 门槛 |
  | --- | --- |
  | `paper`(primary text) vs `ink` | ≥ 7 |
  | `on-accent` vs `accent` | ≥ 4.5 |
  | `fog`(secondary)/`mist`(muted) vs `ink` 与 `raised` 双表面 | ≥ 4.5 |
  | 无 AI 蓝 `#365fd9/#97acff/#3478f6`、无琥珀 `#d79343/#b86e36/#d08a3a` | — |
  | 每个主题 `--hero-glow: transparent` ×3 | — |

- 测试**没有**圈禁 `--shadow-*`、`--radius*` 的色值；它们可以安全低风险调整。
- 测试按**当前** token 算断言；本文档提出的暖铜候选**必须在每一主题下继续满足这些门槛**才能落地。

## 2. 提案：暖铜 accent 候选（三主题）

| 主题 | token | 现值 | 拟改（暖铜） | on-accent 现值 | 拟改 on-accent | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 墨夜 walnut | `--accent` | `#f0f0f2` | `#b0885c` | `#17181c` | `#22160e` | **必须**同时把 on-accent 改深，否则 3.35 不达标 |
| 墨夜 walnut | `--accent-deep` | `#d5d6da` | `#a97a52` | — | — | `accent-deep` 未进测试，改深铜以补 hover/边框 |
| 雾昼 dawn | `--accent` | `#25262a` | `#a97a52` | `#f8f8f7` | `#1c110a` | 同左 must |
| 雾昼 dawn | `--accent-deep` | `#101114` | `#8a5e3a` | — | — | — |
| 白昼 noon | `--accent` | `#303238` | `#a97a52` | `#f7f7f8` | `#1c110a` | 同左 must |
| 白昼 noon | `--accent-deep` | `#181a1e` | `#8a5e3a` | — | — | — |

每主题 `--ink/raised/fog/mist/paper` 保持现状**不动**。

## 3. 对比度自证（`node scripts/verify-theme-contrast.mjs`）

脚本封装成本仓库 `themeColorSystem.test.mjs` 完全相同的 WCAG luminance/contrast 数学，
并对每主题断言同一阈值；另有 `copper fg` advisory 规则（非测试锁定）。

| 主题 | 检查 | 实测 | 门槛 | 通过 |
| --- | --- | --- | --- | --- |
| 墨夜 walnut | paper/ink ≥7 | **18.07** | 7 | ✔ |
| 墨夜 walnut | on-accent/accent ≥4.5 | **5.48** | 4.5 | ✔ |
| 墨夜 walnut | fog/ink、fog/raised ≥4.5 | 11.63 / 10.18 | 4.5 | ✔ |
| 墨夜 walnut | mist/ink、mist/raised ≥4.5 | 5.84 / 5.44 | 4.5 | ✔ |
| 墨夜 walnut | copper fg on raised/ink ≥3 | 4.93 / 5.86 | 3 | ✔ (advisory) |
| 雾昼 dawn | paper/ink ≥7 | **15.88** | 7 | ✔ |
| 雾昼 dawn | on-accent/accent ≥4.5 | **4.93** | 4.5 | ✔ |
| 雾昼 dawn | fog/ink、fog/raised | 7.28 / 7.56 | 4.5 | ✔ |
| 雾昼 dawn | mist/ink、mist/raised | 4.82 / 4.94 | 4.5 | ✔ |
| 雾昼 dawn | copper fg on ink/raised ≥3 | 5.24 / 5.61 | 3 | ✔ |
| 白昼 noon | paper/ink ≥7 | **17.72** | 7 | ✔ |
| 白昼 noon | on-accent/accent ≥4.5 | **4.93** | 4.5 | ✔ |
| 白昼 noon | fog/ink、fog/raised | 6.99 / 6.99 | 4.5 | ✔ |
| 白昼 noon | mist/ink、mist/raised | 4.94 / 4.94 | 4.5 | ✔ |
| 白昼 noon | copper fg on ink/raised ≥3 | 5.61 / 5.61 | 3 | ✔ |

**结论：全部 23 项通过。** 暖铜 accent 三主题是可行的，只要遵守：

- 每个主题的 `on-accent` 必须改成**深暖棕**（`#22160e`/`#1c110a`），不能用浅色 on-accent；
- 浅色主题（dawn/noon）若把铜色当作 `text-copper` 前景放在 ink 上，必须用**深铜** `#8a5e3a`（`#a97a52` 在 `#f7f7f8` 上仅 3.51，不达标）。

## 4. 被测试锁定的值（红线，勿改）

- 三个主题的 `--ink`（`#111113` / `#f7f7f8` / `#ffffff`）。
- 三个主题的 `--raised`（`#222225` / `#ffffff` / `#ffffff`）作为 fog/mist 背景。
- 三个主题的 `--fog` / `--mist` / `--paper`。
- `--hero-glow: transparent` ×3。
- 禁绝任意 `--accent`/`--on-accent` 使用 AI 蓝 `#365fd9/#97acff/#3478f6` 与琥珀 `#d79343/#b86e36/#d08a3a`。
- `src/main/index.ts` 的三组 native window 色（`walnut: '#101114'` / `dawn: '#f1f1ef'` / `noon: '#f5f6f7'`），并禁绝 `#141210/#f4efe6/#f5f4f0/#f7efe2`。

> 注意：测试锁定的是"**现有值**"的对比关系，而非字符串本身；若将来改 accent 为暖铜，
> 需要把 `--on-accent` 等一起改并重跑脚本，脚本全部通过才能提交。

## 5. 已可安全落地（本轮已完成）

| 变更 | 风险 | 说明 |
| --- | --- | --- |
| `--shadow-row/popover/dialog` 黑阴影加极少暖 tint | 无 | `rgb(26 13 8 …)`, `rgb(22 12 6 …)`, `rgb(20 11 5 …)`——视觉中性，不留类名，仅替换字面黑。 |
| `--shadow-ring` 已用 `color-mix(var(--accent) 42%, transparent)` | 无 | 跟随 accent 变化，focus 环样式不回退；无需改动。 |
| `--radius-control`/`--radius-surface`/`--radius-track` 语义 token 已存在 | 无副作用 | 组件仍用字面 `rounded-[7px]`/`rounded-xl`/`rounded-[12px]`，这些 token 当前无引用；`--radius` 每主题自带值且无引用，改它无副作用，但本轮不改（避免大改类名）。 |
| `scripts/verify-theme-contrast.mjs` | 无 | 一次性对比度守卫，未接入测试套件（不进 155 项），作为落地前自证。 |

## 6. 可控开关（不接 UI，默认关闭）

- `src/renderer/src/lib/themes.ts` 新增常量 `COPPER_ACCENT_ENABLED = false`。

落地时：

1. 在 `index.css` 每个主题块后追加：
   ```css
   [data-theme='walnut'][data-accent='teak'] { --accent: #b0885c; --on-accent: #22160e; --accent-deep: #a97a52; }
   [data-theme='dawn'][data-accent='teak']   { --accent: #a97a52; --on-accent: #1c110a; --accent-deep: #8a5e3a; }
   [data-theme='noon'][data-accent='teak']   { --accent: #a97a52; --on-accent: #1c110a; --accent-deep: #8a5e3a; }
   ```
2. 把 `COPPER_ACCENT_ENABLED` 改为 `true`，在应用根部（`data-theme` 同节点）设置 `data-accent='teak'`。
3. **浅色主题的 `text-copper` 必须同时用深铜**：`--copper` 跟随 `--accent`（现映射 `--color-copper: var(--accent)`），
   需把 copper 前景改为 `var(--accent-deep)`（或单独 `--copper-ink`) 才满足 3:1。
4. 重跑 `node scripts/verify-theme-contrast.mjs`，再 `npm test` 确认 155 项全绿。

若不接开关，也可按上一节直接改 `index.css` 的值——但**必须**同步改 on-accent 并重跑脚本。

## 7. 后续人工预览建议

在画廊页/设置-外观中临时把第 6 节的候选值整块替换到 `:root`，肉眼确认三主题：
- 墨夜下暖铜按钮与深棕文字的可读性；
- 雾昼/白昼下铜色 chip、hover 边框是否顺眼；
- 决定后按第 6 节开开关，或保持现状。
