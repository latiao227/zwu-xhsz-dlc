# 安装与排错

> 目标：把智慧思政的写操作技能接到「我的万里 AI 助手」上，从零到能跑通一次请假。

---

## 0. 前置条件

| 项 | 要求 | 怎么查 |
|---|---|---|
| 主程序 | `zwu-ehallapp-assistant` >= 0.2.2 | 看主仓 `package.json` 的 `version` |
| Node.js | >= 18（推荐 20+） | `node -v` |
| 浏览器 | Chrome / Edge（扩展形态需要 MV3 + service worker） | `chrome://version` |
| 账号 | 能登录「智慧思政」（`nxg.zwu.edu.cn/zhxg/`） | 浏览器里登一次 |

> 主程序不在 PATH 里时用完整路径，例如 `C:\Program Files\nodejs\node.exe`。

---

## 1. 放置与安装

```powershell
# 假设主程序在 D:\code\zwu-ehallapp-assistant-master
# 把本仓库整个目录放到：
D:\code\zwu-ehallapp-assistant-master\dlc\xhsz\

cd D:\code\zwu-ehallapp-assistant-master\dlc\xhsz
node install.mjs
```

安装器做四件事（全部幂等，重复跑不会重复插）：

1. 把 `src/*.ts`（8 个文件）复制进主仓 `src/series/`
2. `src/series/all.ts` 追加一行 `import './xhsz-tools';`
3. `src/main.ts` 注入 token 桥（智慧思政页面静默同步 token）
4. `scripts/build.mjs` 的 userscript 头加 `@match https://nxg.zwu.edu.cn/zhxg/*`

只检查不改文件：`node install.mjs --check`
回滚：`node install.mjs --uninstall`（然后重新 `npm run build`）

---

## 2. 构建

```powershell
cd D:\code\zwu-ehallapp-assistant-master

# 想用内置网关就带上（不带你自己的 key 就留空，在面板设置里填）
$env:ZWU_GATEWAY_ENDPOINT='https://你的网关/v1'
$env:ZWU_GATEWAY_MODEL='你的模型名'

npm run build
node scripts/prepare-extension.mjs   # 把产物同步进 chrome-extension/ 并补权限
```

产物：

- `dist/zwu-ehallapp-assistant.user.js`（油猴版）
- `dist/zwu-ehallapp-assistant.console.js`（控制台版 / 扩展 content script）
- `chrome-extension/`（可直接加载的扩展）

---

## 3. 加载扩展（推荐）

1. `chrome://extensions` → 右上角开「开发者模式」
2. 「加载已解压的扩展程序」→ 选主仓的 `chrome-extension/`
3. **确认目录里有 `background.js`** —— 课表代理要靠它（没有的话按次请假会降级成按天）
4. 打开 `https://nxg.zwu.edu.cn/zhxg/#/certificateLogin` 登录一次，停 2 秒（token 桥同步）
5. 回到页面，右侧面板出现即成功

> Chrome 156+ 移除了 `--load-extension` 参数，只能手动加载，或用 `chrome://extensions` 里的
> `chrome.developerPrivate.reload` 重载（重载可以自动化）。

---

## 4. 验收

```powershell
cd dlc/xhsz
node tests/xhsz-offline.mjs
```

期望输出 `59/59 通过`。这条命令**不碰真账号**，只检查：工具清单三处一致、风险分级、
`confirm` 闸门、草稿作废、schema 自洽、时间解析、类型推断、课表联动、影响面、白名单越界拒绝。

真机验收：面板里说「我明天上午发烧要去医院，帮我请个假」→ 看确认单 → 说「提交」。

---

## 5. 常见问题

### 「模型连接失败 (network)」

- 扩展的 `manifest.json` 里 `host_permissions` 要含你的网关域名（`prepare-extension.mjs` 会自动补）；
- 面板设置里的 endpoint/model 要跟构建时一致；
- 中转站分组要对（比如某模型只在特定分组有渠道）。

### 「还没有智慧思政的登录态」

token 桥没跑起来。按顺序检查：

1. 有没有打开过一次 `https://nxg.zwu.edu.cn/zhxg/...`（登录后）；
2. `manifest.json` 的 `content_scripts.matches` 是否含 `https://nxg.zwu.edu.cn/zhxg/*`；
3. 智慧思政页面刷新一次（token 每 5 秒同步一次）。

### 「课表查不到」

按节次请假需要扩展后台读课表：

1. `chrome-extension/background.js` 是否存在；
2. `manifest.json` 里有没有 `"background": {"service_worker": "background.js"}`；
3. 「我的万里」（ehallapp）那边是否还登录着 —— 课表用它的登录态。

查不到时会**自动退回按天请假**，流程不中断。

### 提交回 `500 请上传照片`

请假第一道校验就是凭证图。把病历/证明图贴进对话框再说「提交」。

### 提交回 `500 运行时异常:null`

缺 `lessons` 字段（哪怕按天请假也要传）。DLC 会自动补，看到这个错误说明构建产物旧了 —— 重新 `npm run build`。

### 提交回 `501 / 502 / 503`

要补导师同意书 / 家长知情书 / 两者。这是站点规则不是错误：把材料贴进来，用**同一张草稿**再提交一次（草稿不作废，最多试 3 次）。

### 面板里工具数不对

`node scripts/prepare-extension.mjs` 之后要在 `chrome://extensions` 里**重载扩展**，再刷新页面。
