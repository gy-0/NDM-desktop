import Link from 'next/link'
import { NAV } from '@/lib/site'

export function Shell({
  current,
  children
}: {
  current: string
  children: React.ReactNode
}) {
  return (
    <div className="ndm-shell">
      <a className="ndm-skip-link" href="#main">
        跳到正文
      </a>
      <header className="ndm-header">
        <div className="ndm-masthead">
          <Link className="ndm-identity" href="/">
            <img className="ndm-mark" src="/ndm-icon.png" alt="" width={22} height={22} />
            <span className="ndm-wordmark">NDM</span>
          </Link>
          <nav className="ndm-nav" aria-label="站点">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.href === current ? 'page' : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="ndm-footer">
        <img className="ndm-mark" src="/ndm-icon.png" alt="NDM" width={18} height={18} />
        <span>Neat Download Manager · macOS 与 Windows</span>
      </footer>
    </div>
  )
}
