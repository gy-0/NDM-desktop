export function ProductWindow() {
  return (
    <figure className="ndm-window" aria-label="NDM 主窗口示意">
      <div className="ndm-window-sidebar">
        <div className="ndm-wordmark">NDM</div>
        <ul className="ndm-window-nav">
          <li data-active="true">全部</li>
          <li>进行中</li>
          <li>已完成</li>
          <li>视频</li>
          <li>文档</li>
        </ul>
      </div>
      <div className="ndm-window-main">
        <p className="ndm-composer">粘贴链接，或把文件拖进来</p>
        <div className="ndm-task">
          <p className="ndm-task-name">WWDC25-1080p.mp4</p>
          <p className="ndm-task-meta">12.4 MB/s</p>
          <p className="ndm-task-meta">视频 · 1.1 GB / 1.8 GB</p>
          <p className="ndm-task-meta">还剩 56 秒</p>
          <div className="ndm-progress" aria-hidden="true">
            <span style={{ width: '61%' }} />
          </div>
        </div>
        <div className="ndm-task">
          <p className="ndm-task-name">NDM-Windows-Setup.exe</p>
          <p className="ndm-task-meta">8.1 MB/s</p>
          <p className="ndm-task-meta">应用 · 42 MB / 86 MB</p>
          <p className="ndm-task-meta">还剩 5 秒</p>
          <div className="ndm-progress" aria-hidden="true">
            <span style={{ width: '49%' }} />
          </div>
        </div>
        <div className="ndm-task">
          <p className="ndm-task-name">调研简报.pdf</p>
          <p className="ndm-task-meta">已完成</p>
          <p className="ndm-task-meta">文档 · 2.4 MB</p>
          <p className="ndm-task-meta">今天下午</p>
          <div className="ndm-progress" aria-hidden="true">
            <span style={{ width: '100%' }} />
          </div>
        </div>
      </div>
    </figure>
  )
}
