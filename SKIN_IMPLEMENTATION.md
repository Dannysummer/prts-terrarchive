# 皮肤（界面主题）机制实现说明

> 本文件解释 `prts-terrarchive` 插件里 `harness / prts-agent / endfield-aic` 三种界面皮肤
> 是如何实现的。行号为写作时参照，随代码演进会漂移，以最新源码为准。
>
> 术语澄清：本项目没有“干员时装/皮肤数据”这类内容；所谓“皮肤”一律指 **Web 界面主题**。

---

## 1. 一句话结论

皮肤是**叠加在 DSH 宿主上的外观覆盖层**：不修改宿主任何源码，只靠三件事完成换肤：

1. 覆盖设计 token（`--dsw-*` CSS 变量）——全局配色换血；
2. 靠 `<body>` 属性门控的追加 CSS——规则“开关”；
3. 按需向 DOM / slot 追加“场景层”——界面布局接管。

语料检索/读取逻辑全部运行在 Host 进程（`src/*.js`），皮肤只活在浏览器端（`lib/client.js`），
二者没有运行时依赖；之所以看起来“缠在一起”，只是它们共用了一个 client 模块、一份设置 UI、
同一个配置文件（详见 §8）。

---

## 2. 总体架构与两端分工

```text
┌─────────────────────────── DSH 宿主（桌面壳 / Web profile）──────────────────────────┐
│                                                                                      │
│  Host 进程（cordis 插件，Node）            浏览器（Web GUI）                            │
│  ┌──────────────────────────┐            ┌──────────────────────────────────┐        │
│  │ src/index.js   插件入口    │            │ lib/client.js  DSH client 模块     │        │
│  │ src/state.js   uiSkin 配置 │  ──HTTP──▶ │  (ModuleLoader 加载)               │        │
│  │ src/ui.js      静态资源/   │  ui-skin   │   ├ 皮肤三件套：token / CSS / DOM  │        │
│  │                ui-skin.json│  .json     │   ├ SkinCard 设置卡片              │        │
│  │              地图资源路由   │ ◀─RPC───  │   ├ AicMap / AicRoot / Scene      │        │
│  └──────────────────────────┘            └──────────────────────────────────┘        │
│           ▲  ctx.theme.overrideTokens / ctx.slots / ctx.connection（宿主注入能力）      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- **生效值只有一个权威**：Host 端 `$DSH_HOME/prts-corpus.json` 里的 `uiSkin` 键。
- 浏览器端每次启动去 Host 取一次当前皮肤，然后自己执行换肤。

---

## 3. 浏览器端模块与加载契约

`lib/client.js` 是 DSH 的 **web client 插件**格式（文件头注释即说明，L1-11）：

```js
window.__ModuleLoader__.load({
  id: 'prts-terrarchive',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    // react 由平台模块表注入；本插件只依赖 connection、slots、theme 服务
    ...
    exports.inject = ['slots', 'connection', 'theme', 'sessions']   // L1889
    exports.apply = (ctx) => { ... }                                 // L1891
    return module.exports
  },
})
```

`apply(ctx)` 只做四件事：

1. 调用 `loadSkinStylesheets()` 从 Host 路由 `/prts-corpus/skin` 拉取 `lib/skin/prts-agent.css` 与
   `lib/skin/endfield-aic.css`，拼成一个 `<style>` 注入页面（异步加载、随效果块撤销；见 §4.2）；
2. 调 `loadConfiguredSkin()` 从 Host 读当前皮肤并激活（L1904-1912）；
3. 注册设置页 slot：`settings.plugins.tab`（“PRTS 语料”tab，内含皮肤选择卡片，L1927-1930）；
4. 注册会话头部 slot：`conversation.session.header.utilities`（证据卡入口，L1931-1934）。

---

## 4. 皮肤的三件套实现

### 4.1 第一件：token 覆盖（换配色）

每种皮肤维护一张大 token 表，覆盖宿主整套 `--dsw-*` 设计变量：

```js
// lib/client.js
const canonical = (value) => ({ light: value, dark: value })   // L123
const PRTS_AGENT_TOKENS = Object.freeze({                        // L124-186
  '--dsw-alias-bg-base': canonical('rgba(255,255,255,.01)'),
  '--dsw-alias-brand-primary': canonical('#111214'),
  ...
})
const ENDFIELD_AIC_TOKENS = Object.freeze({                      // L187-279
  '--dsw-alias-bg-base': canonical('#0b0d10'),
  '--dsw-alias-brand-primary': canonical('#faff3f'),            // 终末地酸性黄
  ...
})
```

应用与撤销都走宿主 API，且返回**撤销函数**：

```js
removeSkinTokens = themeRuntime.overrideTokens(SKIN_SOURCE, PRTS_AGENT_TOKENS)
// SKIN_SOURCE = 'prts-terrarchive:prts-agent-skin'  (L30)
```

要点：

- 每个值都声明 `{ light, dark }` 两档，因此皮肤**不锁死明暗偏好**，跟随用户当前主题模式；
- 切换皮肤时先 `removeSkinTokens()` 撤销上一套，再覆盖新一套；
- 切回 `harness` = 只撤销不覆盖，宿主配色完全复原。

### 4.2 第二件：body 属性 + CSS 门控

皮肤 CSS 存放在独立文件 `lib/skin/prts-agent.css` 与 `lib/skin/endfield-aic.css`（Host 静态路由
`/prts-corpus/skin` 提供，运行时 fetch 后注入 `<style>`；旧版本曾是 `client.js` 里的 `SKIN_CSS`/`AIC_CSS`
模板字符串）。`SCENE_HTML`（场景 DOM 模板）仍内嵌在 `client.js`。**真正生效与否靠 body 属性选择器**：

```js
// setSkin() L280-301 的核心：
document.body.dataset.prtsSkin = 'agent'        // prts-agent → dataset = "agent"
document.body.dataset.prtsSkin = 'endfield-aic' // endfield  → dataset = "endfield-aic"
delete document.body.dataset.prtsSkin           // harness   → 删除属性

