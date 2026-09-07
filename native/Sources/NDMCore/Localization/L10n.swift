import Foundation

/// UI language preference. Default follows macOS preferred languages.
public enum AppLanguageMode: String, Codable, Sendable, Equatable, CaseIterable {
    case system
    case english
    case simplifiedChinese

    public var settingsTitle: String {
        switch self {
        case .system: return L10n.t("System", "跟随系统")
        case .english: return L10n.t("English", "English")
        case .simplifiedChinese: return L10n.t("简体中文", "简体中文")
        }
    }
}

/// Lightweight bilingual catalog (EN / 简体中文) for SPM host UI.
/// Call `L10n.apply(_:)` when Settings change; UI should refresh via notification.
public enum L10n: Sendable {
    public static let didChangeNotification = Notification.Name("dev.ndm.open.languageDidChange")

    private static let lock = NSLock()
    nonisolated(unsafe) private static var mode: AppLanguageMode = .system

    public static func apply(_ next: AppLanguageMode) {
        lock.lock()
        mode = next
        lock.unlock()
        NotificationCenter.default.post(name: didChangeNotification, object: nil)
    }

    public static var currentMode: AppLanguageMode {
        lock.lock()
        defer { lock.unlock() }
        return mode
    }

    /// Resolved language for UI strings.
    public static var usesChinese: Bool {
        switch currentMode {
        case .simplifiedChinese:
            return true
        case .english:
            return false
        case .system:
            guard let preferred = Locale.preferredLanguages.first else { return false }
            return preferred.hasPrefix("zh")
        }
    }

    public static var locale: Locale {
        usesChinese ? Locale(identifier: "zh_CN") : Locale(identifier: "en_US")
    }

    public static func t(_ english: String, _ chinese: String) -> String {
        usesChinese ? chinese : english
    }

    // MARK: - Common actions

    public static var cancel: String { t("Cancel", "取消") }
    public static var close: String { t("Close", "关闭") }
    public static var ok: String { t("OK", "好") }
    /// Replaces a third button in the remove confirmation: the file's fate is an
    /// option on one decision, not a second decision.
    public static var alsoTrashFile: String {
        t("Also move the file to Trash", "同时将文件移到废纸篓")
    }
    public static var save: String { t("Save", "保存") }
    public static var open: String { t("Open", "打开") }
    public static var quickLook: String { t("Quick Look", "快速查看") }
    public static var start: String { t("Start", "开始") }
    public static var pause: String { t("Pause", "暂停") }
    public static var resume: String { t("Resume", "继续") }
    public static var retry: String { t("Retry", "重试") }
    public static var delete: String { t("Delete", "删除") }
    public static var download: String { t("Download", "下载") }
    public static var quit: String { t("Quit", "退出") }
    public static var apply: String { t("Apply", "应用") }
    public static var choose: String { t("Choose…", "选择…") }
    public static var yes: String { t("Yes", "是") }
    public static var no: String { t("No", "否") }
    public static var unknown: String { t("Unknown", "未知") }
    public static var emDash: String { "—" }

    public static var showInFinder: String { t("Show in Finder", "在访达中显示") }
    public static var share: String { t("Share", "分享") }
    public static var moreActions: String { t("More Actions", "更多操作") }
    public static var copyURL: String { t("Copy URL", "复制链接") }
    public static var scheduleEllipsis: String { t("Schedule…", "定时下载…") }
    public static var cancelSchedule: String { t("Cancel Schedule", "取消定时") }
    public static var scheduleTitle: String { t("Start this download later", "稍后开始这项下载") }
    public static var scheduleBody: String {
        t(
            "It will wait until the time you choose, then start on its own.",
            "它会一直等到你指定的时间，然后自动开始。"
        )
    }
    public static var scheduleConfirm: String { t("Schedule", "设定") }
    public static func scheduledFor(_ when: String) -> String {
        t("Starts \(when)", "将于 \(when) 开始")
    }
    /// Puts the finished file itself on the pasteboard, so ⌘V in Finder copies it.
    public static var copyFile: String { t("Copy File", "复制文件") }
    public static var copyFiles: String { t("Copy Files", "复制文件") }
    public static var copiedToClipboard: String { t("Copied", "已复制") }
    public static var copyFailed: String { t("Copy failed", "复制失败") }
    public static var copyFailedDetail: String {
        t(
            "The clipboard didn’t accept the link. Please try again.",
            "剪贴板没有接收到链接，请重试。"
        )
    }
    public static var openFileFailed: String { t("Couldn’t open the file", "无法打开文件") }
    public static var openSourcePage: String { t("Open Source Page", "打开来源页") }
    public static var renewURL: String { t("Update Link", "更新链接") }
    public static var renewURLEllipsis: String { t("Update Link…", "更新链接…") }
    public static var renewAndStart: String { t("Update & Start", "更新链接并开始") }
    public static var renew: String { t("Update", "更新") }
    public static var properties: String { t("Properties", "属性") }
    public static var propertiesEllipsis: String { t("Properties…", "属性…") }
    public static var detailsEllipsis: String { t("Details…", "详情…") }
    public static var hideDetails: String { t("Hide details", "收起详情") }
    public static var connectionDetails: String { t("Connection details…", "连接详情…") }
    public static var progressDetails: String { t("Progress Details", "进度详情") }
    public static var resultDetails: String { t("Details", "文件详情") }
    public static var showProgress: String { t("Show Progress", "显示进度") }
    public static var removeEllipsis: String { t("Remove…", "移除…") }
    public static var removeTask: String { t("Remove Task", "仅移除任务") }
    public static var removeAndTrash: String { t("Remove & Trash File", "移除并移到废纸篓") }

    // MARK: - Status / sidebar

    public static var status: String { t("Status", "状态") }
    public static var type: String { t("Type", "类型") }
    public static var all: String { t("All", "全部") }
    public static var active: String { t("Active", "进行中") }
    public static var queued: String { t("Queued", "排队中") }
    public static var paused: String { t("Paused", "已暂停") }
    public static var toResume: String { t("To Resume", "待继续") }
    public static var readyToResume: String { t("Ready to resume", "可以继续下载") }
    public static var completed: String { t("Completed", "已完成") }
    public static var failed: String { t("Failed", "失败") }
    public static var incomplete: String { t("Incomplete", "未完成") }
    public static var downloading: String { t("Downloading", "下载中") }
    public static var waiting: String { t("Waiting", "等待中") }
    public static var complete: String { t("Complete", "完成") }
    public static var error: String { t("Error", "错误") }

    public static var video: String { t("Video", "视频") }
    public static var audio: String { t("Audio", "音频") }
    public static var document: String { t("Document", "文档") }
    public static var compressed: String { t("Compressed", "压缩包") }
    public static var appCategory: String { t("App", "应用") }
    public static var image: String { t("Image", "图片") }
    public static var other: String { t("Other", "其他") }

    public static var untitled: String { t("Untitled", "未命名") }
    public static var hlsStream: String { t("HLS stream", "HLS 流") }
    public static var hlsToMp4Badge: String { t("HLS → MP4", "HLS → MP4") }
    public static var completedReadyToShare: String {
        t(
            "Merged and remuxed automatically — ready to play and share",
            "已自动合并音视频并转封装，可直接播放与分享"
        )
    }
    public static var queuedWillStart: String {
        t("Will start after the current task finishes", "将在当前任务完成后开始")
    }
    public static func connectionsCount(_ n: Int) -> String {
        t("\(n) connections", "\(n) 条连接")
    }
    public static var showInFinderShort: String { t("Finder", "访达") }
    public static var detailsShort: String { t("Details…", "详情…") }
    public static var multiTrackMedia: String { t("Multi-track media", "多轨媒体") }
    public static var ftp: String { t("FTP", "FTP") }

    // MARK: - Main window

    public static var appName: String { "NDM" }
    public static var new: String { t("New", "新建") }
    public static var newDownload: String { t("New Download", "新建下载") }
    public static var newDownloadEllipsis: String { t("New Download…", "新建下载…") }
    public static var newDownloadTooltip: String { t("Add a new download URL", "添加下载链接") }
    public static var startTooltip: String { t("Start or resume the selected download", "开始或继续所选下载") }
    public static var pauseTooltip: String { t("Pause the selected download", "暂停所选下载") }
    public static var searchDownloads: String { t("Search downloads", "搜索下载") }
    public static var clearSearch: String { t("Clear search", "清空搜索") }
    public static var search: String { t("Search", "搜索") }
    public static var browsers: String { t("Browsers", "浏览器") }
    public static var browsersTooltip: String { t("Browser extension setup", "浏览器扩展设置") }
    public static var settings: String { t("Settings", "设置") }
    public static var settingsEllipsis: String { t("Settings…", "设置…") }
    public static var details: String { t("Details", "详情") }
    public static var selectDownloadHint: String { t("Select a download to see actions.", "选择一项下载以查看操作。") }

