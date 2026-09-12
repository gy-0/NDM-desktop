# 冻结的真实场景

所有下载完成场景均匹配 2,097,152 字节合成源文件 SHA-256 `1e075c8d478ad21844e33e830a695ef03a4d2488b69ee275bd8947618bb1be1e`。`interrupted` 是状态事件计数；只有创建数为 0 才算未创建 Chrome 下载项。网页处理和 SPA 导航场景不应创建下载文件。

| 场景 | 最终处理者 | Chrome 创建 / interrupted / 擦除 | NDM 任务 |
|---|---|---:|---:|
| 跨源重定向与凭据隔离 | ndm | 0 / 0 / 0 | 1 |
| 多个 meta Referrer 策略 | chrome | 1 / 0 / 0 | 0 |
| 移除后的 Referrer 策略 | chrome | 1 / 0 / 0 | 0 |
| 多个 HTTP Referrer 策略 | chrome | 1 / 0 / 0 | 0 |
| 发送前队列满 | chrome | 1 / 0 / 0 | 0 |
| 首次明确拒收 | chrome | 1 / 0 / 0 | 0 |
| 丢 ACK 后关闭页面 | ndm | 0 / 0 / 0 | 1 |
| 跨源 Basic 认证 | chrome | 1 / 0 / 0 | 0 |
| 跨源 Basic 认证缓存 | chrome | 1 / 0 / 0 | 0 |
| 同源 Basic 冷挑战 | chrome | 1 / 0 / 0 | 0 |
| 同源 Basic 缓存 | chrome | 1 / 0 / 0 | 0 |
| Basic 认证标记跨 worker 重启 | chrome | 1 / 0 / 0 | 0 |
| 页面 hash 从 Referer 移除 | ndm | 0 / 0 / 0 | 1 |
| 键盘 Enter 下载 | ndm | 0 / 0 / 0 | 1 |
| noreferrer 链接 | chrome | 1 / 0 / 0 | 0 |
| 链接 no-referrer | chrome | 1 / 0 / 0 | 0 |
| 普通 ZIP | ndm | 0 / 0 / 0 | 1 |
| download 属性链接 | ndm | 0 / 0 / 0 | 1 |
| 含 query 的 download 链接 | ndm | 0 / 0 / 0 | 1 |
| Cookie 认证同源重定向 | ndm | 0 / 0 / 0 | 1 |
| 未确认的普通重定向 | ndm | 1 / 1 / 1 | 1 |
| NDM 离线 | chrome | 1 / 0 / 0 | 0 |
| HEAD 405 | ndm | 1 / 1 / 1 | 1 |
| HEAD 超时 | ndm | 1 / 1 / 1 | 1 |
| 准备期间 SPA 导航 | page-changed | 0 / 0 / 0 | 0 |
| 网页自行处理点击 | page-handler | 0 / 0 / 0 | 0 |
| ZIP 路径实际返回 HTML | navigation | 0 / 0 / 0 | 0 |
| 无 download 属性的 query 链接 | ndm | 1 / 1 / 1 | 1 |
| 重复点击 | ndm | 0 / 0 / 0 | 1 |
| 丢失首个真实 ACK | ndm | 0 / 0 / 0 | 1 |

完整能力、源码/Host/脚本哈希和跨源请求头 presence 结果见 [verified-results.json](verified-results.json)。
