/**
 * Qelvynox - in-app language layer.
 *
 * Two deliberate choices:
 *
 * 1. The language is a user setting (`language` in the stored settings), never
 *    the browser locale. A Chinese user who reads English documentation still
 *    expects a Chinese UI, and "default 中文" has to mean the same thing on
 *    every machine. `_locales/` in the manifest covers the store listing and
 *    the browser's own extension chrome; it cannot switch at runtime.
 * 2. One table per language, keyed by the same ids. A missing key falls back
 *    to the fallback language rather than printing the raw id, so a half
 *    translated build still reads as a product.
 *
 * Loaded first among the content scripts, so archive.js and index.js (same
 * isolated world) both see `QelvynoxI18n`; the popup loads it as a plain
 * script and uses applyTo() for its `data-i18n` markup.
 *
 * Interpolation: `{name}` is replaced from the vars object. `{name?one|many}`
 * picks by count (English needs it, Chinese tables simply use `{n}`). The
 * plural branches must be plain words - no nested placeholders.
 *
 * Values are authored by us, not by the page: a few settings strings carry
 * static markup (<span class="qgst-kbd">, <strong>) because the word order of
 * the two languages differs. Never feed user content into them.
 */
((global) => {
  const LANGS = ["zh-CN", "en"];
  const FALLBACK = "zh-CN";

  const MESSAGES = {
    /* ---------------- 简体中文（默认） ---------------- */
    "zh-CN": {
      "app.chatTitleFallback": "ChatGPT 对话",
      "app.brandSubtitle": "导出、搜索、整理，让 ChatGPT 更快",

      "role.you": "你",
      "role.chatgpt": "ChatGPT",
      "role.gptShort": "GPT",
      "role.colon": "：",
      "sent.sep": "",
      "reason.pagination-contract-unknown": "无法获取分页游标",
      "reason.no-backward-cursor": "响应中没有更早页面的游标",
      "reason.no-progress": "服务器未返回更早的消息",
      "reason.duplicate-cursor": "服务器重复返回同一页",
      "reason.empty-page": "较早页面为空",
      "reason.missing-page-info": "响应中没有分页信息",
      "reason.schema": "响应格式异常",
      "reason.parse": "无法解析响应",
      "reason.network": "网络错误",
      "reason.max-pages": "已达到分页上限",
      "reason.bad-url": "无法构造分页请求",
      "reason.idless-user-record": "消息缺少标识",
      "reason.cancelled": "对话已切换",
      "reason.timeout": "请求超时",
      "reason.bridge-unavailable": "无法连接页面",
      "reason.no-conversation": "请先打开对话",
      "reason.unsupported-client": "当前页面不支持此操作",
      "reason.unexpected": "发生意外错误",
      "reason.no-messages": "没有返回消息",
      "reason.unknown": "未知原因",
      "reason.rate-limited": "ChatGPT 限制了请求频率",
      "reason.http-failed": "请求失败（{code}）",

      "toast.hydrationStopped": "已加载 {pages} 页较早内容，无法继续加载（{why}）",
      "toast.progressFetch": "正在获取… 已从 {pages} 页获取 {turns} 轮",

      "pill.loadMore": "加载 {n} 轮较早内容",
      "pill.remaining": "剩余 {n} 轮",
      "pill.loadAll": "加载全部",
      "loader.loadingOlder": "正在加载较早的消息…",

      "topbar.export": "导出",
      "topbar.exportTitle": "导出对话",

      "dock.searchTitle": "搜索对话（Alt+F）",
      "dock.search": "搜索对话",
      "dock.export": "导出对话",
      "dock.outline": "对话导航",
      "dock.bookmarks": "收藏的回复",
      "dock.settings": "打开设置",
      "dock.badgeShown": "显示 {visible} / {total} 个问题",

      "outline.empty": "暂无已加载的问题",
      "outline.listAria": "对话问题导航",
      "outline.questionFallback": "[问题]",
      "outline.hidden": "已隐藏",
      "outline.hiddenAria": "（已隐藏，跳转时会展开）",

      "bookmarks.scopeCurrent": "本对话",
      "bookmarks.scopeAll": "全部",
      "bookmarks.emptyAll": "还没有收藏的回复。",
      "bookmarks.emptyCurrent": "本对话还没有收藏。点击回复旁的星形图标即可收藏。",
      "bookmarks.snippetFallback": "[已收藏的回复]",
      "bookmarks.delete": "删除收藏",
      "bookmarks.chatPrefix": "对话：",
      "bookmarks.unknownChat": "未知对话",
      "bookmarks.notLoaded": "此回复尚未加载，请先加载较早的内容。",
      "bookmarks.saved": "已收藏",
      "bookmarks.saveThis": "收藏此回复",
      "bookmarks.aiReplyFallback": "AI 回复",

      "search.placeholder": "在此对话中搜索…",
      "search.inputAria": "在对话中搜索",
      "search.overlayAria": "对话内搜索",
      "search.prevTitle": "上一个（Shift+Enter）",
      "search.nextTitle": "下一个（Enter）",
      "search.closeTitle": "关闭（Esc）",
      "search.prev": "上一个",
      "search.next": "下一个",
      "search.close": "关闭",
      "search.hintNext": "下一处",
      "search.hintPrev": "上一处",
      "search.noMatchLoading": "未找到匹配内容；较早的历史尚未加载完成，向上滚动可继续加载。",
      "search.noMatch": "未找到匹配内容。",

      "export.exportedAt": "导出时间：{time}",
      "export.messagesCount": "{n} 条消息",
      "export.incompleteSuffix": " — 导出不完整：{why}",
      "export.unknownReason": "未知原因",
      "export.continuationIntro": "这是此前对话“{title}”的续聊。",
      "export.continuationBody": "以下是最近 {n} 轮对话原文，请从中断处继续。",
      "export.continuationRule": "除非我提出要求，请不要重新开始或重新总结。",
      "export.continuationTail": "请从这里继续。",
      "export.fetchingFull": "正在获取完整对话…",
      "export.connecting": "正在连接 ChatGPT…",
      "export.fetchFailed": "获取失败：{why}",
      "export.cannotFull": "无法导出完整对话（{why}），仍可导出当前显示的内容。",
      "export.onlyMessages": "仅获取到 {n} 条消息，已停止（{why}）。",
      "export.pagesResult": "已从 {pages} 页获取 {messages} 条消息",
      "export.completeYes": " — 完整",
      "export.completeNo": " — 不完整",
      "export.continuationFromArchive": "已从本地归档生成并复制续聊提示词，请粘贴到新对话中。",
      "export.continuationCopied": "已复制续聊提示词，请粘贴到新对话中。",
      "export.clipboardFallback": "无法访问剪贴板，已改为下载续聊提示词。",
      "export.archiveListed": "已列出本地归档中的 {n} 条消息（屏幕上显示 {onScreen} 条）。",
      "export.olderStillSaving": " 更早的历史仍在保存中。",
      "export.popupBlocked": "弹出窗口被拦截，请允许弹出窗口后导出 PDF。",
      "export.selectedCount": "已选择 {n} 条消息",
      "export.emptyMessage": "（空）",

      "exportModal.title": "导出对话",
      "exportModal.selectAll": "全选",
      "exportModal.selectNone": "取消全选",
      "exportModal.pickSection": "选择要导出的消息",
      "exportModal.archiveCard": "本地归档",
      "exportModal.archiveChecking": "正在检查本地归档…",
      "exportModal.htmlImages": "HTML（含图片）",
      "exportModal.markdownText": "Markdown（仅文本）",
      "exportModal.md": "Markdown（.md）",
      "exportModal.serverCard": "从服务器获取完整对话",
      "exportModal.serverHint": "获取完整历史，包括为加速而隐藏的内容。",
      "exportModal.fullMd": "完整对话（.md）",
      "exportModal.continuation": "续聊提示词（最近 {n} 轮）",
      "exportModal.actionFetch": "获取",
      "exportModal.actionCopy": "复制",
      "exportModal.selectedSection": "导出所选消息",
      "exportModal.word": "Word 文档（.docx）",
      "exportModal.pdf": "PDF（打印视图）",
      "exportModal.txt": "纯文本（.txt）",
      "exportModal.json": "JSON 数据",

      "archive.unavailable": "本地归档不可用。",
      "archive.disabled": "本地归档已关闭，可在插件设置中开启。",
      "archive.temporary": "临时对话不会归档。",
      "archive.unknownTime": "未知",
      "archive.historyFull": "已保存从第一条消息开始的完整历史。",
      "archive.historyPartial": "较早的历史仍在后台保存，目前只能导出已保存的内容。",
      "archive.describe": "{messages} 条消息 · {images} 张图片 · 保存于 {when}。{history}",
      "archive.noneForChat": "此对话暂无归档，加载后会自动保存。",
      "archive.readFailed": "无法读取本地归档。",
      "archive.nothing": "此对话暂无归档。",
      "archive.exported": "已从本地归档导出。",
      "archive.generatingHtml": "正在生成 HTML…",
      "archive.exportedWithImages": "已从本地归档导出（嵌入 {n} 张图片）。",
      "archive.settingsUnavailable": "本地归档不可用",
      "archive.settingsReadFailed": "本地归档：无法读取",
      "archive.stats": "<strong>{conversations}</strong> 个对话 · <strong>{images}</strong> 张图片{size}，全部存储在本机。",
      "archive.statsSize": " · {size}",
      "archive.confirmClear": "确定删除此设备上归档的所有对话和图片吗？ChatGPT 中的对话不会受影响。",
      "archive.mdImagesNote": "*{messages} 条消息，{images} 张图片（图片包含在 HTML 导出中）*",
      "archive.mdImagePlaceholder": "[图片 {n}：包含在 HTML 导出中]",
      "archive.missingImage": "图片未保存在本地。",
      "archive.imageAlt": "图片",
      "archive.htmlMeta": "导出时间：{time} · {messages} 条消息 · {embedded} 张图片{missing}",
      "archive.htmlMetaMissing": " · {n} 张未保存",

      "settings.nav.speed": "长对话加速",
      "settings.nav.search": "搜索",
      "settings.nav.navigator": "对话导航",
      "settings.nav.export": "导出",
      "settings.nav.archive": "本地归档",
      "settings.nav.backup": "备份与恢复",
      "settings.nav.general": "通用",
      "settings.nav.about": "关于",
      "settings.navLabel": "功能",
      "settings.navOn": "已开启",
      "settings.navOff": "已关闭",
      "settings.switchFallback": "功能开关",
      "settings.stepIncrease": "增加{label}",
      "settings.stepDecrease": "减少{label}",
      "settings.modalAria": "Qelvynox 设置",
      "settings.close": "关闭",
      "settings.footStrong": "仅在本机运行。",
      "settings.footText": "你的对话内容不会离开这台设备。",
      "settings.notes": "说明",

      "settings.currentChat": "当前对话",
      "settings.switchingChat": "正在切换对话…",
      "settings.waitingData": "等待对话数据",
      "settings.notConnected": "未连接对话",
      "settings.turnsLoaded": "轮已加载",
      "settings.allLoaded": "已全部加载",
      "settings.loadedPct": "已加载 {pct}%",
      "settings.counting": "正在统计…",
      "settings.partialUncounted": "部分历史未统计",

      "settings.speedTitle": "长对话加速",
      "settings.speedDesc": "控制对话一次性加载多少内容，长对话不再卡顿。",
      "settings.loadModeSection": "消息加载方式",
      "settings.modeRecent": "仅加载最近 {n} 轮",
      "settings.modeRecentDesc": "打开对话时只渲染最近的轮次，更早的内容向上滚动时自动加载。",
      "settings.modeDefault": "ChatGPT 默认",
      "settings.modeDefaultDesc": "不做任何改动，由 ChatGPT 自己分批加载；加速功能处于关闭状态。",
      "settings.modeAll": "打开时加载全部消息",
      "settings.modeAllDesc": "对话打开后完整可滚动，渲染优化仍会自动隐藏看不到的旧轮次。",
      "settings.batchName": "每次加载轮次",
      "settings.batchDesc": "向上滚动或点击加载按钮时补充的旧轮次数量",
      "settings.contName": "续聊轮次",
      "settings.contDesc": "续聊提示词包含的最近轮次",
      "settings.liveName": "实时精简",
      "settings.liveDesc": "新消息到达后立即隐藏旧轮次；关闭后仅在刷新时精简",
      "settings.autoName": "上滑自动加载",
      "settings.autoDesc": "向上滚动时自动揭示较早的内容",
      "settings.pillName": "显示加载按钮",
      "settings.pillDesc": "在对话顶部保留手动“加载更多”悬浮按钮",
      "settings.quietName": "隐藏加载提示",
      "settings.quietDesc": "后台加载对话时不再弹出进度提示",

      "settings.searchDesc": "按 <span class=\"qgst-kbd\">Alt</span> + <span class=\"qgst-kbd\">F</span> 或点击侧栏搜索按钮，在当前对话中查找关键词。",
      "settings.searchNote1": "搜索范围为当前对话已加载的全部轮次，包括为加速而隐藏的内容。",
      "settings.searchNote2": "关键词原地高亮，并自动滚到屏幕中央；<span class=\"qgst-kbd\">Enter</span> / <span class=\"qgst-kbd\">Shift</span> + <span class=\"qgst-kbd\">Enter</span> 逐条切换。",
      "settings.searchNote3": "高亮不修改页面内容，<span class=\"qgst-kbd\">Esc</span> 关闭即全部清除。",

      "settings.navigatorDesc": "悬停右侧目录按钮即展开，无需点击；列表只占屏幕一角，不遮挡对话。",
      "settings.navigatorNote1": "跳转时自动展开被加速功能隐藏的轮次，并高亮目标位置。",
      "settings.navigatorNote2": "滚动时当前阅读的问题会同步高亮，弹层跟着页面走。",
      "settings.navigatorNote3": "点击目录按钮可以钉住弹层；收藏在星形按钮上单独悬停展开，可切换本对话 / 全部。",

      "settings.exportDesc": "勾选需要的消息，导出为 Word、PDF、Markdown、TXT 或 JSON。",
      "settings.exportOpenBtn": "选择消息并导出",
      "settings.fullSection": "完整对话",
      "settings.exportFullDesc": "对话长到 ChatGPT 不再接受新消息时：把全部轮次（包括为加速而隐藏的那些）导出为 Markdown，或复制一段“续聊提示词”，在新对话里接着聊。",
      "settings.copyContinuation": "复制续聊提示词（最近 {n} 轮）",

      "settings.archiveDesc": "把对话和图片保存在本机，导出不需要再向 OpenAI 发任何请求。",
      "settings.archiveDataSection": "归档数据",
      "settings.archiveChecking": "正在检查本机归档…",
      "settings.archiveClearBtn": "删除归档",

      "settings.backupDesc": "将设置导出为 JSON 文件并在另一台机器上恢复。不包含对话归档。",
      "settings.backupExportBtn": "导出备份",
      "settings.backupImportBtn": "导入备份",

      "settings.generalTitle": "通用",
      "settings.langSection": "界面语言",
      "settings.langDesc": "语言立即生效，不需要重新加载页面；只影响 Qelvynox 自己的界面与导出文件中的标签。",
      "settings.langZh": "中文",
      "settings.langEn": "English",
      "settings.langZhDesc": "简体中文（默认）",
      "settings.langEnDesc": "英文界面",
      "settings.browserHint": "浏览器界面（扩展名称、右键菜单）由 Chrome 的语言决定，与此设置无关。",

      "settings.aboutTagline": "ChatGPT 加速与工具：导出、搜索、整理。原名 TurboGPT。",
      "settings.privacySection": "隐私",
      "settings.privacyNote1": "不向开发者发送数据；历史和图片请求会连接 OpenAI 服务。",
      "settings.privacyNote2": "处理在浏览器内完成；请求可能沿用 ChatGPT 的登录会话。",
      "settings.privacyNote3": "免费开源，无账户、无订阅、无内购。",
      "settings.shortcutsSection": "快捷键",
      "settings.shortcutSearch": "在对话中搜索",
      "settings.shortcutWalk": "跳到下一处 / 上一处",
      "settings.shortcutClose": "关闭搜索、导航、收藏与导出窗口",
      "settings.shortcutTab": "在导航列表中走到问题，再按 Enter 跳转",

      "backup.parseFailed": "无法解析备份文件。",
      "backup.invalid": "无效的 Qelvynox 备份文件。",
      "backup.restored": "备份已恢复。",
      "backup.parseFailedWith": "无法解析备份文件：{message}",

      "popup.title": "Qelvynox - ChatGPT 加速、搜索与导出",
      "popup.openSettings": "打开设置面板",
      "popup.launcherHint": "设置面板会在 ChatGPT 页面中打开，所有功能开关都在那里管理。",
      "popup.launcherOffline": "请先打开一个 ChatGPT 页面，再从这里进入设置面板。",
      "popup.speedTitle": "对话加速",
      "popup.speedDesc": "减少长对话中的页面卡顿",
      "popup.turnsLabel": "显示轮次",
      "popup.turnsHint": "初始显示数量（建议 2–15 轮）",
      "popup.turnsLess": "减少显示轮次",
      "popup.turnsMore": "增加显示轮次",
      "popup.quickTitle": "快捷开关",
      "popup.quickDesc": "更多选项请在设置面板中调整",
      "popup.toolAuto": "上滑自动加载",
      "popup.toolAutoDesc": "向上滚动时加载较早的内容",
      "popup.toolPill": "显示加载按钮",
      "popup.toolPillDesc": "通过悬浮按钮加载较早的内容",
      "popup.toolOutline": "对话目录",
      "popup.toolOutlineDesc": "通过问题列表快速导航",
      "popup.toolSearch": "搜索与收藏",
      "popup.toolSearchDesc": "按 Alt+F 搜索，或收藏回复",
      "popup.toolArchive": "本地归档",
      "popup.toolArchiveDesc": "在本机保存对话和图片，方便导出",
      "popup.exportTitle": "导出与备份",
      "popup.exportDesc": "Word、PDF、Markdown、TXT、JSON",
      "popup.exportPickBtn": "选择消息并导出",
      "popup.backupExportBtn": "导出备份",
      "popup.backupImportBtn": "导入备份",
      "popup.footer": "仅在本机运行，你的对话不会离开这台设备。没有账号，没有遥测，没有付费版。",
      "popup.saveBtn": "保存并应用",
      "popup.savedBtn": "已保存并应用",
      "popup.langLabel": "界面语言"
    },

    /* ---------------- English ---------------- */
    "en": {
      "app.chatTitleFallback": "ChatGPT conversation",
      "app.brandSubtitle": "Export, search and organise — make ChatGPT faster",

      "role.you": "You",
      "role.chatgpt": "ChatGPT",
      "role.gptShort": "GPT",
      "role.colon": ":",
      "sent.sep": " ",

      "reason.pagination-contract-unknown": "could not read the pagination cursor",
      "reason.no-backward-cursor": "the response had no cursor for an earlier page",
      "reason.no-progress": "the server returned no earlier messages",
      "reason.duplicate-cursor": "the server repeated the same page",
      "reason.empty-page": "the earlier page was empty",
      "reason.missing-page-info": "the response had no pagination info",
      "reason.schema": "unexpected response shape",
      "reason.parse": "the response could not be parsed",
      "reason.network": "network error",
      "reason.max-pages": "page limit reached",
      "reason.bad-url": "the pagination request could not be built",
      "reason.idless-user-record": "a message had no id",
      "reason.cancelled": "the conversation changed",
      "reason.timeout": "the request timed out",
      "reason.bridge-unavailable": "the page could not be reached",
      "reason.no-conversation": "open a conversation first",
      "reason.unsupported-client": "this page does not support that action",
      "reason.unexpected": "an unexpected error occurred",
      "reason.no-messages": "no messages were returned",
      "reason.unknown": "unknown reason",
      "reason.rate-limited": "ChatGPT is rate-limiting requests",
      "reason.http-failed": "the request failed ({code})",

      "toast.hydrationStopped": "Loaded {pages} earlier {pages?page|pages}, then stopped ({why})",
      "toast.progressFetch": "Fetching… {turns} {turns?turn|turns} from {pages} pages",

      "pill.loadMore": "Load {n} earlier {n?turn|turns}",
      "pill.remaining": "{n} {n?turn|turns} left",
      "pill.loadAll": "Load everything",
      "loader.loadingOlder": "Loading earlier messages…",

      "topbar.export": "Export",
      "topbar.exportTitle": "Export conversation",

      "dock.searchTitle": "Search this chat (Alt+F)",
      "dock.search": "Search conversation",
      "dock.export": "Export conversation",
      "dock.outline": "Chat navigator",
      "dock.bookmarks": "Saved replies",
      "dock.settings": "Settings",
      "dock.badgeShown": "{visible} of {total} questions visible",

      "outline.empty": "No questions loaded yet",
      "outline.listAria": "Conversation questions",
      "outline.questionFallback": "[question]",
      "outline.hidden": "Hidden",
      "outline.hiddenAria": " (hidden; it is revealed when you jump)",

      "bookmarks.scopeCurrent": "This chat",
      "bookmarks.scopeAll": "All",
      "bookmarks.emptyAll": "No saved replies yet.",
      "bookmarks.emptyCurrent": "Nothing saved in this chat yet. Use the star beside a reply to save it.",
      "bookmarks.snippetFallback": "[saved reply]",
      "bookmarks.delete": "Remove bookmark",
      "bookmarks.chatPrefix": "Chat: ",
      "bookmarks.unknownChat": "unknown chat",
      "bookmarks.notLoaded": "That reply is not loaded yet - load earlier content first.",
      "bookmarks.saved": "Saved",
      "bookmarks.saveThis": "Save this reply",
      "bookmarks.aiReplyFallback": "AI reply",

      "search.placeholder": "Search this conversation…",
      "search.inputAria": "Search in conversation",
      "search.overlayAria": "In-chat search",
      "search.prevTitle": "Previous (Shift+Enter)",
      "search.nextTitle": "Next (Enter)",
      "search.closeTitle": "Close (Esc)",
      "search.prev": "Previous",
      "search.next": "Next",
      "search.close": "Close",
      "search.hintNext": "next",
      "search.hintPrev": "previous",
      "search.noMatchLoading": "No match; older history has not finished loading - scroll up to load more.",
      "search.noMatch": "No match.",

      "export.exportedAt": "Exported: {time}",
      "export.messagesCount": "{n} {n?message|messages}",
      "export.incompleteSuffix": " — incomplete export: {why}",
      "export.unknownReason": "unknown reason",
      "export.continuationIntro": "This continues the earlier conversation \"{title}\".",
      "export.continuationBody": "Below are the last {n} turns verbatim; continue from where they stop.",
      "export.continuationRule": "Do not restart or re-summarise unless I ask.",
      "export.continuationTail": "Continue from here.",
      "export.fetchingFull": "Fetching the full conversation…",
      "export.connecting": "Connecting to ChatGPT…",
      "export.fetchFailed": "Fetch failed: {why}",
      "export.cannotFull": "The full conversation could not be exported ({why}); what is on screen can still be exported.",
      "export.onlyMessages": "Stopped after {n} {n?message|messages} ({why}).",
      "export.pagesResult": "{messages} {messages?message|messages} from {pages} pages",
      "export.completeYes": " — complete",
      "export.completeNo": " — incomplete",
      "export.continuationFromArchive": "Continuation prompt copied from the local archive - paste it into a new chat.",
      "export.continuationCopied": "Continuation prompt copied - paste it into a new chat.",
      "export.clipboardFallback": "The clipboard was unavailable, so the continuation prompt was downloaded instead.",
      "export.archiveListed": "Listed {n} {n?message|messages} from the local archive ({onScreen} on screen).",
      "export.olderStillSaving": " Older history is still being saved.",
      "export.popupBlocked": "The pop-up was blocked - allow pop-ups to export a PDF.",
      "export.selectedCount": "{n} {n?message|messages} selected",
      "export.emptyMessage": "(empty)",

      "exportModal.title": "Export conversation",
      "exportModal.selectAll": "Select all",
      "exportModal.selectNone": "Clear selection",
      "exportModal.pickSection": "Choose the messages to export",
      "exportModal.archiveCard": "Local archive",
      "exportModal.archiveChecking": "Checking the local archive…",
      "exportModal.htmlImages": "HTML (with images)",
      "exportModal.markdownText": "Markdown (text only)",
      "exportModal.md": "Markdown (.md)",
      "exportModal.serverCard": "Full conversation from the server",
      "exportModal.serverHint": "Fetch the whole history, including what was folded away for speed.",
      "exportModal.fullMd": "Full conversation (.md)",
      "exportModal.continuation": "Continuation prompt (last {n} turns)",
      "exportModal.actionFetch": "Fetch",
      "exportModal.actionCopy": "Copy",
      "exportModal.selectedSection": "Export the selected messages",
      "exportModal.word": "Word document (.docx)",
      "exportModal.pdf": "PDF (print view)",
      "exportModal.txt": "Plain text (.txt)",
      "exportModal.json": "JSON data",

      "archive.unavailable": "The local archive is unavailable.",
      "archive.disabled": "The local archive is off - switch it on in the settings.",
      "archive.temporary": "Temporary chats are not archived.",
      "archive.unknownTime": "unknown",
      "archive.historyFull": "The whole history from the first message is saved.",
      "archive.historyPartial": "Older history is still being saved in the background, so only what is stored can be exported.",
      "archive.describe": "{messages} {messages?message|messages} · {images} {images?image|images} · saved {when}. {history}",
      "archive.noneForChat": "This chat is not archived yet - it is saved once it has loaded.",
      "archive.readFailed": "The local archive could not be read.",
      "archive.nothing": "Nothing archived for this chat yet.",
      "archive.exported": "Exported from the local archive.",
      "archive.generatingHtml": "Building the HTML…",
      "archive.exportedWithImages": "Exported from the local archive ({n} {n?image|images} embedded).",
      "archive.settingsUnavailable": "Local archive unavailable",
      "archive.settingsReadFailed": "Local archive: unreadable",
      "archive.stats": "<strong>{conversations}</strong> {conversations?chat|chats} · <strong>{images}</strong> {images?image|images}{size}, all stored on this device.",
      "archive.statsSize": " · {size}",
      "archive.confirmClear": "Delete every conversation and image archived on this device? Chats inside ChatGPT are not affected.",
      "archive.mdImagesNote": "*{messages} messages, {images} images (images are included in the HTML export)*",
      "archive.mdImagePlaceholder": "[Image {n}: included in the HTML export]",
      "archive.missingImage": "This image was not saved locally.",
      "archive.imageAlt": "Image",
      "archive.htmlMeta": "Exported: {time} · {messages} messages · {embedded} {embedded?image|images}{missing}",
      "archive.htmlMetaMissing": " · {n} not stored",

      "settings.nav.speed": "Long-chat speed",
      "settings.nav.search": "Search",
      "settings.nav.navigator": "Navigator",
      "settings.nav.export": "Export",
      "settings.nav.archive": "Local archive",
      "settings.nav.backup": "Backup & restore",
      "settings.nav.general": "General",
      "settings.nav.about": "About",
      "settings.navLabel": "Features",
      "settings.navOn": "on",
      "settings.navOff": "off",
      "settings.switchFallback": "Feature switch",
      "settings.stepIncrease": "Increase {label}",
      "settings.stepDecrease": "Decrease {label}",
      "settings.modalAria": "Qelvynox settings",
      "settings.close": "Close",
      "settings.footStrong": "Runs on your device only.",
      "settings.footText": "Your conversations never leave this device.",
      "settings.notes": "Notes",

      "settings.currentChat": "Current conversation",
      "settings.switchingChat": "Switching chat…",
      "settings.waitingData": "Waiting for chat data",
      "settings.notConnected": "No chat connected",
      "settings.turnsLoaded": "turns loaded",
      "settings.allLoaded": "All loaded",
      "settings.loadedPct": "{pct}% loaded",
      "settings.counting": "Counting…",
      "settings.partialUncounted": "Part of the history is uncounted",

      "settings.speedTitle": "Long-chat speed",
      "settings.speedDesc": "Decide how much of a conversation loads at once, so long chats stop stuttering.",
      "settings.loadModeSection": "How messages load",
      "settings.modeRecent": "Only the last {n} turns",
      "settings.modeRecentDesc": "Render the recent turns when a chat opens; older ones load as you scroll up.",
      "settings.modeDefault": "ChatGPT default",
      "settings.modeDefaultDesc": "Change nothing and let ChatGPT batch-load; the booster stays off.",
      "settings.modeAll": "Load everything on open",
      "settings.modeAllDesc": "The whole chat is scrollable once open; render optimisation still folds away what is off screen.",
      "settings.batchName": "Turns per load",
      "settings.batchDesc": "How many older turns are revealed on scroll up or on the load button",
      "settings.contName": "Continuation turns",
      "settings.contDesc": "How many recent turns the continuation prompt carries",
      "settings.liveName": "Trim live",
      "settings.liveDesc": "Fold older turns away as soon as a new one arrives; off means only on refresh",
      "settings.autoName": "Load on scroll up",
      "settings.autoDesc": "Reveal older content automatically while scrolling up",
      "settings.pillName": "Show the load button",
      "settings.pillDesc": "Keep a manual \"load more\" pill at the top of the chat",
      "settings.quietName": "Hide loading notices",
      "settings.quietDesc": "No progress toasts while a conversation loads in the background",

      "settings.searchDesc": "Press <span class=\"qgst-kbd\">Alt</span> + <span class=\"qgst-kbd\">F</span>, or use the search button on the dock, to find a keyword in this conversation.",
      "settings.searchNote1": "The scope is every turn the conversation has loaded, including what was folded away for speed.",
      "settings.searchNote2": "Matches are painted in place and the first is centred; <span class=\"qgst-kbd\">Enter</span> / <span class=\"qgst-kbd\">Shift</span> + <span class=\"qgst-kbd\">Enter</span> walk the rest.",
      "settings.searchNote3": "Painting never rewrites the page - <span class=\"qgst-kbd\">Esc</span> clears every highlight.",

      "settings.navigatorDesc": "Hover the outline button on the right and the list slides in; it stays in a corner so the conversation is never covered.",
      "settings.navigatorNote1": "A jump reveals the turns the booster folded away and highlights where you land.",
      "settings.navigatorNote2": "The question you are reading is highlighted as you scroll, and the panel follows it.",
      "settings.navigatorNote3": "Click the outline button to pin the panel; saved replies have their own star button with a This chat / All switch.",

      "settings.exportDesc": "Tick the messages you need, then export to Word, PDF, Markdown, TXT or JSON.",
      "settings.exportOpenBtn": "Choose messages and export",
      "settings.fullSection": "Whole conversation",
      "settings.exportFullDesc": "For a chat that has hit ChatGPT's length limit: export every turn (including the ones folded away for speed) as Markdown, or copy a continuation prompt and carry on in a new chat.",
      "settings.copyContinuation": "Copy continuation prompt (last {n} turns)",

      "settings.archiveDesc": "Keep conversations and images on this device, so exporting sends OpenAI no request at all.",
      "settings.archiveDataSection": "Archived data",
      "settings.archiveChecking": "Checking the archive on this device…",
      "settings.archiveClearBtn": "Delete archive",

      "settings.backupDesc": "Export settings as JSON and restore them on another machine. The conversation archive is not included.",
      "settings.backupExportBtn": "Export backup",
      "settings.backupImportBtn": "Import backup",

      "settings.generalTitle": "General",
      "settings.langSection": "Interface language",
      "settings.langDesc": "Applies immediately, with no reload. It changes Qelvynox's own interface and the labels in exported files.",
      "settings.langZh": "中文",
      "settings.langEn": "English",
      "settings.langZhDesc": "Simplified Chinese (default)",
      "settings.langEnDesc": "English interface",
      "settings.browserHint": "The browser's own extension UI (name, menu) follows Chrome's language, not this setting.",

      "settings.aboutTagline": "Speed, search and export toolkit for ChatGPT. Formerly known as TurboGPT.",
      "settings.privacySection": "Privacy",
      "settings.privacyNote1": "No data is sent to the developer; history and image requests reach OpenAI services.",
      "settings.privacyNote2": "Processing runs in your browser; requests may reuse your ChatGPT session.",
      "settings.privacyNote3": "Free and open source - no account, no subscription, no purchase.",
      "settings.shortcutsSection": "Keyboard shortcuts",
      "settings.shortcutSearch": "search this conversation",
      "settings.shortcutWalk": "next / previous match",
      "settings.shortcutClose": "close search, navigator, bookmarks, export and settings",
      "settings.shortcutTab": "walk the navigator list, then Enter to jump",

      "backup.parseFailed": "The backup file could not be parsed.",
      "backup.invalid": "Not a valid Qelvynox backup file.",
      "backup.restored": "Backup restored.",
      "backup.parseFailedWith": "The backup file could not be parsed: {message}",

      "popup.title": "Qelvynox - ChatGPT speed, search & export",
      "popup.openSettings": "Open the control panel",
      "popup.launcherHint": "The control panel opens inside ChatGPT, where every switch lives.",
      "popup.launcherOffline": "Open a ChatGPT tab first, then come back for the control panel.",
      "popup.speedTitle": "Chat speed",
      "popup.speedDesc": "Less stutter in long conversations",
      "popup.turnsLabel": "Turns shown",
      "popup.turnsHint": "Initial count (2-15 works well)",
      "popup.turnsLess": "Fewer turns",
      "popup.turnsMore": "More turns",
      "popup.quickTitle": "Quick switches",
      "popup.quickDesc": "More options live in the control panel",
      "popup.toolAuto": "Load on scroll up",
      "popup.toolAutoDesc": "Reveal older content while scrolling up",
      "popup.toolPill": "Show the load button",
      "popup.toolPillDesc": "Reveal older content from a floating button",
      "popup.toolOutline": "Chat navigator",
      "popup.toolOutlineDesc": "Jump through the list of questions",
      "popup.toolSearch": "Search & bookmarks",
      "popup.toolSearchDesc": "Alt+F to search, star to save a reply",
      "popup.toolArchive": "Local archive",
      "popup.toolArchiveDesc": "Keep chats and images on this device for export",
      "popup.exportTitle": "Export & backup",
      "popup.exportDesc": "Word, PDF, Markdown, TXT, JSON",
      "popup.exportPickBtn": "Choose messages and export",
      "popup.backupExportBtn": "Export backup",
      "popup.backupImportBtn": "Import backup",
      "popup.footer": "Runs on your device only - your conversations never leave it. No account, no telemetry, no paid tier.",
      "popup.saveBtn": "Save and apply",
      "popup.savedBtn": "Saved and applied",
      "popup.langLabel": "Interface language"
    }
  };

  let current = FALLBACK;
  const listeners = [];

  function normalize(raw) {
    const value = String(raw || "").trim();
    if (LANGS.includes(value)) return value;
    if (/^zh/i.test(value)) return "zh-CN";
    if (/^en/i.test(value)) return "en";
    return FALLBACK;
  }

  function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)(?:\?([^|{}]*)\|([^{}]*))?\}/g, (whole, name, one, many) => {
      const value = vars[name];
      if (value === undefined) return whole;
      if (one === undefined) return String(value);
      return Number(value) === 1 ? one : many;
    });
  }

  function t(key, vars) {
    const table = MESSAGES[current] || MESSAGES[FALLBACK];
    const raw = table[key] !== undefined ? table[key] : (MESSAGES[FALLBACK][key]);
    // A key that exists in neither language still has to read as a sentence
    // somewhere, so the id is the last resort rather than an empty string.
    return fill(raw === undefined ? key : raw, vars);
  }

  function notify() {
    listeners.slice().forEach((fn) => {
      try { fn(current); } catch {}
    });
  }

  const api = {
    langs: LANGS.slice(),
    fallback: FALLBACK,
    lang: () => current,
    t,
    normalize,
    /**
     * True when a chat title is only our own placeholder, in any language.
     * An archived title beats a placeholder, and the placeholder is localized,
     * so this cannot be a literal string compare in the caller.
     */
    isChatTitleFallback(value) {
      const text = String(value || "").trim().toLowerCase();
      if (!text) return true;
      return LANGS.some((lang) => String(MESSAGES[lang]["app.chatTitleFallback"] || "").toLowerCase() === text);
    },
    /** Keys only, for the parity test and for debugging a missing string. */
    keys: (lang) => Object.keys(MESSAGES[lang || FALLBACK]),
    setLang(raw) {
      const next = normalize(raw);
      if (next === current) return current;
      current = next;
      notify();
      return current;
    },
    onChange(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.push(fn);
      return () => {
        const at = listeners.indexOf(fn);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    /** Only a hint for the settings page; never applied automatically. */
    browserLang() {
      try {
        return normalize((global.navigator && global.navigator.language) || FALLBACK);
      } catch {
        return FALLBACK;
      }
    },
    /**
     * Translates the popup's static markup in place: `data-i18n` sets text,
     * `data-i18n-title` and `data-i18n-aria` set the attribute named after the
     * suffix. Re-callable, because a language switch must not reload the page.
     */
    applyTo(root, opts) {
      const scope = root || global.document;
      if (!scope || !scope.querySelectorAll) return;
      scope.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = t(el.dataset.i18n, opts && opts.vars ? opts.vars : null);
      });
      scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
        el.setAttribute("title", t(el.dataset.i18nTitle));
      });
      scope.querySelectorAll("[data-i18n-aria]").forEach((el) => {
        el.setAttribute("aria-label", t(el.dataset.i18nAria));
      });
      if (scope === global.document || (root && root.tagName === "HTML")) {
        try {
          global.document.documentElement.setAttribute("lang", current);
          global.document.title = t((opts && opts.titleKey) || "popup.title");
        } catch {}
      }
    }
  };

  global.QelvynoxI18n = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