    public static var emptyNoDownloads: String {
        t("IDM-class speed. Mac-native design.", "IDM 级速度，原生 Mac 体验")
    }
    public static var emptyDropHint: String {
        t(
            "Press ⌘N or drop a link to start a download.",
            "按 ⌘N 或把链接拖到这里即可开始下载。"
        )
    }
    public static var emptyTrySearch: String {
        t("Try another search, or clear the search field.", "试试其他关键词，或清空搜索框。")
    }
    public static func emptyNoMatches(_ query: String) -> String {
        let shown = truncatedForDisplay(query)
        return t("No matches for “\(shown)”", "没有匹配「\(shown)」的结果")
    }

    /// Shorten a user-supplied string before it goes into a sentence.
    ///
    /// Truncating the finished sentence instead is what produced "没有匹配 …9」的
    /// 结果": the label's own ellipsis ate the query *and* the opening quote, so the
    /// message stopped being a sentence. Cutting the query keeps the frame intact
    /// and only shortens the part that is variable.
    ///
    /// Counted in Characters, not UTF-16 units, so a CJK query is cut where a reader
    /// would cut it and an emoji is never split in half.
    public static func truncatedForDisplay(_ value: String, limit: Int = 18) -> String {
        guard value.count > limit else { return value }
        return value.prefix(max(1, limit - 1)) + "…"
    }

    public static func emptyNoFilter(_ filterTitle: String) -> String {
        t("No \(filterTitle.lowercased()) downloads", "没有「\(filterTitle)」下载")
    }