// CSS 侧：
body[data-prts-skin="agent"] .prts-agent-scene { display: block; }
body[data-prts-skin="endfield-aic"] { color-scheme: dark; ... }
```

属性在/不在 = 该套规则开/关。这也是为什么“切换皮肤不会触发任何下载/重载”。

### 4.3 第三件：DOM 接管（两种皮肤两种策略）

**PRTS Agent —— 轻接管：背景场景层 + 原生 DOM 透视**

`installScene()`（L587-803）把一段内联 HTML（`SCENE_HTML`，含整套 SVG 绘制的“CPU 主板”、
扫描轨道、检索流程卡片）插到 `body` 最前面当背景：

```js
scene.id = 'prts-agent-scene'
scene.innerHTML = SCENE_HTML
document.body.prepend(scene)
```

随后 `MutationObserver` + `requestAnimationFrame` 实时测量原生会话组件真实矩形，把位置写进
CSS 变量（`--agent-content-left/center`、`--prts-agent-composer-y` 等），让输入框、消息流
**悬浮盖在场景之上并跟随布局变化**；场景还消费一份“会话快照模型”
（`buildSceneSnapshotModel`，L327-441，把 tool-call/assistant-step 折叠成 QUERY →
RETRIEVAL → SOURCE READ → VERIFY 四阶段动效）。该皮肤不动宿主布局结构，只做透视与贴位。

**Endfield AIC —— 重接管：整屏替换布局（shell.overlay）**

通过宿主 slot 把整屏界面替换为自己的终端布局：

```js
// syncAicLayout() L1873-1885
clientContext.slots.register({ name: 'shell.overlay', id: 'prts-aic-shell', order: -100 }, AicRoot)
```

`AicRoot`（L1822-1871）是 `position:fixed; inset:0` 的全屏层，内部结构：

- 背景：`AicMap` —— Three.js 3D 区域地图（见 §6）；
- 左侧：把**原生会话组件**用大量 `!important` CSS 重排成一条窄“终端聊天带”
  （`.aic-chat-band`），含自定义输入区、发送键、历史抽屉、设置层；
- 覆盖：HUD、时钟、品牌标识等装饰。

挂载/卸载由皮肤状态驱动：只有 `activeSkin === 'endfield-aic'` 时才注册该 overlay，
切换走时 dispose（`syncAicLayout` 里先 `disposeAicLayout()` 再置空）。

---

## 5. 切换状态机：setSkin()

`setSkin()`（L280-301）是唯一换肤入口，完整动作：

```text
入参 skin
 ├─ 规范化：只认 harness / prts-agent / endfield-aic，其它一律回落 harness
 ├─ 同值短路：next === activeSkin 直接返回（热重载场景靠 apply 清理时把
 │            activeSkin 复位成 harness 来绕过，L1924）
 ├─ removeSkinTokens()：撤销上一皮肤的 token 覆盖（若存在）
 ├─ 写 document.body.dataset.prtsSkin（CSS 门控开关）
 ├─ themeRuntime.overrideTokens(SKIN_SOURCE, 新皮肤 tokens)  → 记下新撤销函数
 ├─ syncScene()    ：prts-agent 才 installScene 挂场景；否则 dispose（L804-813）
 ├─ syncAicLayout()：endfield-aic 才挂 shell.overlay；否则卸载（L1873-1885）
 └─ activeSkin = next
