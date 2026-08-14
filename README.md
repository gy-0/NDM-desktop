# NDM Desktop

Electron 界面壳。下载引擎仍在 `~/NDM`（Swift），这一层只负责样子和交互。

现在用的是本地演练数据，还没接到 Swift 引擎。

## 跑起来

```bash
先编引擎宿主（只需一次）：

```bash
cd ~/NDM && swift build -c release --product NDMHost
```

再开界面：

```bash
cd ~/NDM-desktop
npm install
npm run dev
```
```

- `N` 或 `⌘N`：新的下载
- `/`：搜索
- `⌘,`：设置（外观、声音）
- `Esc`：收起

外观在设置里选：胡桃夜、胡桃昼、白昼。

按键回馈用 [cuelume](https://www.npmjs.com/package/cuelume)。部分列表与侧栏交互参考 [Beautiful UI](https://www.beautifului.dev/)（MIT，Shane Levine）。

版本号跟宿主一样，按日历：`2026.8.14`。