    public static var pasteURLHint: String {
        t(
            "Paste a direct link, video page, or full share message.",
            "可粘贴直链、视频页面，或整段分享口令。"
        )
    }
    public static func downloadDestination(_ folder: String) -> String {
        t("Save to \(folder)", "保存到 \(folder)")
    }
    public static var changeDownloadDestination: String {
        t("Change location for this download", "更改本次下载位置")
    }
    public static var chooseDownloadFolder: String {
        t("Choose Download Folder", "选择下载文件夹")
    }
    public static var newDownloadInputPlaceholder: String {
        t("Paste a link or full share message", "粘贴链接或整段分享口令")
    }
    public static var newDownloadInputAccessibilityLabel: String {
        t("Download link or share message", "下载链接或分享口令")
    }
    public static var newDownloadLede: String {
        t("Paste a file or video link.", "粘贴文件或视频链接。")
    }
    public static var clipboardURLFilled: String {
        t("Filled from clipboard", "已从剪贴板填入")
    }
    public static var clipboardURLEmpty: String {
        t(
            "Clipboard has no recognizable download content — paste a link or share message below",
            "剪贴板里没有可识别的下载内容，请粘贴链接或分享口令"
        )
    }
    public static var clipboardURLEdited: String {
        t("Edit the URL, then download", "可继续编辑链接后下载")
    }
    public static var urlReadyToDownload: String {
        t("Link ready", "链接已就绪")
    }
    public static var shareTextLinkFound: String {
        t("Link found in the shared text — ready", "已从分享口令中找到链接")
    }
    public static var shareLinkResolving: String {
        t("Recognizing shared link…", "正在识别分享内容…")
    }
    public static var linkLensContinue: String {
        t("Continue", "继续")
    }
    public static var linkLensDownloadFile: String {
        t("Download File", "下载文件")
    }
    public static var linkLensViewExisting: String {
        t("View existing", "查看现有")
    }
    public static var linkLensDownloadAgain: String {
        t("Download again", "再下载一份")
    }
    public static var linkLensOptions: String {
        // Named for what it does — choose the video quality/format — not a
        // generic "Options", so users know this is where the picker lives.
        t("Choose quality…", "选择画质…")
    }
    public static func linkLensDownloadReadyChoice(_ quality: String, container: String) -> String {
        t("Download \(quality) · \(container)", "下载 \(quality) · \(container)")
    }
    public static var linkLensReadyChoiceTooltip: String {
        t(
            "Uses your default quality preference. Click “Choose quality” to pick a different one.",
            "使用你的默认画质偏好；点击「选择画质」可改选其他清晰度。"
        )
    }
    public static func linkLensExistingComplete(_ filename: String) -> String {
        t("Already downloaded · \(filename)", "已经下载过 · \(filename)")
    }
    public static func linkLensExistingActive(_ filename: String) -> String {
        t("Already in progress · \(filename)", "已经在下载 · \(filename)")
    }
    public static func linkLensExistingTask(_ filename: String) -> String {
        t("Already in your downloads · \(filename)", "下载列表中已有 · \(filename)")
    }
    public static var linkLensRecognizing: String {
        t("Recognizing this media…", "正在识别这个媒体…")
    }
    public static var linkLensContinueAnytime: String {
        t("Quality, format, subtitles", "画质、格式、字幕")
    }
    public static var linkLensPreviewUnavailable: String {
        t("Preview unavailable", "无法读取预览")
    }
    public static func linkLensPreviewSummary(
        qualityCount: Int,
        durationSeconds: Double?,
        subtitleCount: Int
    ) -> String {
        var parts: [String] = []
        if let durationSeconds {
            parts.append(ytdlpDuration(durationSeconds))
        }
        if qualityCount > 0 {
            parts.append(t("\(qualityCount) quality options", "\(qualityCount) 档画质"))
        }
        if subtitleCount > 0 {
            parts.append(t("\(subtitleCount) subtitle tracks", "\(subtitleCount) 种字幕"))
        }
        return parts.isEmpty
            ? t("Media details ready", "媒体信息已就绪")
            : parts.joined(separator: " · ")
    }
    public static func linkLensCollectionSummary(itemCount: Int, isTruncated: Bool) -> String {
        let count = isTruncated
            ? t("First \(itemCount)+ items ready", "已准备前 \(itemCount)+ 项")
            : t("\(itemCount) items", "\(itemCount) 项内容")
        return t("\(count) · choose one or the whole collection next", "\(count) · 下一步可选当前内容或整个合集")
    }
    public static var ytdlpCurrentVideo: String {
        t("This video", "当前视频")
    }
    public static func ytdlpEntireCollection(_ count: Int, isTruncated: Bool = false) -> String {
        if isTruncated {
            return t("First \(count) items", "前 \(count) 项")
        }
        return t("Entire collection · \(count) items", "整个合集 · \(count) 项")
    }
    public static var ytdlpCollectionQueueHint: String {
        t(
            "Collection items are added as separate downloads and run in order.",
            "合集内容会作为独立任务加入，并按顺序下载。"
        )
    }
    public static func downloadCollection(_ count: Int, quality: String) -> String {
        t("Download \(count) items · \(quality)", "下载 \(count) 项 · \(quality)")
    }
    public static func storageComfortable(
        finalBytes: Int64,
        availableBytes: Int64,
        isCollection: Bool
    ) -> String {
        let size = TaskPresentationFormatting.byteCount(finalBytes)
        let free = TaskPresentationFormatting.byteCount(availableBytes)
        return isCollection
            ? t("Collection about \(size) · \(free) free · Enough space", "合集约 \(size) · 可用 \(free) · 空间充足")
            : t("About \(size) · \(free) free · Enough space", "约 \(size) · 可用 \(free) · 空间充足")
    }
    public static func storageTight(
        finalBytes: Int64,
        projectedFreeBytes: Int64,
        isCollection: Bool
    ) -> String {
        let size = TaskPresentationFormatting.byteCount(finalBytes)
        let remaining = TaskPresentationFormatting.byteCount(projectedFreeBytes)
        return isCollection
            ? t("Collection about \(size) · only \(remaining) left afterward", "合集约 \(size) · 完成后仅剩 \(remaining)")
            : t("About \(size) · only \(remaining) left afterward", "约 \(size) · 完成后仅剩 \(remaining)")
    }
    public static func storageInsufficient(shortfallBytes: Int64) -> String {
        let shortfall = TaskPresentationFormatting.byteCount(shortfallBytes)
        return t(
            "Free up about \(shortfall) for download and assembly, or choose a smaller quality.",
            "下载和合并还差约 \(shortfall)，请释放空间或选择更小画质。"
        )
    }
    public static func storageUnknown(availableBytes: Int64?) -> String {
        guard let availableBytes else {
            return t(
                "Final size will be confirmed when download starts.",
                "最终大小将在开始下载时确认。"
            )
        }
        let free = TaskPresentationFormatting.byteCount(availableBytes)
        return t(
            "Final size will be confirmed when download starts · \(free) free",
            "最终大小将在开始下载时确认 · 可用 \(free)"
        )
    }
    public static func storageGuardError(requiredBytes: Int64, availableBytes: Int64) -> String {
        let required = TaskPresentationFormatting.byteCount(requiredBytes)
        let available = TaskPresentationFormatting.byteCount(availableBytes)
        return t(
            "This delivery may need \(required) while assembling, but only \(available) is free. Choose a smaller quality or change the download location.",
            "下载与合并过程可能需要 \(required)，当前仅有 \(available) 可用。请选择更小画质或更换下载位置。"
        )
    }
    public static var ytdlpReadyHint: String {
        t("Video pages are recognized automatically — no extra setup needed.", "视频页面会自动识别，无需额外设置。")
    }
    public static var ytdlpRecognizedVideoLink: String {
        t("Video", "视频")
    }
    public static var ytdlpRecognizedPageLink: String {
        t("Web page", "网页")
    }
    public static var directFileLink: String {
        t("File", "文件")
    }
    public static var bilibiliName: String { t("Bilibili", "哔哩哔哩") }
    public static var douyinName: String { t("Douyin", "抖音") }
    public static var xiaohongshuName: String { t("Xiaohongshu", "小红书") }
    public static var ytdlpMissingHint: String {
        t(
            "The built-in video component couldn't start. Reinstall or update the app, then try again.",
            "内置视频组件未能启动。请重新安装或更新软件后再试。"
        )
    }
    public static func ytdlpPickerSummary(host: String, count: Int) -> String {
        let h = host.isEmpty ? "—" : host
        return t(
            "From \(h) · \(count) quality options",
            "来自 \(h) · \(count) 档清晰度"
        )
    }
    public static func ytdlpPickerSummary(host: String, count: Int, durationText: String?) -> String {
        let h = host.isEmpty ? "—" : host
        if let durationText, !durationText.isEmpty {
            return t(
                "From \(h) · \(durationText) · \(count) quality options",
                "来自 \(h) · \(durationText) · \(count) 档清晰度"
            )
        }
        return ytdlpPickerSummary(host: host, count: count)
    }
    public static func ytdlpDuration(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        if h > 0 {
            return t("\(h)h \(m)m", "\(h) 小时 \(m) 分")
        }
        if m > 0 {
            return t("\(m) min", "约 \(m) 分钟")
        }
        return t("\(s)s", "约 \(s) 秒")
    }
    /// Plain-language quality subtitle — not codec jargon.
    public static func ytdlpQualityDetail(height: Int, container: String) -> String {
        let kind: String
        switch height {
        case 1440...:
            kind = t("Very sharp · great for big screens", "画质很清晰 · 适合大屏")
        case 1080...:
            kind = t("Sharp · good for computer & TV", "画质清晰 · 适合电脑和电视")
        case 720...:
            kind = t("Balanced quality and size", "画质与体积较均衡")
        case 480...:
            kind = t("Smaller file · fine on phones", "更省空间 · 适合手机观看")
        case 1...:
            kind = t("Smallest file · quick to save", "体积最小 · 适合快速保存")
        default:
            kind = t("Best available quality", "可用的最佳画质")
        }
        return "\(kind) · \(container)"
    }
    public static var ytdlpWorking: String {
        t("Preparing video options…", "正在准备视频选项…")
    }
    public static var mediaPreparationTitle: String {
        t("Preparing your video", "正在准备视频")
    }
    public static var mediaPreparationResolvingTitle: String {
        t("Understanding link", "正在识别链接")
    }
    public static var mediaPreparationResolvingBody: String {
        t(
            "Following the shared link to its original page.",
            "正在从分享链接找到对应的原始页面。"
        )
    }
    public static var mediaPreparationReadingTitle: String {
        t("Reading media", "正在读取媒体")
    }
    public static var mediaPreparationReadingBody: String {
        t(
            "Checking the title, available quality, format, and subtitles.",
            "正在检查标题、可用画质、格式与字幕。"
        )
    }
    public static var mediaPreparationOptionsTitle: String {
        t("Preparing choices", "正在准备选项")
    }
    public static var mediaPreparationOptionsBody: String {
        t(
            "Turning the available streams into clear download choices.",
            "正在把可用媒体整理成清晰的下载选项。"
        )
    }
    public static var mediaPreparationNote: String {
        t(
            "Some sites take a little longer to respond.",
            "部分网站需要更长时间才能响应。"
        )
    }
    public static var mediaAccessTitle: String {
        t("Continue from your browser", "从浏览器继续")
    }
    public static var mediaAccessBody: String {
        t(
            "This page only shares the video with a browser that can already open it. Choose that browser and NDM will continue here.",
            "这个页面只允许已经能打开它的浏览器读取视频。选择对应浏览器后，NDM 会在这里继续。"
        )
    }
    public static var mediaAccessHint: String {
        t(
            "NDM uses only this site's existing browser access. Your password is never requested.",
            "NDM 只使用这个网站已有的浏览器访问状态，绝不会要求你的账号密码。"
        )
    }
    public static var mediaAccessBrowserLabel: String {
        t("Browser", "浏览器")
    }
    public static var mediaAccessOpenStep: String {
        t("Open the original page", "打开原始页面")
    }
    public static var mediaAccessOpenStepBody: String {
        t(
            "Sign in only if the site asks, then confirm the video plays.",
            "仅在网站要求时登录，并确认视频能够正常播放。"
        )
    }
    public static var mediaAccessReturnStep: String {
        t("Return to NDM", "返回 NDM")
    }
    public static var mediaAccessReturnStepBody: String {
        t(
            "Continue here and NDM will prepare the video with that access.",
            "回到这里继续，NDM 会使用这次访问状态准备视频。"
        )
    }
    public static func mediaAccessOpenInBrowser(_ browser: String) -> String {
        t("Open in \(browser)", "在 \(browser) 中打开")
    }
    public static var mediaAccessAlreadyOpen: String {
        t("Already open — Continue", "已经打开，继续")
    }
    public static var mediaAccessOpenAgain: String {
        t("Open again", "再次打开")
    }
    public static func mediaAccessContinueWith(_ browser: String) -> String {
        t("Continue with \(browser)", "使用 \(browser) 继续")
    }
    public static func mediaAccessWaitingForReturn(_ browser: String) -> String {
        t(
            "When the video plays in \(browser), return to NDM.",
            "视频在 \(browser) 中能够播放后，请返回 NDM。"
        )
    }
    public static func mediaAccessReturnedHint(_ browser: String) -> String {
        t(
            "Welcome back — ready to continue from \(browser).",
            "欢迎回来，已准备好从 \(browser) 继续。"
        )
    }
    public static var mediaAccessRetryHint: String {
        t(
            "That browser couldn't provide usable access. Confirm the page plays there, or choose another browser.",
            "刚才的浏览器未能提供可用访问状态。请确认页面能够播放，或换一个浏览器。"
        )
    }
    public static var mediaAccessOpenFailed: String {
        t(
            "NDM couldn't open that browser. Choose another one or open the page yourself.",
            "NDM 未能打开这个浏览器。请选择其他浏览器，或自行打开该页面。"
        )
    }
    public static var mediaAccessUseBrowser: String {
        t("Continue", "继续")
    }
    public static var mediaAccessChooseFile: String {
        t("Choose Access File…", "选择网站访问文件…")
    }
    public static var mediaAccessFileTitle: String {
        t("Choose a website access file", "选择网站访问文件")
    }
    public static var mediaAccessImport: String {
        t("Use File", "使用文件")
    }
    public static var mediaRecognitionFailed: String {
        t("This video isn't ready to download", "暂时无法准备这个视频")
    }
    public static var mediaRecognitionFailedBody: String {
        t(
            "The page may be private, unavailable in your region, or not supported yet. Open it in a browser to confirm it still plays, then try again.",
            "这个页面可能是私密内容、受地区限制，或暂未适配。请先在浏览器中确认它仍能播放，然后重试。"
        )
    }
    public static var ytdlpDownloading: String {
        t("Downloading video and audio…", "正在下载视频和音频…")
    }
    public static var ytdlpPreparingDownload: String {
        t(
            "Connecting to the video source… Some sites need a little longer before the first byte.",
            "正在连接视频源… 部分网站在开始传输前需要多一点时间。"
        )
    }
    public static var ytdlpPreparingShort: String {
        t("Getting the download address…", "正在获取下载地址…")
    }
    public static var ytdlpFinalizing: String {
        t("Preparing the finished file…", "正在整理最终文件…")
    }
    public static var ytdlpFinalizingShort: String {
        t("Finishing the file…", "正在整理文件…")
    }
    public static var ytdlpMerging: String {
        t("Download finished — packaging video and audio…", "下载已完成，正在封装视频和音频…")
    }
    public static var ytdlpMergingShort: String {
        t("Packaging video and audio…", "正在封装…")
    }
    public static var ytdlpPreparingSubtitles: String {
        t("Preparing subtitles for the finished video…", "正在为成品视频整理字幕…")
    }
    public static var ytdlpPreparingSubtitlesShort: String {
        t("Preparing subtitles…", "正在整理字幕…")
    }
    public static var ytdlpFileFormat: String { t("File format", "文件格式") }
    public static var ytdlpCompatibleMP4: String {
        t("Universal MP4 (Recommended)", "通用 MP4（推荐）")
    }
    public static var ytdlpCompactMKV: String {
        t("Smaller file (MKV)", "更小体积（MKV）")
    }
    public static var ytdlpFormatHint: String {
        t(
            "MP4 works almost everywhere. Smaller file prefers newer compression and may need IINA or VLC.",
            "MP4 几乎随处可播；更小体积会优先新压缩格式，部分文件可能需要 IINA 或 VLC。"
        )
    }
    public static var ytdlpDownloadSubtitles: String {
        t("Download subtitle file", "同时下载字幕文件")
    }
    public static var ytdlpNoSubtitlesFound: String {
        t("No subtitles found for this video", "这个视频没有检测到字幕")
    }
    public static var ytdlpSubtitleHint: String {
        t("Saved beside the video as an SRT file; manual captions are preferred.", "字幕会以 SRT 文件保存在视频旁边，并优先使用人工字幕。")
    }
    public static var ytdlpAutoSubtitleSuffix: String { t(" · Auto", " · 自动生成") }
    public static var ytdlpNoFormats: String {
        t(
            "Couldn't find playable formats for this page.",
            "无法从这个页面解析出可播放的清晰度。"
        )
    }

