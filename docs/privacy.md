# Qelvynox Privacy Policy / 隐私政策

Last updated / 更新日期: 2026-11-03 · Qelvynox 1.0.0

## English

Qelvynox is an independent browser extension for navigating, searching, saving and exporting ChatGPT conversations. It processes user data in the browser and does not send conversation data to a server operated by the developer. Its features do make requests to OpenAI services as described below.

**Data and purposes.** On ChatGPT pages, the extension reads conversation text, messages, images, message and conversation identifiers, and the current conversation URL to display navigation, search, counts, bookmarks, archives and exports. Conversations can contain personal information or communications supplied by the user. It also stores settings. The optional local archive is enabled by default; it collects the available conversation history and images for local archive and export. Temporary chats are not archived. If an image or older history is unavailable, an archive may be incomplete.

**Storage and retention.** Settings and archived conversation text and images are stored in `chrome.storage.local`. Bookmarks and some metadata are stored in the ChatGPT site's `localStorage` or `sessionStorage`. Data is kept until the user deletes it, clears the relevant browser/site storage, or removes the extension where applicable. Extension storage is cleared on uninstall; site storage and user-created exports can remain. Archive data can be deleted in the extension's settings, bookmarks can be removed through the bookmark interface, and downloaded exports or backups can be deleted as normal files. Browser storage and downloaded exports are not independently encrypted by this extension; protect access to your computer and browser profile.

**Network and sharing.** To count and retrieve history, fill the archive, and export, the extension makes HTTPS requests to ChatGPT/OpenAI endpoints for the conversation in use. Image requests may reach `*.oaiusercontent.com` and other supported OpenAI image hosts. Requests can reuse the browser session and request headers, including authorization headers where ChatGPT provides them; credentials are not intentionally logged or persistently saved by the extension. OpenAI receives those requests under its own terms and privacy policy. The developer does not operate an analytics service, sell data, or send it to advertisers or data brokers. Exported files are saved where the user chooses, and any subsequent sharing is controlled by the user.

**Permissions.** ChatGPT host access powers the page UI and conversation features. `storage` saves settings and archive data; `unlimitedStorage` lets local archives exceed Chrome's normal storage quota. Access to `*.oaiusercontent.com` retrieves images for the archive and exports.

**Limited Use.** Qelvynox's use and transfer of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements. Data handled by the extension is used for the disclosed functionality and not for advertising or sale.

**Contact and changes.** Privacy questions and reports can be raised through the public repositories: https://github.com/WeFode/Qelvynox (primary, use a private security advisory for vulnerabilities) and its mirror https://gitee.com/lin_30_0/qelvynox . This policy will be updated when data practices change.

## 中文

Qelvynox 是独立的浏览器扩展，帮助用户导航、搜索、收藏和导出 ChatGPT 对话。扩展在浏览器内处理数据，不会将对话数据发送到开发者运营的服务器；下述功能会请求 OpenAI 服务。

**处理哪些数据及用途。** 在 ChatGPT 页面中，扩展读取对话文字、消息、图片、消息和对话标识及当前对话网址，用于导航、搜索、计数、收藏、归档和导出。对话可能含有用户提供的个人信息或通信内容。扩展还保存设置。本地归档默认启用，会保存可获得的对话历史和图片以供本地归档和导出；临时对话不归档。历史或图片不可用时，归档可能不完整。

**存放和删除。** 设置与对话归档存放在 `chrome.storage.local`；收藏及部分元数据存放在 ChatGPT 网站的 `localStorage` 或 `sessionStorage` 中。数据保留到用户删除、清除相应浏览器或网站存储，或在适用时卸载扩展为止。卸载扩展会清除扩展存储，但网站存储和用户创建的导出文件可能仍然保留。可以在扩展设置中清除归档、在收藏界面删除收藏，并像普通文件一样删除下载的导出或备份。扩展没有对浏览器存储和导出文件另行加密，请保护电脑及浏览器配置文件的访问权限。

**网络请求与共享。** 为统计和获取历史、补充归档与导出，扩展会通过 HTTPS 向 ChatGPT/OpenAI 服务请求当前对话的内容；图片请求可能访问 `*.oaiusercontent.com` 和其他受支持的 OpenAI 图片域名。请求可能沿用浏览器会话及 ChatGPT 提供的请求头，包括授权请求头；扩展不会有意记录或持久保存凭证。OpenAI 按其自身条款和隐私政策处理请求。开发者不运营统计服务，不出售数据，也不向广告商或数据经纪商发送数据。导出文件保存在用户选择的位置，之后是否分享由用户决定。

**权限。** ChatGPT 主机权限用于页面内界面和对话功能；`storage` 用于保存设置和归档；`unlimitedStorage` 使本地归档可以超过 Chrome 的普通存储限额；`*.oaiusercontent.com` 用于获取归档和导出的图片。

**有限使用。** Qelvynox 对从 Google API 获取的信息的使用和传输遵守 Chrome 网上应用店用户数据政策及其有限使用要求。扩展处理的数据用于已披露的功能，不用于广告或出售。

**联系与更新。** 隐私问题或报告可通过公开仓库提出：https://github.com/WeFode/Qelvynox （主仓库，安全漏洞建议使用私下报告渠道）及其镜像 https://gitee.com/lin_30_0/qelvynox 。数据处理方式变化时会更新本政策。