```

`apply()` 清理阶段（L1913-1926）会 dispose 场景/AIC 布局、撤销 token、删除 body 属性，
保证热重载后不留脏状态。

---

## 6. 启动恢复与“开机场”（跨端同步）

### 6.1 生效配置的读取链

浏览器加载后调 `loadConfiguredSkin()`（L988-1010）：

1. 首选 `GET /prts-corpus/ui-skin.json`（Host webServer 直出，`cache-control: no-store`）；
2. 失败则走认证 RPC：`POST /prts-corpus` → endpoint `status` → 取 `config.uiSkin` 兜底；
3. 结果写入 `localStorage['prts.uiSkin']` —— **只用于下次启动抢跑，不是权威配置**。

### 6.2 为什么需要 localStorage 抢跑

Host 端的配置查询是异步的，而 Endfield AIC 是固定暗色终端；若上次停在该皮肤，下次启动
插件尚未加载完时会让 Harness 白色启动屏闪一下。因此模块加载时**同步**检查缓存（L112-117），
命中 `endfield-aic` 就先弹“AIC 开机场”（全屏覆盖层，自带自包含样式，不依赖皮肤 CSS 时序）：

```js
if (localStorage.getItem('prts.uiSkin') === 'endfield-aic') aicBootShow('CONNECTING TERMINAL')
```

开机场有真实进度（地图资源加载事件驱动）+ 假爬行 + 30s 看门狗兜底，任何分支都不会卡死界面。

### 6.3 设置页切换时序（SkinCard）

`SkinCard`（L1325-1364，嵌在“PRTS 语料”设置 tab）三选一按钮，`choose()`（L1328-1350）：

```text
弹开机场（防止切换瞬间闪白）
  → localStorage 乐观写（立即，失败忽略）
  → PUT /config { patch: { uiSkin: next } }      ← 认证 RPC，Host 校验+原子写盘+热生效
  → setSkin(next)                                 ← 上面 §5 的换肤状态机
  → 撤开机场（endfield 由地图 onProgress 撤，其它 700ms 过渡撤）