    public static func removeConfirm(_ name: String) -> String {
        t("Remove “\(name)”?", "移除「\(name)」？")
    }

    public static func removeConfirmMultiple(_ count: Int) -> String {
        t("Remove \(count) downloads?", "移除这 \(count) 项下载？")
    }

    public static func selectedCount(_ count: Int) -> String {
        t("\(count) selected", "已选 \(count) 项")
    }

    public static var removeConfirmBody: String {
        t(
            "It will be removed from your download list.",
            "它将从下载列表中移除。"
        )
    }

    /// Neutral verb for the remove confirmation's primary button. `removeTask`
    /// ("Remove Task" / "仅移除任务") was worded for the old three-button layout,
    /// where "only" distinguished it from "Remove and Trash"; with the file's fate
    /// now a checkbox, "only" contradicts the checkbox above it.
    public static var remove: String { t("Remove", "移除") }

    public static var renewURLBody: String {
        t("Paste a fresh URL. Partial segments are kept.", "粘贴新的链接。已下载分段会保留。")
    }

    public static var renewURLBodyProgress: String {
        t(
            "Paste a fresh URL for this task (keeps partial segments).",
            "为此任务粘贴新链接（保留已下载分段）。"
        )
    }

    public static var somethingWentWrong: String { t("Something went wrong", "出错了") }
    public static var fileNotFound: String { t("File not found", "找不到文件") }
    public static func downloadFallback(_ id: Int64) -> String {
        t("Download \(id)", "下载 \(id)")
    }

    // MARK: - Progress window

    public static var tabDownload: String { t("Download", "下载") }
    public static var tabOptions: String { t("Options", "选项") }
    public static var tabConnections: String { t("Connections", "连接") }
    public static var url: String { t("URL", "链接") }
    public static var size: String { t("Size", "大小") }
    public static func estimatedSize(_ bytes: Int64) -> String {
        t(
            "Estimated \(TaskPresentationFormatting.byteCount(bytes))",
            "预计 \(TaskPresentationFormatting.byteCount(bytes))"
        )
    }
    public static var source: String { t("Source", "来源") }
    public static var location: String { t("Location", "位置") }
    public static var progress: String { t("Progress", "进度") }
    public static var downloaded: String { t("Downloaded", "已下载") }
    public static var downloadTime: String { t("Downloaded", "下载时间") }
    public static var lastAttempt: String { t("Last tried", "最近尝试") }
    public static var speed: String { t("Speed", "速度") }
    public static var timeLeft: String { t("Time left", "剩余时间") }
    public static var resumable: String { t("Resumable", "可断点续传") }
    public static var segments: String { t("Segments", "分段") }
    public static func segmentsCount(_ n: Int) -> String {
        t("Segments · \(n)", "分段 · \(n)")
    }
    public static var connections: String { t("Connections", "连接") }
    public static var connectionsRange: String { t("Connections (1–32)", "连接数（1–32）") }
    public static var optionsNote: String {
        t(
            "Change connection count while downloading to replan active Range transfers. Renew replaces an expired URL without discarding partial segments.",
            "下载过程中可调整连接数以重新规划 Range 传输。更换链接可替换过期地址，并保留已下载分段。"
        )
    }
    public static func doneTitle(_ filename: String) -> String {
        t("Done · \(filename)", "完成 · \(filename)")
    }
    public static func connectionN(_ n: Int) -> String {
        t("Connection \(n)", "连接 \(n)")
    }

    // MARK: - Clipboard awareness

    public static func clipboardBanner(_ name: String) -> String {
        t("Link on your clipboard: \(name)", "剪贴板有下载链接：\(name)")
    }
    public static var clipboardWatchTitle: String {
        t("Offer to download links from the clipboard", "自动发现剪贴板中的下载链接")
    }
    public static func clipboardOffer(
        source: SharedLinkResolution.Source,
        wasExtractedFromText: Bool
    ) -> String {
        if source == .web {
            return t("Download clipboard link", "下载剪贴板链接")
        }
        let sourceName: String
        switch source {
        case .youtube: sourceName = "YouTube"
        case .bilibili: sourceName = t("Bilibili", "B 站")
        case .douyin: sourceName = t("Douyin", "抖音")
        case .xiaohongshu: sourceName = t("Xiaohongshu", "小红书")
        case .tiktok: sourceName = "TikTok"
        case .kuaishou: sourceName = t("Kuaishou", "快手")
        case .weibo: sourceName = t("Weibo", "微博")
        case .instagram: sourceName = "Instagram"
        case .x: sourceName = "X"
        case .facebook: sourceName = "Facebook"
        case .vimeo: sourceName = "Vimeo"
        case .twitch: sourceName = "Twitch"
        case .dailymotion: sourceName = "Dailymotion"
        case .web: sourceName = ""
        }
        return wasExtractedFromText
            ? t("Download \(sourceName) share", "下载\(sourceName)分享")
            : t("Download \(sourceName) link", "下载\(sourceName)链接")
    }
    public static var clipboardOfferTooltip: String {
        t(
            "Review the recognized link before downloading",
            "先查看识别结果，再开始下载"
        )
    }

    // MARK: - Pro / License

