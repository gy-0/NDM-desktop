const certificate = process.env.WIN_CSC_LINK || process.env.CSC_LINK
if (!certificate?.trim()) {
  console.error('Windows 正式发布已阻止：请通过 WIN_CSC_LINK 或 CSC_LINK 提供代码签名证书。')
  process.exitCode = 1
} else {
  console.log('Windows 签名证书已提供；凭据内容不会写入构建日志。')
}
