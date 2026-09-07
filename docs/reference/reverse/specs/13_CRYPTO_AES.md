# 13 · 偏好加密（radare2 从二进制还原）

## 工具证据

| 证据 | 路径 |
|------|------|
| `+[NeatNsUtils encryptString:]` | `0x10002d8e8` · `dumps/r2/encryptString_disasm.txt` |
| `-[NSData(AES256) AES256EncryptWithKey:]` | `0x10002d678` · `dumps/r2/aes_encrypt_full.txt` |
| 密钥常量 | `adr x2, str.cstr.SG2921` → `"SG2921"` @ `0x1000ca1b0` |
| 系统 API | `CCCrypt`（CommonCrypto） |

## 算法（与实现 1:1）

```
plaintext NSString
  → dataUsingEncoding:NSUTF8StringEncoding
  → AES256EncryptWithKey:@"SG2921"
       CCCrypt(
         op:     kCCEncrypt / kCCDecrypt,
         alg:    kCCAlgorithmAES128  (enum 0；密钥长度决定 AES-256),
         options:kCCOptionPKCS7Padding (1),
         key:    "SG2921" 写入 32 字节缓冲（余下 0x00）,
         keyLen: 32,
         iv:     NULL → 16 字节全 0,
         ...
       )
  → base64EncodedStringWithOptions:0
```

解密路径对称：`decryptString:` → Base64 解码 → `AES256DecryptWithKey:@"SG2921"`。

## 可执行复现

```bash
python3 reverse/tools/ndm_crypto.py enc ''
# → BqhotGJODXhOF2DHpxSOGQ==
```

与运行时 `HTTP_PassWord` / `HTTPS_PassWord` / `FTP_PassWord` 空密码密文一致。

## 实现代码

`reverse/tools/ndm_crypto.py`（OpenSSL CLI，与二进制参数对齐）。

## 安全备注

密钥硬编码在二进制中，**不是**为高强度保密设计；仅用于偏好里轻度混淆代理密码。重写时可兼容解密旧 plist，或改用 Keychain。