    public static var proWindowTitle: String { t("Upgrade", "升级") }
    public static var proHeadline: String {
        t("More connections, cleaner finished files", "更多连接，更干净的成品文件")
    }
    public static var proSubline: String {
        t(
            "One-time purchase · up to 3 Macs · a year of updates",
            "一次买断 · 最多三台 Mac · 含一年更新"
        )
    }
    public static var proFreeName: String { t("Free", "免费版") }
    public static var proFreePrice: String { t("¥0", "¥0") }
    public static var proFreeTagline: String { t("Free · up to 4 connections", "免费 · 最高 4 连接") }
    public static var proFreeFeatures: String {
        t(
            "Multi-connection downloads (up to 4)\nResume · crash recovery\nBrowser takeover · queue · speed limit\nVideo sniffing + MP4 output",
            "多连接下载（最高 4 连接）\n断点续传 · 崩溃恢复\n浏览器接管 · 队列 · 限速\n视频嗅探 + MP4 输出"
        )
    }
    public static var proProName: String { "Pro" }
    public static var proProPrice: String { t("$29.99", "¥98") }
    public static var proProTagline: String { t("Launch price", "限时首发价 · 原价 ¥128") }
    public static var proProFeatures: String {
        t(
            "Up to 32 connections + smart tuning\nSmart Finalize: MP4 · naming · covers · compress\nPlain-language download diagnostics\nPlaylist & collection downloads · site rules coming\nMenu bar · Shortcuts / Raycast\nPriority support",
            "最高 32 连接 + 智能升降\nSmart Finalize：MP4 · 命名 · 封面 · 压缩\n人话下载诊断\n播放列表与合集下载 · 站点规则陆续上线\n菜单栏 · Shortcuts / Raycast\n优先支持"
        )
    }
    public static var proCTA: String { t("Upgrade to Pro", "升级到 Pro") }
    public static var proEnterLicense: String { t("Enter license key…", "输入许可证…") }
    public static var proLicensePrompt: String {
        t("Paste the license key from your purchase email.", "粘贴购买邮件中的许可证密钥。")
    }
    public static var proActivate: String { t("Activate", "激活") }
    public static func proActivated(_ email: String) -> String {
        t("Pro activated for \(email). Thank you!", "Pro 已激活（\(email)）。感谢支持！")
    }
    public static var proInvalidKey: String {
        t("That key doesn't check out — make sure it's copied whole.", "许可证无效——请确认完整复制。")
    }
    public static var proExpiredKey: String {
        t("This key's update window has ended; it can't activate this version.", "该许可证的更新期已结束，无法激活此版本。")
    }
    public static var proFine: String {
        t("License is verified locally · no account required", "许可证在本机验证 · 无需账户")
    }
    public static var proNotNow: String { t("Not now", "暂时不用") }
    public static var proMenuTitle: String { t("Unlock Pro…", "解锁 Pro…") }
    public static var proGateConnectionsTitle: String {
        t("More than 4 connections is a Pro feature", "超过 4 条连接是 Pro 功能")
    }
    public static var proGateConnectionsBody: String {
        t(
            "Free already runs 4 parallel connections — noticeably faster than a browser. Pro raises the cap to 32 with smart tuning.",
            "免费版已并行 4 条连接，明显快于浏览器。Pro 可提升到 32 条并配合智能升降。"
        )
    }
    public static var proContextEyebrow: String {
        "NDM PRO"
    }
    public static func proContextTitle(_ feature: ProFeature?) -> String {
        switch feature {
        case .connections(let requested):
            let count = min(requested, LicenseStore.proMaxConnections)
            return t(
                "Use \(count) connections for this download",
                "让这次下载使用 \(count) 条连接"
            )
        case .ultraHD(let height):
            let quality = height >= 4320 ? "8K" : "4K"
            return t("Keep this video in \(quality)", "保留这段视频的 \(quality) 清晰度")
        case .collection(let itemCount):
            return t(
                "Bring home all \(itemCount) videos",
                "一次收下这 \(itemCount) 个视频"
            )
        case .subtitles:
            return t(
                "Deliver the subtitles with the video",
                "让字幕和视频一起交付"
            )
        case nil:
            return t(
                "Turn complex downloads into ready-to-use files",
                "把复杂下载，直接变成能用的文件"
            )
        }
    }
    public static func proContextBody(_ feature: ProFeature?) -> String {
        switch feature {
        case .connections:
            return t(
                "On servers that throttle each connection, Pro opens more useful lanes and keeps rebalancing the slow tail automatically.",
                "遇到单连接限速的服务器，Pro 会打开更多有效通道，并在末尾自动重新分配慢分段。"
            )
        case .ultraHD:
            return t(
                "Download the original high-resolution streams, merge audio and video, and hand you one file that is ready to play.",
                "保留原始高画质，自动合并音频与视频，最后只交给你一个可以直接播放的文件。"
            )
        case .collection:
            return t(
                "Keeps the original order, continues after a restart, and one failed item does not stop the rest.",
                "按原顺序排队；单项失败不拖累整组；重启后继续。"
            )
        case .subtitles:
            return t(
                "Subtitles are renamed beside the video using player-friendly language suffixes, so they are recognized automatically.",
                "字幕会与视频同名并使用播放器可识别的语言后缀，放在一起就能自动载入。"
            )
        case nil:
            return t(
                "Pro removes the repetitive work around speed, high-quality media, collections, subtitles, naming, and final delivery.",
                "Pro 负责速度、高画质、合集、字幕、命名和整理里那些最费时间的重复工作。"
            )
        }
    }
    public static func proAlsoUnlocks(_ features: [ProFeature]) -> String? {
        guard features.count > 1 else { return nil }
        let labels = features.dropFirst().map { feature -> String in
            switch feature {
            case .connections: return t("32 connections", "32 连接")
            case .ultraHD(let height): return height >= 4320 ? "8K" : "4K"
            case .collection: return t("whole collection", "整合集")
            case .subtitles: return t("subtitles", "同名字幕")
            }
        }
        let summary = labels.joined(separator: " · ")
        return t(
            "Also included now: \(summary)",
            "这次还会同时解锁：\(summary)"
        )
    }
    public static var proBenefitsTitle: String { t("What Pro adds", "Pro 额外提供") }
    public static var proBenefitSpeedTitle: String { t("Up to 32 smart connections", "最高 32 条智能连接") }
    public static var proBenefitSpeedBody: String {
        t("Scale up when it helps; rebalance the slow tail before it stalls.", "有收益才升档，末尾慢分段自动重分配。")
    }
    public static var proBenefitDeliveryTitle: String { t("Smart Finalize", "Smart Finalize 智能交付") }
    public static var proBenefitDeliveryBody: String {
        t("Playable container, clean name, cover and subtitles in place.", "可播放容器、干净命名，封面与字幕一并就位。")
    }
    public static var proBenefitMediaTitle: String { t("4K, collections, and batch work", "4K、合集与批量任务") }
    public static var proBenefitMediaBody: String {
        t("Keep high quality; long queues keep running after a restart.", "保留高画质；长队列重启后继续跑。")
    }
    public static var proPurchaseCTA: String { t("Unlock Pro — one-time purchase", "一次买断，解锁 Pro") }
    public static var proPurchaseUnavailableCTA: String { t("Storefront coming soon", "购买通道即将开放") }
    public static var proPurchaseUnavailableBody: String {
        t(
            "Already have a license? Enter it to unlock every Pro feature.",
            "已有许可证？输入后即可解锁全部 Pro 功能。"
        )
    }

    // MARK: - Onboarding

    public static var onboardingWindowTitle: String { t("Welcome", "欢迎") }
    public static var onboardingHeroTitle: String {
        t("Link in. File out.", "链接进来，文件出去")
    }
    public static var onboardingHeroBody: String {
        t(
            "NDM recognizes direct links, video pages, and full share messages. You stay in control of quality, format, and location.",
            "直链、视频页面、整段分享口令都能识别；画质、格式和保存位置仍由你决定。"
        )
    }
    public static var onboardingInputPlaceholder: String {
        t("Paste a link or share message", "粘贴链接或分享口令")
    }
    public static var onboardingPasteAndContinue: String {
        t("Paste & Recognize", "粘贴并识别")
    }
    public static var onboardingContinueWithLink: String {
        t("Choose Download Options", "继续选择下载选项")
    }
    public static var onboardingTrustLine: String {
        t(
            "NO ACCOUNT  ·  LOCAL PROCESSING  ·  BROWSER EXTENSION OPTIONAL",
            "无需账号  ·  本机处理  ·  浏览器扩展可选"
        )
    }
    public static var onboardingNoLinkFound: String {
        t(
            "No downloadable link found — paste one above.",
            "没有找到可下载链接，请粘贴到上方。"
        )
    }
    public static func onboardingLinkReady(_ source: String) -> String {
        t("\(source) link ready", "已识别 \(source) 链接")
    }
    public static var onboardingDirectLinkOutcome: String {
        t(
            "Size and resume support are checked next",
            "下一步确认大小与断点续传"
        )
    }
    public static var onboardingStep1Title: String {
        t("Paste a link or share text", "粘贴链接或分享口令")
    }
    public static var onboardingStep1Body: String {
        t(
            "Direct links, video pages, or a full share message. NDM resolves the source and prepares the download.",
            "直链、视频页面，或整段分享口令。NDM 解析来源并准备下载。"
        )
    }
    public static var onboardingSources: String {
        t(
            "DIRECT LINKS · YOUTUBE · BILIBILI · DOUYIN · XIAOHONGSHU · PLAYLISTS",
            "直链 · YouTube · B站 · 抖音 · 小红书 · 播放列表"
        )
    }
    public static var onboardingUnderstandsTitle: String {
        t("Paste it exactly as you received it", "收到什么，就粘贴什么")
    }
    public static var onboardingUnderstandsBody: String {
        t("No picking a URL out of a share message.", "不用再从分享口令里手动挑链接。")
    }
    public static var onboardingDeliversTitle: String {
        t("The finished result stays together", "拿到的是整理好的结果")
    }
    public static var onboardingDeliversBody: String {
        t("Video, subtitles, cover and metadata remain one item.", "视频、字幕、封面和信息不会散成一地。")
    }
    public static var onboardingStep2Title: String {
        t("Paste first. Choose after it understands.", "先粘贴，读懂以后再选择")
    }
    public static var onboardingStep2Body: String {
        t(
            "The source appears immediately; title, cover, quality and subtitles fill in without blocking you.",
            "来源会立刻出现；标题、封面、画质和字幕随后补齐，不会让你对着空白等待。"
        )
    }
    public static var onboardingExampleShareText: String {
        t(
            "This made me laugh — try it: https://www.youtube.com/watch?v=M262vpHkRbk",
            "这个视频太有意思了，复制打开看看：https://www.youtube.com/watch?v=M262vpHkRbk"
        )
    }
    public static var onboardingExampleFound: String {
        t("No link handy? Try a YouTube example", "手边没有链接？试试 YouTube 示例")
    }
    public static var onboardingExampleOutcome: String {
        t("Preview recognition first — nothing downloads yet", "先体验识别，不会立即下载")
    }
    public static var onboardingRecognizedMediaOutcome: String {
        t("Choose quality, format, and subtitles next", "继续后选择画质、格式和字幕")
    }
    public static var onboardingTryExample: String {
        t("Try this example", "用这个示例试试")
    }
    public static var onboardingUseOwnLink: String {
        t("Use my own link…", "用我自己的链接…")
    }
    public static var onboardingNotNow: String {
        t("Not now", "暂时不试")
    }
    public static var onboardingStep3Title: String { t("Ready from the first click", "装好就能用") }
    public static var onboardingStep3Body: String {
        t(
            "The core experience is already inside the app. Browser connection is an optional enhancement, not a requirement.",
            "核心能力已经随 App 一起准备好。连接浏览器只是可选增强，不是使用门槛。"
        )
    }
    public static var onboardingBuiltInTitle: String {
        t("No extra components", "无需额外组件")
    }
    public static var onboardingBuiltInBody: String {
        t("Install one app and start downloading.", "安装这一个 App，就可以开始下载。")
    }
    public static var onboardingPrivateTitle: String {
        t("Local and private by default", "默认在本机完成")
    }
    public static var onboardingPrivateBody: String {
        t("No account required; links and files stay on this Mac.", "无需账号；链接和文件留在这台 Mac。")
    }
    public static var onboardingBrowserOptionalTitle: String {
        t("Browser connection, when you want it", "需要时再连接浏览器")
    }
    public static var onboardingBrowserOptionalBody: String {
        t("Add one-click capture later from Settings.", "之后可以在设置里加入一键接管。")
    }
    public static var onboardingShortcuts: String {
        t(
            "⌘N  New download from a link\n⌘⇧P  Pause everything\nDrag any link into the window or the menu bar icon",
            "⌘N  从链接新建下载\n⌘⇧P  全部暂停\n把链接拖进主窗口即可开始下载"
        )
    }
    public static var onboardingContinue: String { t("See how it works", "看看它怎么工作") }
    public static var onboardingSkip: String { t("Open Download Inbox", "直接进入下载收件箱") }
    public static var onboardingDone: String { t("Open Download Inbox", "打开下载收件箱") }
    public static var onboardingConnectBrowser: String {
        t("Connect a browser (optional)", "连接浏览器（可选）")
    }
    public static var onboardingSafariSoon: String { t("Safari — coming soon", "Safari · 即将支持") }

