# Qelvynox Chrome 网上应用店发布资料

公开仓库：主仓库 <https://github.com/WeFode/Qelvynox>，镜像 <https://gitee.com/lin_30_0/qelvynox>（隐私政策 URL 与应用店后台里的支持地址均使用前者）。

适用于当前 1.0.0 首次发布。请在提交前核对实际发布者信息、隐私政策 URL、审核选项及当前扩展行为；商店审核结果不能保证。

## 上传和发布步骤

1. 注册 [Chrome 开发者账号](https://developer.chrome.com/docs/webstore/register)，接受协议并支付一次性注册费（付款页面显示实际金额）；完成账号要求的验证。
2. 上传前在 `chrome://extensions` 开启开发者模式，选择「加载已解压的扩展程序」并选择项目目录；用自己的 ChatGPT 账号实际测试切换不同对话、单轮对话、临时对话、返回旧对话、导航跳转、归档和导出。
3. 在项目目录运行 `node tests/run.mjs`，然后运行 `node dev/package.mjs`。上传生成的 `qelvynox-1.0.0.zip`，不要上传旧的 `qelvynox-4.0.0.zip`（两个 zip 都是本地构建产物，已进 `.gitignore`，不会推到公开仓库）。ZIP 根目录必须直接包含 `manifest.json`。
4. 打开 [开发者控制台](https://chrome.google.com/webstore/devconsole)，选择新增项目，选择 ZIP 并上传；填写商店详情、隐私、分发等页面。之后提交审核。正式公开和付款、上传 ZIP 是不同步骤。
5. 以后更新同一项目时，先将 manifest 版本提高，例如 `1.0.1`，重新测试和打包，再上传更新。若已上传过高于 1.0.0 的版本，则不能用 1.0.0 覆盖，需用高于已上传版本的版本号。

## 素材

- 扩展图标：`icons/icon128.png`，128×128 PNG，包含在 ZIP。
- 实际功能截图：`screenshots/release-1-navigator-light.png` 到 `release-5-settings-light.png`，1280×800。至少 1 张，最多 5 张；需确认截图与最终版本界面一致。样张来自本地模拟页面，建议发布者登录真实 ChatGPT 重新截图，勿包含真实隐私信息。
- 小型推广图：`icons/store-promo-440x280.png`，440×280。
- 大型推广图：`icons/store-marquee-1400x560.png`，1400×560，可选。
- 宣传海报：根目录 `Qelvynox宣传海报.png`（1.6 MB，中文文件名）只保留在本地，已进 `.gitignore`；README 头部使用的是它的压缩副本 `assets/qelvynox-poster.jpg`（1400px 宽，约 196 KB）。海报内容含已移除的文件夹功能和旧 `v4.0` 版本号，**不能**用于当前版本的商店宣传，商店只用上面的推广图与截图。推广图不放入扩展 ZIP。

官方图片规则：<https://developer.chrome.com/docs/webstore/images>。推广图和截图内容也需真实准确，尺寸正确并不保证通过审核。

## 名称和摘要

默认语言：简体中文；类别建议选择「生产力」。名称、摘要应与 `_locales/zh_CN/messages.json` 一致。

名称：`Qelvynox - ChatGPT 加速、搜索与导出`

摘要：`免费、本地运行：加速长对话，提供对话内搜索、问题导航、回复收藏、本地归档与多格式导出。`

英文名称：`Qelvynox - ChatGPT Speed, Search & Export`

英文摘要：`Free and local: speeds up long chats, searches in place, navigates by question, saves replies and exports with images.`

## 详细介绍（中文）

```text
Qelvynox 为 ChatGPT 对话提供导航、搜索、收藏、归档和导出工具。

• 长对话加速：限制页面中参与布局的历史轮次，需要时再展开。
• 对话内搜索：使用 Alt+F 查找已加载的内容并跳转。
• 对话导航：按问题查看当前对话中已加载的内容，点击快速定位。
• 回复收藏：收藏回答并按当前对话或全部对话查看。
• 本地归档：在浏览器中保存可获取的对话和图片；可在设置中关闭和清除。临时对话不归档。
• 导出：支持选择消息并导出多种格式；支持完整对话和续聊内容导出。历史或图片无法获取时结果可能不完整。

扩展在浏览器中处理数据，不向开发者服务器发送对话。为了获取历史和图片，扩展会使用当前会话向 ChatGPT/OpenAI 服务发起请求。请阅读隐私政策了解数据处理、存放和删除方式。

支持简体中文和英文。Qelvynox 是独立的非官方工具，与 OpenAI 无隶属或认可关系。
```

## English description

```text
Qelvynox adds navigation, search, bookmarks, local archiving and export tools to ChatGPT conversations.

• Speed up long chats by limiting the turns participating in page layout and revealing older turns when needed.
• Search loaded content with Alt+F and jump between matches.
• Navigate loaded questions in the current conversation.
• Bookmark replies and view them by conversation or across chats.
• Keep a local archive of available conversation text and images; turn it off or clear it in settings. Temporary chats are not archived.
• Select messages for export in multiple formats, or export a whole conversation and continuation content. Exports can be incomplete when history or images cannot be retrieved.

Data is processed in your browser and conversation content is not sent to a developer-operated server. To retrieve history and images, the extension makes requests to ChatGPT/OpenAI services using the current session. See the privacy policy for data handling, storage and deletion details.

Available in Chinese and English. Qelvynox is an independent, unofficial tool and is not affiliated with or endorsed by OpenAI.
```

## 单一用途（Single purpose，可直接填写）

```text
Help users navigate, search, save and export their ChatGPT conversations, including improving the responsiveness of long conversations.
```

## 权限理由（Permission justification，可直接填写）

| 权限 | 英文理由 |
| --- | --- |
| `storage` | Stores user preferences and the local conversation archive in chrome.storage.local so the chosen settings and archived content remain available on this device. |
| `unlimitedStorage` | The local archive can contain long conversations and image data that exceed Chrome's default local storage quota. Users can disable the archive and delete it in settings. |
| `https://chatgpt.com/*` 和 `https://chat.openai.com/*` | Runs the interface within ChatGPT and accesses the current conversation for navigation, search, bookmarks, counting, local archive and user-requested export. Conversation history requests use the user's existing ChatGPT session. |
| `https://*.oaiusercontent.com/*` | Retrieves conversation image bytes from OpenAI image hosts for local archiving and image-inclusive exports, including when signed URLs would otherwise expire. |

远程代码：扩展代码随 ZIP 打包；不加载或执行远程代码（以最终 ZIP 为准）。

## 隐私与数据使用

本扩展读取和处理用户对话与页面内容，不能填「不处理任何用户数据」。表单中至少仔细核对网站内容、个人通信及网址/浏览活动相关选项；对话可能包含个人身份、健康或财务信息，且请求可能沿用授权请求头，应根据控制台每项定义及实际功能逐项判断，不要凭「数据只在本机」全部取消勾选。描述应与 `docs/privacy.md` 和实际行为一致。无开发者遥测、广告或数据出售；对 OpenAI 的请求及会话复用仍须披露。

本地归档默认启用，且浏览器本地存储未由扩展独立加密。Google 的政策还要求充分披露并取得知情同意；其安全处理 FAQ 对静态数据加密有要求。发布前请核实当前政策及本扩展如何满足这些要求，不要将本文视为审核通过保证。

隐私政策：`docs/privacy.md` 已随主仓库 <https://github.com/WeFode/Qelvynox> 公开。控制台里填 GitHub Pages 的**稳定 URL**（例如 `https://wefode.github.io/Qelvynox/privacy.html` 这类页面地址），不要用 `raw.githubusercontent.com` 或 `blob` 链接，并确保无需登录可访问。

## 审核人员测试说明

```text
Sign in to ChatGPT with a reviewer-provided account. Open a conversation, hover the right-side navigator button, and switch to another conversation to verify its loaded questions. Use Alt+F for search and the in-page settings for archive and export. The extension has no separate account or paid tier. ChatGPT availability and sign-in are required.
```
