import type { Metadata } from 'next'
import { IBM_Plex_Mono, Instrument_Sans, Instrument_Serif } from 'next/font/google'
import './globals.css'

const serif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-instrument-serif',
  display: 'swap'
})

const sans = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-instrument-sans',
  display: 'swap'
})

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-ibm-plex-mono',
  display: 'swap'
})

export const metadata: Metadata = {
  title: {
    default: 'NDM · 文件和视频，同一个下载器',
    template: '%s · NDM'
  },
  description:
    '面向 macOS 与 Windows 的高速下载管理器。分段加速、断点续传、浏览器接管。没有订阅，没有催购弹窗。',
  icons: { icon: '/ndm-icon.png', apple: '/ndm-icon.png' }
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/ndm-brand.css" />
      </head>
      <body className="ndm-site">{children}</body>
    </html>
  )
}