    // MARK: - Quality picker

    public static var videoFound: String { t("Video found", "发现视频") }
    public static var chooseQuality: String { t("Choose quality", "选择清晰度") }
    public static func qualityStreamsSummary(host: String, found: Int, kept: Int) -> String {
        _ = found // raw stream count kept for callers; UI speaks in "quality options".
        if host.isEmpty {
            return t(
                "\(kept) quality options ready · we'll deliver a playable MP4",
                "已整理为 \(kept) 档清晰度 · 下完直接是能播的 MP4"
            )
        }
        return t(
            "From \(host) · \(kept) quality options · playable MP4 when done",
            "来自 \(host) · \(kept) 档清晰度 · 下完就是能播的 MP4"
        )
    }
    public static var recommended: String { t("Recommended", "推荐") }
    public static func downloadQuality(_ label: String) -> String {
        t("Download \(label) MP4", "下载 \(label) MP4")
    }
    public static func downloadQuality(_ label: String, container: String) -> String {
        t("Download \(label) · \(container)", "下载 \(label) · \(container)")
    }

    // MARK: - Completion / Wait / Browsers / Properties

    public static var downloadComplete: String { t("Download Complete", "下载完成") }
    public static var ready: String { t("Ready", "已就绪") }
    public static var readyToPlay: String { t("Download complete", "下载完成") }
    public static var play: String { t("Play", "播放") }

    // MARK: One-click install (port of Rapidmg behavior, reverse spec 15)

    public static var install: String { t("Install", "安装") }
    public static var installing: String { t("Installing…", "正在安装…") }
    public static var mountingDiskImage: String { t("Mounting the disk image…", "正在挂载磁盘映像…") }
    public static func installingApp(_ name: String) -> String {
        t("Installing “\(name)”…", "正在安装「\(name)」…")
    }
    public static var installedToApplications: String {
        t("Installed to the Applications folder", "已安装到应用程序文件夹")
    }
    public static var openApp: String { t("Open App", "打开应用") }
    public static var noAppFoundInImage: String {
        t("No app was found in the disk image", "磁盘映像中没有找到应用")
    }
    public static var openImage: String { t("Open Disk Image", "打开磁盘映像") }
    public static var openImageBody: String {
        t("No app was found in this disk image. Mount it to view its contents?", "这个磁盘映像里没有找到应用。要挂载它查看内容吗？")
    }
    public static func replaceAppTitle(_ name: String) -> String {
        t("“\(name)” already exists. Replace it?", "「\(name)」已存在，要替换它吗？")
    }
    public static func replaceAppBody(_ name: String) -> String {
        t(
            "Replacing will overwrite the current contents of “\(name)”.",
            "替换会覆盖「\(name)」现有的内容。"
        )
    }
    public static var replace: String { t("Replace", "替换") }
    public static var installFailed: String { t("Install Failed", "安装失败") }

    // Source installer disposition (after a successful install).
    public static func installedAskTitle(_ appName: String) -> String {
        t("“\(appName)” was installed", "已安装「\(appName)」")
    }
    public static var installedAskBody: String {
        t("Keep the installer file?", "安装包还要保留吗？")
    }
    public static var keepInstaller: String { t("Keep", "保留") }
    public static var trashInstaller: String { t("Move to Trash", "移到废纸篓") }
    public static var rememberDisposition: String {
        t("Always handle it this way from now on", "以后都这样处理，不再询问")
    }
    public static func trashedInstaller(_ appName: String) -> String {
        t("\(appName) was moved to the Trash", "已把「\(appName)」移到废纸篓")
    }
    public static func deletedInstaller(_ appName: String) -> String {
        t("\(appName) was deleted", "已删除「\(appName)」")
    }
    public static var installerAfterInstallTitle: String { t("After Installing", "安装完成后") }
    public static var installerDispositionLabel: String {
        t("Handle the installer file", "处理安装包")
    }
    public static var installerDispositionAsk: String { t("Ask each time", "每次询问") }
    public static var installerDispositionTrash: String {
        t("Automatically move to Trash", "自动移到废纸篓")
    }
    public static var installerDispositionDelete: String { t("Automatically delete", "自动删除") }
    public static var installerDispositionKeep: String { t("Keep the installer", "保留安装包") }
    public static func installerDispositionTitle(_ disposition: InstallerSourceDisposition) -> String {
        switch disposition {
        case .ask: return installerDispositionAsk
        case .trash: return installerDispositionTrash
        case .delete: return installerDispositionDelete
        case .keep: return installerDispositionKeep
        }
    }
    public static var licenseAgreementTitle: String {
        t("License Agreement", "许可协议")
    }
    public static func licenseAgreementAskBody(_ filename: String) -> String {
        t(
            "“\(filename)” contains a license agreement. Do you accept it?",
            "「\(filename)」包含许可协议。你接受它吗？"
        )
    }
    public static var viewAgreement: String { t("View Agreement", "查看协议") }
    public static var accept: String { t("Accept", "接受") }
    public static var autoAcceptLicense: String {
        t(
            "Always accept license agreements from now on",
            "以后自动接受许可协议，不再询问"
        )
    }
    public static var autoAcceptLicenseDetail: String {
        t(
            "License-protected disk images install without asking. Turn this off at any time.",
            "带许可协议的磁盘映像将直接安装，不再询问。随时可以关掉。"
        )
    }

