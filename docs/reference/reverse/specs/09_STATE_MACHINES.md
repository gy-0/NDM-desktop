# 09 · 协议状态机

## HTTP Socket 状态

```
HTTP_STATE_VOID
  → HTTP_STATE_GET_SENT              # 已发送 GET/Range
  → HTTP_STATE_PARSING_HTTP_HEADER   # 解析响应头
  → HTTP_STATE_RECEIVING             # 收 body

# 代理 HTTPS 隧道分支
HTTP_STATE_VOID
  → HTTP_STATE_CONNECT_SENT
  → HTTP_STATE_PARSING_CONNECT_HEADER
  → (TLS) → GET 路径

# 认证
HTTP_STATE_PROXY_AUTH_NEED
HTTP_STATE_WWW_AUTH_NEED

# 其它
HTTP_STATE_REDIRECTING
```

日志：`HttpStatus Changed for Socket ( n )  OLD -> NEW`、`Status Code For Socket (n) = 206`

## FTP 控制通道

```
FTP_STATE_UNKNOWN
FTP_STATE_VOID
FTP_STATE_COMMAND_SENT_USER
FTP_STATE_COMMAND_SENT_PASS
FTP_STATE_COMMAND_SENT_TYPE
FTP_STATE_COMMAND_SENT_SIZE
FTP_STATE_COMMAND_SENT_PASV
FTP_STATE_COMMAND_SENT_REST      # 续传偏移
FTP_STATE_COMMAND_SENT_RETR
FTP_STATE_RECEIVING
```

命令日志：`Sending FTP Command : …`（密码作 `PASS XXXXXX`）

## FTP 数据通道

```
FTP_DATA_STATE_UNKNOWN
FTP_DATA_STATE_VOID
FTP_DATA_STATE_RECEIVING
```

## 引擎生命周期

```
Unknown → Starting... → Downloading... → Terminating / Complete / Error
```

## 认证类型（头前缀）

```
Authorization: Basic|Digest|NTLM
Proxy-Authorization: Basic|Digest|NTLM
```

类：`NeatAuthBasic` `NeatAuthDigest` `NeatAuthNTLM`

## 下载窗等待状态

ivars：`isWaiting` `isAuthenticating`  
窗口队列：`waitingWindows` `downloadWindows` `alertWindows`  
`addToWaitingWindows:` / `removeFromWaitingWindows:` / `findWaitingWindow:`