```

Host 端落点：`src/state.js` —— `uiSkin` 默认 `'harness'`（L19）、白名单校验（L48）、
`saveConfig()` 原子写用户层文件并通知订阅者（L222-235）；配置为三层：
默认值 ← `cordis.patch.yml` 行内 config ← `$DSH_HOME/prts-corpus.json`。

---

## 7. Endfield 3D 地图的资源链路

### 7.1 打包：预压缩、包内只存压缩版

`bin/pack-map-assets.mjs` 与官网前端同法：把 `map.js` 和 `resources/*.json` 各生成
`brotli(q9, TEXT)` 与 `gzip(9)` 两份副本后**删除明文**（PNG 已是压缩格式，保持原样）。
注意这是**无损压缩而非加密**：brotli/gzip 是公开标准、无密钥，任何标准工具都能逐字节还原原
文（脚本自带的 `--restore` 即为此用）；目的只是减小 npm 包体积并让服务端按
`Accept-Encoding` 零解压直传。对“防止别人查看内容”没有任何保护作用，资源的使用边界
由 [GAME_ASSETS.md](GAME_ASSETS.md) 的许可证声明约束。
包内 `lib/endfield-map/` 约 9.2 MB，其中相当一部分是同一文本内容的 .br/.gz 双形态。

### 7.2 服务端：按 Accept-Encoding 原样直传

`src/ui.js` 的 `applyUi()` 用 `webServer.register` 挂两个前缀（L570-577）：

| 前缀 | 用途 |
|---|---|
| `/prts-corpus/endfield-map` | 引擎脚本 `map.js` |
| `/webmap3d/resources` | 引擎按需拉的 png / 几何 json |

`serveEndfieldMapAsset()`（L40-96）读请求头 `Accept-Encoding`：文本资源带 `br` 直回 `.br`、
带 `gzip` 直回 `.gz`，并加 `Content-Encoding` 头，**浏览器透明解压，服务端零解压开销**；
开发态缺压缩副本时自动回退明文。缓存策略：`map.js` no-cache（引擎要常更新），
其余资源 `immutable` 一年。

### 7.3 浏览器端：动态 script 加载一次

`AicMap`（L1731-1820）挂载时 `loadMapBundle()`（L1714-1729）动态建 `<script>`：

```js
script.src = '/prts-corpus/endfield-map/map.js'
script.onload = () => resolve(globalThis.__PRTS_ENDFIELD_MAP__)   // 引擎导出运行时
const map = await runtime.createRegionMap(hostEl, {
  onProgress: (p, msg) => { setStatus(...); aicBootProgress(p, msg) }, // 驱动开机场进度
  onStats: setStats, onSelectLv: setSelected, onRegionPositions: setPositions,
})
```

引擎内部再按需拉 `/webmap3d/resources/*`。页面不可见（托盘/切后台）时用
`visibilitychange` + `prts-shell-visibility` 调 `map.pause()/resume()`，避免隐藏窗口
GPU working set 持续增长（L1739-1790）。

---

## 8. 常见误解与事实核对

- **皮肤与语料功能解耦**：检索/读取全部在 Host 端 `src/`，换肤不触碰语料；语料“版本管理”
  下载的是数据 release（ModelScope），皮肤资源随 npm 包自带、无需下载。
- **皮肤代码分布**：token 表仍内联在 `lib/client.js`；皮肤 CSS 已拆到 `lib/skin/*.css`（运行时经
  `/prts-corpus/skin` 拉取注入）。除地图与皮肤 CSS 外，皮肤生效不需要网络请求。
- **历史上有一个“皮肤反向依赖语料 UI”的耦合**：证据卡/来源阅读器组件注册在会话头部 slot
  （所有皮肤都会注册），但其可见性样式被 `body[data-prts-skin="agent"]` 门控
  （`lib/skin/prts-agent.css` 内 `.prts-evidence-layer{display:none}` + agent 皮肤才 `display:block`），
  即**语料证据 UI 目前只在 PRTS Agent 皮肤下可见**——属于“皮肤 CSS 里混装了插件 UI”的
  历史耦合，不是机制必需。

---

## 9. 关键代码索引

| 关注点 | 位置 |
|---|---|
| 模块入口 / inject / apply | `lib/client.js` L12-14, L1887-1935 |
| 皮肤 token 表 | `lib/client.js` L124-186（agent）/ L187-279（endfield） |
| `setSkin()` 换肤状态机 | `lib/client.js` L280-301 |
| PRTS Agent 场景 HTML/安装 | `lib/client.js`（`SCENE_HTML` / `installScene`） |
| 皮肤样式文件 | `lib/skin/prts-agent.css` / `lib/skin/endfield-aic.css` |
| 皮肤样式静态路由 | `src/ui.js` `serveSkinCssAsset`（`/prts-corpus/skin`） |
| 会话→场景四阶段快照模型 | `lib/client.js` L327-441 |
| Endfield AIC 全屏布局 | `lib/skin/endfield-aic.css`；`lib/client.js`（`AicRoot`/`AicMap`） |
| 开机场与启动抢跑 | `lib/client.js` L32-118, L988-1010 |
| 皮肤选择卡片 | `lib/client.js` L1325-1364 |
| 地图动态加载与渲染 | `lib/client.js` L1714-1820 |
| `uiSkin` 配置（默认/校验/写盘） | `src/state.js` L19, L48, L222 |
| `ui-skin.json` 端点 / 地图静态路由 | `src/ui.js` L40-96, L559-577 |
| UI RPC 通道注册 | `src/ui.js` L516-555；`src/index.js` L816-818 |
| 地图资源预压缩脚本 | `bin/pack-map-assets.mjs` |
