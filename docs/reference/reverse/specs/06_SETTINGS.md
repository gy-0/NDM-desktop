# 06 · 设置与偏好

## 存储

`~/Library/Preferences/com.NeatDownloadManager.plist`  
访问：`NeatNsUtils` 的 `getSetting*` / `setSetting*` 系列。

## 键表

| Key | 类型 | 含义 | 样本/默认 |
|-----|------|------|-----------|
| `AppAutoStart` | int/bool | 登录启动 | 1 |
| `BandWidthLimit` | number | 全局限速（0=不限） | 0 |
| `CategoryFolders` | int | 按分类建子目录 | 2（可能是三态/枚举） |
| `CompletionDialog` | int | 完成后弹窗 | 1 |
| `ConnectionsAtOnce` | int | 1=同时多任务 / 其它=逐个 | 1 |
| `DefaultAgent` | string | 自定义 UA | `""` |
| `UseUAgent` | int | 是否用自定义 UA | 2 |
| `DownloadDirectory` | string | 默认下载目录 | `~/Downloads/` |
| `MaxConnections` | int | 单任务最大连接 | **32** |
| `LastDownloadID` | int | 最后任务 id | 递增 |
| `ChromePanel` | int | 扩展媒体面板（Chrome） | 1 |
| `FoxPanel` | int | Firefox | 1 |
| `EdgePanel` | int | Edge | 1 |
| `HTTP_IsActive` | bool | HTTP 代理开关 | |
| `HTTP_ProxyAddress` | string | | |
| `HTTP_ProxyPort` | int | | |
| `HTTP_ProxyType` | int | | |
| `HTTP_UserName` | string | | |
| `HTTP_PassWord` | string | **AES 密文 Base64** | |
| `HTTPS_*` | 同上 | HTTPS 代理 | |
| `FTP_*` | 同上 | FTP 代理 | |
| （推断）SOCKS 相关 | | `getSettingSocksVersion` | |

> 键名拼写为 `PassWord`（W 大写），复刻时需兼容。

## 设置窗口绑定（NeatSettingWindow）

- 下载目录：`txtDlDirectory` + `directoryBtnClicked:`
- UA：`txtUserAgent` + `chkUseUAgent` + `resetAgentBtnClicked:`
- 连接：`comboConnections` + `radioAllAtOnce` / `radioOneByOne`（方法名 `setSettingConnectionsAllAtOnce`）
- 完成对话框 / 开机启动 / 分类文件夹：`chkCompleteDialog` `chkAppStart` `chkCategoryFolders`
- 代理矩阵：`mtxProxyType` `mtxSocksVersion`
- HTTP/HTTPS/FTP 主机端口用户密码 + enable checkbox
- 凭据表：`credentialsTable` + remove

## 加密

Selectors：

- `encryptString:` / `decryptString:`（`NeatNsUtils` 类方法）
- `AES256EncryptWithKey:` / `AES256DecryptWithKey:`（`NSData` category）

**已用 radare2 完整还原** → 详见 [`13_CRYPTO_AES.md`](./13_CRYPTO_AES.md)：

- 密钥常量：`SG2921`（零填充至 32 字节）
- AES-256-CBC + PKCS7 + IV 全 0 + Base64
- 空串密文：`BqhotGJODXhOF2DHpxSOGQ==`（与 live plist 一致）
- 工具：`reverse/tools/ndm_crypto.py`

## 登录项

- `setLaunchAtStartup:`
- `itemRefInLoginItems`
- `wasLaunchedAsLoginItem`

## 浏览器扩展链接（写死在二进制）

Chrome Web Store：

```
https://chrome.google.com/webstore/detail/NeatDownloadManager-Extension/cpcifbdmkopohnnofedkjghjiclmhdah
```