    // Completion details — normal finishing stays silent; only exceptions
    // need an explanation in the everyday completion window.
    public static var finalizeKeptTS: String {
        t("Original stream kept safely — the finishing component is temporarily unavailable", "已安全保留原始流文件——成品整理组件暂时不可用")
    }
    public static var finalizeAudioSidecar: String {
        t("Audio kept safely alongside the video — finishing is temporarily unavailable", "音轨已安全保存在视频旁边——成品整理暂时不可用")
    }
    public static var finalizeSharePresets: String {
        t("Export for WeChat / Telegram", "导出适合微信 / Telegram 的体积")
    }
    public static var completionFilesTitle: String {
        t("Included files", "包含的文件")
    }
    public static func completionFileCount(_ count: Int) -> String {
        t("\(count) files", "共 \(count) 个文件")
    }
    public static func completionSubtitleCount(_ count: Int) -> String {
        t("\(count) subtitle\(count == 1 ? "" : "s") included", "含 \(count) 个字幕")
    }
    public static var completionMainFile: String { t("Main file", "主文件") }
    public static var completionSubtitleReady: String {
        t("Subtitle · player-ready name", "字幕 · 已按播放器规则命名")
    }
    public static var completionCover: String { t("Cover image", "封面图片") }
    public static var completionAudio: String { t("Audio track", "音轨") }
    public static var completionMetadata: String { t("Media information", "媒体信息") }
    public static var completionShowFiles: String { t("Show files", "展开文件") }
    public static var completionHideFiles: String { t("Hide files", "收起文件") }
    public static var shareWeChat: String { t("WeChat size", "微信友好") }
    public static var shareTelegram: String { t("Telegram size", "Telegram 友好") }
    public static var shareExporting: String { t("Compressing…", "正在压缩…") }
    public static var shareDone: String { t("Export ready", "导出完成") }
    public static var shareNeedsFFmpeg: String {
        t("This export format isn't available in the current app build.", "当前软件版本暂不支持这种导出格式。")
    }
    public static var deliverySectionTitle: String {
        t("Make another version", "制作另一个版本")
    }
    public static var deliveryOriginalProtected: String {
        t("Original always kept", "原文件始终保留")
    }
    public static var deliveryOriginalShort: String { t("Original", "原画") }
    public static var deliveryMobileShort: String { t("Mobile", "手机") }
    public static var deliveryAudioShort: String { t("Audio", "音频") }
    public static var extractAudio: String { t("Extract Audio", "提取音频") }
    public static var extractingAudio: String { t("Extracting Audio…", "正在提取音频…") }
    public static var showAudioInFinder: String { t("Show Audio in Finder", "在访达中显示音频") }
    public static var extractAudioAgain: String { t("Extract Audio Again", "再次提取音频") }
    public static var audioExtractionReady: String { t("Audio copy ready", "音频副本已就绪") }
    public static var continueWorking: String { t("Continue working", "下一步") }
    public static var createTranscript: String { t("Create subtitles & transcript", "生成字幕与文稿") }
    public static var openInScribeStudio: String { t("Open in ScribeStudio", "用 ScribeStudio 打开") }
    public static var scribeStudioDescription: String {
        t(
            "Transcribe, review, and export subtitles.",
            "转写、校对并导出字幕。"
        )
    }
    public static var sentToScribeStudio: String {
        t("Opened in ScribeStudio.", "已在 ScribeStudio 中打开。")
    }
    public static var scribeStudioOpenFailed: String {
        t("ScribeStudio couldn't open this file.", "ScribeStudio 暂时无法打开这个文件。")
    }
    public static var deliveryWeChatShort: String { t("WeChat", "微信") }
    public static var deliveryOriginalDescription: String {
        t("Keep the downloaded quality and every original track.", "保留下载时的画质、容器和全部原始音轨。")
    }
    public static var deliveryMobileDescription: String {
        t("A 1080p H.264 MP4 that opens reliably on iPhone and common apps.", "生成最高 1080p 的 H.264 MP4，在 iPhone 和常用 App 中更稳妥。")
    }
    public static var deliveryAudioDescription: String {
        t("Keep the main audio as a compact, widely supported M4A file.", "只保留主音轨，生成体积更小、兼容性好的 M4A。")
    }
    public static var deliveryWeChatDescription: String {
        t("Create a smaller 720p copy sized for everyday chat sharing.", "按视频时长生成更小的 720p 副本，适合日常聊天发送。")
    }
    public static var deliveryCurrentFile: String {
        t("This is the completed file above.", "就是上方已经完成的主文件。")
    }
    public static var deliveryCreatesCopy: String {
        t("Creates a new file without changing the original.", "会创建新文件，不会修改原文件。")
    }
    public static var deliveryCreateCopy: String { t("Create copy", "创建副本") }
    public static func deliveryCreating(_ title: String) -> String {
        t("Creating \(title.lowercased()) version…", "正在创建\(title)版…")
    }
    public static func deliveryReady(_ size: String, subtitleCount: Int) -> String {
        let subtitle = subtitleCount > 0
            ? t(
                " · \(subtitleCount) subtitle\(subtitleCount == 1 ? "" : "s") included",
                " · 已带上 \(subtitleCount) 个同名字幕"
            )
            : ""
        return t("Ready · \(size)", "已创建 · \(size)") + subtitle
    }
    public static var deliveryFailed: String {
        t("Couldn't create this version. The original is safe; try again.", "未能创建这个版本，原文件不受影响，请重试。")
    }
    public static var advancedVideo: String {
        t("Advanced video page detected", "检测到可解析的视频页面")
    }
    public static var advancedVideoBody: String {
        t(
            "We'll fetch a clean MP4 — no commands to learn.",
            "将自动解析并下载可播放的 MP4，无需命令行。"
        )
    }
    public static var ytdlpMissing: String {
        t("The built-in video component is unavailable. Reinstall or update the app.", "内置视频组件不可用，请重新安装或更新软件。")
    }
    public static var confirmDownload: String { t("Confirm Download", "确认下载") }
    public static var downloadFromBrowser: String { t("Download from browser", "来自浏览器的下载") }
    public static var includesAudioTrack: String { t("Includes audio track", "包含音轨") }
    public static var capturedByNDMRelay: String { t("Captured by NDM Relay", "由 NDM Relay 捕获") }

    public static var browserExtension: String { t("Browser Extension", "浏览器扩展") }
    public static var browserExtensionEllipsis: String { t("Browser Extension…", "浏览器扩展…") }
    public static var connectNDMRelay: String { t("Connect NDM Relay", "连接 NDM Relay") }
    public static func bridgeReady(_ endpoint: String) -> String {
        t("Bridge ready · \(endpoint)", "桥接就绪 · \(endpoint)")
    }
    public static func bridgeUnavailable(_ port: UInt16) -> String {
        t("Bridge unavailable · port \(port) is busy", "桥接不可用 · 端口 \(port) 已被占用")
    }
    public static var browsersBody: String {
        t(
            """
            1. Open Chrome, Edge, or Firefox
            2. Load the unpacked NDM Relay extension
            3. Keep NDM running — the extension connects automatically
            4. Hover detected media, or click the NDM Relay toolbar icon, to show download choices
            """,
            """
            1. 打开 Chrome、Edge 或 Firefox
            2. 以「加载已解压的扩展程序」方式加载 NDM Relay
            3. 保持 NDM 运行 — 扩展会自动连接
            4. 将鼠标移到检测到的媒体上，或点击 NDM Relay 工具栏图标，查看下载选项
            """
        )
    }
    public static var showExtensionFolder: String { t("Show Extension Folder", "显示扩展文件夹") }
    public static var copyBridgeAddress: String { t("Copy Bridge Address", "复制桥接地址") }
    public static var extensionFolderMissing: String { t("Extension folder not found", "找不到扩展文件夹") }
    public static var extensionFolderHint: String {
        t(
            "Open this project and load extension/NDMRelay as an unpacked Chrome extension.",
            "打开本项目，将 extension/NDMRelay 以未打包扩展方式加载到 Chrome。"
        )
    }

    public static var filename: String { t("Filename", "文件名") }
    public static var speedLimitCaption: String {
        t("Speed limit (bytes/s, 0 = unlimited)", "速度限制（字节/秒，0 = 不限制）")
    }
    public static var alternateAudioURL: String { t("Alternate / audio URL", "备用 / 音轨链接") }
    public static var saveLocationPending: String { t("Save location not set yet", "尚未设置保存位置") }

    // MARK: - Settings

