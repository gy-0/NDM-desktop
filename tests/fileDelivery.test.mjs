import assert from 'node:assert/strict'
import test from 'node:test'
import { deliveryFileKind, runFileDeliveryAction } from '../src/renderer/src/lib/fileDelivery.ts'

test('file actions distinguish Electron open success from an OS error string', async () => {
  assert.equal(await runFileDeliveryAction('open', async () => ''), null)
  assert.equal(await runFileDeliveryAction('open', async () => 'The file /private/example does not exist.'), '未能打开文件，请检查保存位置')
  assert.equal(await runFileDeliveryAction('open', () => undefined), null)
})

test('missing file feedback covers preview, reveal and share without exposing OS errors', async () => {
  assert.equal(await runFileDeliveryAction('preview', async () => false), '找不到文件，无法预览')
  assert.equal(await runFileDeliveryAction('reveal', async () => false), '找不到文件或保存位置')
  assert.equal(await runFileDeliveryAction('share', async () => false), '暂时无法分享，请重试')
  for (const action of ['preview', 'reveal', 'share']) {
    assert.equal(await runFileDeliveryAction(action, async () => true), null)
    const message = await runFileDeliveryAction(action, () => { throw new Error('/private/example') })
    assert.match(message, /暂时无法/)
    assert.doesNotMatch(message, /private/)
  }
})

test('file identity uses the actual final extension and handles hidden or extensionless files', () => {
  assert.equal(deliveryFileKind('学习资料.PDF'), 'PDF 文档')
  assert.equal(deliveryFileKind('C:\\Downloads\\影片.final.MP4'), 'MP4 视频')
  assert.equal(deliveryFileKind('/folder.with.dot/LICENSE'), '文件')
  assert.equal(deliveryFileKind('.gitignore'), '文件')
  assert.equal(deliveryFileKind('归档.'), '文件')
  assert.equal(deliveryFileKind('data.parquet'), 'PARQUET 文件')
  assert.equal(deliveryFileKind('artifact.unreasonablylongextension'), '文件')
})
