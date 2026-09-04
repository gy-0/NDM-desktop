export const RELEASES_URL = 'https://github.com/gy-0/NDM-desktop/releases'
export const REPO_URL = 'https://github.com/gy-0/NDM-desktop'

export const NAV = [
  { href: '/', label: '概览' },
  { href: '/download', label: '下载' },
  { href: '/relay', label: 'Relay' },
  { href: '/pricing', label: '价格' },
  { href: '/faq', label: '常见问题' }
] as const

export const PRO_PRICING = {
  currency: 'USD',
  regular: '24.99',
  earlyBird: '14.99',
  seats: 3
} as const

export const FREE_FEATURES = [
  '多线程分段加速与断点续传',
  'NDM Relay 浏览器接管',
  '单个网页视频与文件下载',
  '分类保存、限速与队列',
  '无广告、无弹窗、无订阅'
] as const

export const PRO_FEATURES = [
  { name: '播放列表与频道整批下载', note: '一次排入整个合集，不限条数' },
  { name: '4K / 8K 超清与高码率轨', note: '解锁 2160p 以上的视频与音频轨' },
  { name: '下载历史云同步', note: '多台 Mac 之间保持同一份记录' },
  { name: '格式转换与音频提取', note: '下载后直接转码或抽出音轨' }
] as const