    public static var general: String { t("General", "通用") }
    public static var browser: String { t("Browser", "浏览器") }
    public static var network: String { t("Network", "网络") }
    public static var advanced: String { t("Advanced", "高级") }
    public static var appearance: String { t("Appearance", "外观") }
    public static var theme: String { t("Theme", "主题") }
    public static var language: String { t("Language", "语言") }
    public static var languageFootnote: String {
        t(
            "System follows macOS language. Changing language updates menus and windows immediately.",
            "「跟随系统」使用 macOS 语言。更改后菜单和窗口会立即更新。"
        )
    }
    public static var appearanceFootnote: String {
        t(
            "System follows macOS appearance. Light and Dark lock the window chrome.",
            "「跟随系统」使用 macOS 外观。浅色 / 深色会锁定窗口主题。"
        )
    }
    public static var downloads: String { t("Downloads", "下载") }
    public static var behavior: String { t("Behavior", "行为") }
    public static var saveFilesTo: String { t("Save files to", "文件保存到") }
    public static var maxConnectionsCaption: String {
        t("Max connections per download (1–32)", "每个任务最大连接数（1–32）")
    }
    public static var smartConnectionsTitle: String {
        t("Smart connections", "智能连接")
    }
    /// Short one-liner shown under the toggle — the full method is in the tooltip.
    public static var smartConnectionsFootnote: String {
        t(
            "Ramps connections up step by step to find the fastest stable count.",
            "自动逐级增加连接数，找到最快且稳定的档位。"
        )
    }
    /// Full explanation, surfaced on hover so the row stays uncluttered.
    public static var smartConnectionsDetail: String {
        t(
            "Large resumable downloads start at 2 connections and try 4, 8, 16, then 32 — advancing only while each step measurably improves throughput. The selected count is the ceiling. Turn this off to attempt that count immediately; some servers throttle or reject excess Range requests.",
            "支持续传的大文件从 2 条连接开始，依次尝试 4、8、16、32，只有每一级实测吞吐确有提升才继续。所选连接数是上限。关闭后会立即尝试该连接数；部分服务器会对过多的 Range 请求限速或拒绝。"
        )
    }
    public static var whySoFastPrefix: String { t("Why so fast: ", "为什么这么快：") }
    public static var globalSpeedCaption: String {
        t("Global speed limit", "全局限速")
    }
    public static var organizeCategories: String {
        t("Organize into category subfolders", "按分类放入子文件夹")
    }
    public static var downloadAllAtOnce: String {
        t("Download multiple tasks at once", "同时下载多个任务")
    }
    public static var showCompletionDialog: String {
        t("Show dialog when a download finishes", "下载完成时显示提示")
    }
    public static var showMediaPanel: String {
        t("Show media controls on hover", "鼠标移到媒体上时显示下载控件")
    }
    public static var confirmBrowserCaptures: String {
        t("Ask before starting browser captures", "捕获前先确认再下载")
    }
    public static var confirmBrowserFootnote: String {
        t(
            "Off by default: captures start downloading immediately. Turn on to review each URL first.",
            "默认关闭：捕获后立即开始下载。开启后可先确认每个链接。"
        )
    }
    public static var identity: String { t("Identity", "标识") }
    public static var useCustomUA: String { t("Use custom User-Agent", "使用自定义 User-Agent") }
    public static var userAgentString: String { t("User-Agent string", "User-Agent 字符串") }
    public static var browserSettingsFootnote: String {
        t(
            "These options are pushed to the browser extension over the local WebSocket bridge.",
            "这些选项会通过本地 WebSocket 桥接推送到浏览器扩展。"
        )
    }
    public static var httpProxy: String { t("HTTP(S) proxy", "HTTP(S) 代理") }
    public static var ftpProxy: String { t("FTP proxy (HTTP CONNECT)", "FTP 代理（HTTP CONNECT）") }
    public static var socksProxy: String { t("SOCKS proxy (overrides HTTP)", "SOCKS 代理（优先于 HTTP）") }
    public static var host: String { t("Host", "主机") }
    public static var version: String { t("Version", "版本") }
    public static var portPlaceholder: String { t("Port", "端口") }
    public static var usernamePlaceholder: String { t("Username", "用户名") }
    public static var passwordPlaceholder: String { t("Password", "密码") }
    public static var migration: String { t("Migration", "迁移") }
    public static var migrationFootnote: String {
        t(
            "Import tasks from the original Neat Download Manager database. Your NDM data stays in ~/Library/Application Support/dev.ndm.open.",
            "从原版 Neat Download Manager 数据库导入任务。NDM 数据仍保存在 ~/Library/Application Support/dev.ndm.open。"
        )
    }
    public static var importLegacyDB: String {
        t("Import Original Neat Database…", "导入原版 Neat 数据库…")
    }
    public static var selectLegacyDB: String { t("Select legacy neatdb.sqlite", "选择旧版 neatdb.sqlite") }
    public static func importedCount(_ n: Int) -> String {
        t("Imported \(n) downloads", "已导入 \(n) 个下载")
    }
    public static var importFailed: String { t("Import failed", "导入失败") }

    // MARK: - Menus / About / bridge

    public static var aboutNDM: String { t("About NDM", "关于 NDM") }
    public static var aboutTagline: String {
        t("Open-source download manager for macOS.", "面向 macOS 的开源下载工具。")
    }
    public static var dataLocation: String { t("Data", "数据位置") }
    public static var bridgeLabel: String { t("Bridge", "浏览器桥接") }
    public static var extensionLabel: String { t("Extension", "浏览器扩展") }
    public static var revealDataFolder: String { t("Show Data Folder", "显示数据目录") }
    public static var quitNDM: String { t("Quit NDM", "退出 NDM") }
    public static var fileMenu: String { t("File", "文件") }
    public static var editMenu: String { t("Edit", "编辑") }
    public static var viewMenu: String { t("View", "显示") }
    public static var windowMenu: String { t("Window", "窗口") }
    public static var zoomIn: String { t("Zoom In", "放大") }
    public static var zoomOut: String { t("Zoom Out", "缩小") }
    public static var actualSize: String { t("Actual Size", "实际大小") }
    public static var cut: String { t("Cut", "剪切") }
    public static var copy: String { t("Copy", "拷贝") }
    public static var paste: String { t("Paste", "粘贴") }
    public static var selectAll: String { t("Select All", "全选") }
    public static var showMainWindow: String { t("Show Main Window", "显示主窗口") }
    public static var pauseAll: String { t("Pause All", "全部暂停") }
    public static var minimize: String { t("Minimize", "最小化") }
    public static var idle: String { t("Idle", "空闲") }
    public static var idleBridgeOff: String { t("Idle · bridge off", "空闲 · 桥接关闭") }
    public static func activeSummary(_ count: Int, _ speed: String) -> String {
        t("\(count) active · \(speed)", "\(count) 个进行中 · \(speed)")
    }
    public static var nowDownloading: String { t("NOW DOWNLOADING", "正在下载") }
    public static var finishingUp: String { t("FINISHING UP", "正在收尾") }
    public static var almostDone: String { t("Almost done…", "即将完成…") }
    public static var searchResultsTitle: String { t("Search Results", "搜索结果") }
    public static var listViewTooltip: String { t("List view", "列表视图") }
    public static var galleryViewTooltip: String { t("Gallery view", "画廊视图") }

    /// Human file-format name in the app's language: "MP4 视频" / "MP4 video".
    public static func fileTypeDisplay(ext: String) -> String {
        let upper = ext.uppercased()
        let word: String
        switch ext.lowercased() {
        case "mp4", "mkv", "mov", "m4v", "webm", "avi", "ts", "flv":
            word = t("video", "视频")
        case "mp3", "m4a", "flac", "wav", "aac", "ogg", "opus":
            word = t("audio", "音频")
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "bmp":
            word = t("image", "图片")
        case "pdf", "doc", "docx", "txt", "rtf", "md", "epub", "pages", "key", "ppt", "pptx", "xls", "xlsx", "csv":
            word = t("document", "文档")
        case "zip", "rar", "7z", "gz", "tar", "bz2", "xz":
            word = t("archive", "压缩包")
        case "dmg", "iso":
            word = t("disk image", "磁盘映像")
        case "pkg", "msi", "apk", "exe":
            word = t("installer", "安装包")
        case "app":
            word = t("application", "应用")
        case "srt", "vtt", "ass":
            word = t("subtitles", "字幕")
        case "html", "htm", "js", "css", "json", "xml":
            word = t("web file", "网页文件")
        default:
            word = t("file", "文件")
        }
        return "\(upper) \(word)"
    }
    public static func headerTaskCount(_ count: Int) -> String {
        t("\(count) items", "\(count) 个任务")
    }
    public static func heroMoreActive(_ count: Int) -> String {
        t("+\(count) more active", "另有 \(count) 个进行中")
    }
    public static var downloadsInProgress: String { t("Downloads in progress", "仍有下载进行中") }
    public static var quitWithActiveBody: String {
        t(
            "Quit and leave incomplete downloads? You can resume them later.",
            "退出并保留未完成的下载？之后可以继续。"
        )
    }
    public static var failedToStart: String { t("Failed to start NDM", "无法启动 NDM") }
    public static var downloadFailed: String { t("Download failed", "下载失败") }
    public static func bridgePortInUse(_ port: UInt16) -> String {
        t("Browser bridge port \(port) is in use", "浏览器桥接端口 \(port) 已被占用")
    }
    public static func bridgePortInUseBody(_ port: UInt16, _ detail: String) -> String {
        t(
            """
            Another process is already listening on NDM's dedicated bridge port \
            127.0.0.1:\(port).

            Quit that process, then restart NDM if you need NDM Relay.

            NDM will continue without the WebSocket bridge.
            \(detail)
            """,
            """
            已有其他进程占用 NDM 专用桥接端口 \
            127.0.0.1:\(port)。

            如需使用 NDM Relay，请退出该进程后重启 NDM。

            NDM 将在没有 WebSocket 桥接的情况下继续运行。
            \(detail)
            """
        )
    }
    public static var continueWithoutBridge: String {
        t("Continue Without Bridge", "不使用桥接继续")
    }
    public static func aboutBody(dataPath: String, bridge: String) -> String {
        t(
            """
            Open-source download manager for macOS.

            Data: \(dataPath)
            Bridge: \(bridge)
            Extension: NDM Relay

            Inspired by Neat Download Manager's download engine behaviour — not a UI clone.
            """,
            """
            面向 macOS 的开源下载工具。

            数据目录：\(dataPath)
            桥接：\(bridge)
            扩展：NDM Relay

            下载引擎行为参考 Neat Download Manager，界面为独立设计，并非 UI 复刻。
            """
        )
    }
}
