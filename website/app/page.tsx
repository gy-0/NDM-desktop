import { ProductWindow } from '@/components/ProductWindow'
import { Shell } from '@/components/Shell'
import { RELEASES_URL } from '@/lib/site'

export default function HomePage() {
  return (
    <Shell current="/">
      <section className="ndm-opening">
        <div className="ndm-opening-claim">
          <h1 className="ndm-display">文件和视频，同一个下载器。</h1>
          <p className="ndm-lede">
            粘贴链接，或把文件拖进来。NDM 分段并行抓取，断线自动续传。macOS 走 Swift 内核，Windows 走
            aria2。没有订阅，没有催购弹窗。
          </p>
          <div className="ndm-button-row">
            <a className="ndm-button" href={RELEASES_URL}>
              下载 macOS 或 Windows 版
            </a>
            <a className="ndm-button-ghost" href="/relay">
              连接浏览器
            </a>
          </div>
          <div className="ndm-stat-strip">
            <div className="ndm-stat">
              <p className="ndm-stat-label">macOS 并发</p>
              <p className="ndm-stat-value">32 路</p>
              <p className="ndm-stat-detail">单个任务分段连接</p>
            </div>
            <div className="ndm-stat">
              <p className="ndm-stat-label">Windows 并发</p>
              <p className="ndm-stat-value">16 路</p>
              <p className="ndm-stat-detail">aria2 引擎上限</p>
            </div>
            <div className="ndm-stat">
              <p className="ndm-stat-label">订阅</p>
              <p className="ndm-stat-value">没有</p>
              <p className="ndm-stat-detail">免费档永久可用</p>
            </div>
            <div className="ndm-stat">
              <p className="ndm-stat-label">覆盖</p>
              <p className="ndm-stat-value">两端</p>
              <p className="ndm-stat-detail">macOS 与 Windows</p>
            </div>
          </div>
        </div>
        <div className="ndm-opening-proof">
          <ProductWindow />
          <p className="ndm-caption">主窗口示意。侧栏、输入条和任务行与桌面端同一套语言。</p>
        </div>
      </section>

      <section className="ndm-section">
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-24">一个应用处理两类下载</h2>
          <p className="ndm-body">
            文件型工具很少把网页视频做好。视频型工具通常不管普通文件。NDM
            把两件事放进同一套队列：HTTP 文件走分段加速，YouTube、哔哩哔哩等网页媒体走解析后下载。
          </p>
        </div>
        <div className="ndm-table-wrap">
          <table>
            <caption>
              对照依据仓库内 2026-08-16 竞品调研。NDM 列以当前桌面端为准，不是规划稿。
            </caption>
            <thead>
              <tr>
                <th scope="col">读者实际要的</th>
                <th scope="col">NDM</th>
                <th scope="col">Downie</th>
                <th scope="col">Motrix</th>
                <th scope="col">IDM</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">普通文件加速</th>
                <td>有</td>
                <td>无</td>
                <td>有</td>
                <td>有</td>
              </tr>
              <tr>
                <th scope="row">网页视频</th>
                <td>有</td>
                <td>有</td>
                <td>弱</td>
                <td>有，仅 Windows</td>
              </tr>
              <tr>
                <th scope="row">macOS</th>
                <td>有</td>
                <td>有</td>
                <td>有</td>
                <td>无</td>
              </tr>
              <tr>
                <th scope="row">Windows</th>
                <td>有</td>
                <td>无</td>
                <td>有</td>
                <td>有</td>
              </tr>
              <tr>
                <th scope="row">订阅或催购</th>
                <td>无</td>
                <td>大版本买断</td>
                <td>免费</td>
                <td>试用后弹窗</td>
              </tr>
              <tr>
                <th scope="row">浏览器接管</th>
                <td>Relay，Windows 第一版未启用</td>
                <td>扩展</td>
                <td>有限</td>
                <td>深度集成</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="ndm-section">
        <div className="ndm-grid">
          <div className="ndm-span-6 ndm-stack">
            <h2 className="ndm-heading-24">下载这件事本身免费</h2>
            <p className="ndm-body">
              加速、续传、浏览器接管、日常单个视频，全部留在免费档。Pro
              草案卖的是规模与画质：整页播放列表、4K 以上、历史同步和转换。商业化开关目前仍关闭，站点上的价格是草案，不是在售。
            </p>
            <p>
              <a className="ndm-button-ghost" href="/pricing">
                查看免费与 Pro 边界
              </a>
            </p>
          </div>
          <div className="ndm-span-6 ndm-stack">
            <h2 className="ndm-heading-24">引擎按平台分开</h2>
            <p className="ndm-body">
              macOS 保留 Swift <span className="ndm-mono">NDMHost</span>
              ，分段下载和媒体处理走原生代码。Windows 随包装 aria2 1.37.0，进度来自真实完成字节，界面不伪造分块范围。
            </p>
            <p>
              <a className="ndm-button-ghost" href="/download">
                看系统要求和已知边界
              </a>
            </p>
          </div>
        </div>
      </section>

      <section className="ndm-chapter">
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-24">站点解析器会失效</h2>
          <p className="ndm-body">
            网页视频依赖站点结构。失效时任务会失败并给出诊断，而不是假装还在下。这是这个品类的共同限制，NDM 不把它写成「永远可用」。
          </p>
          <p className="ndm-sources">
            能力与文案取自桌面端 onboarding、license 草案和 Windows 支持说明。对照表取自 2026-08-16 调研简报。
          </p>
        </div>
      </section>
    </Shell>
  )
}
