# Chroma

Chroma 是一个独立、开源、基于 Chromium/Electron 的桌面浏览器项目。
它借鉴了 Arc 的设计语言，并参考 Zen Browser 的垂直标签、工作区、文件夹、
紧凑侧边栏和多页面分屏等工作流，但所有产品代码均为面向 Chromium 的原创实现。

> Chroma 是一次完整重写，**不是**从 Zen 的 Firefox 代码迁移而来。
> 本仓库不包含 Arc 或 Zen 的源代码、Logo、图标、字体及其他品牌资产，
> 也不代表 The Browser Company 或 Zen Browser 项目的官方产品或背书。

> 当前版本是可运行的早期开发里程碑，已经具备真实 Chromium 网页承载和大量浏览器交互，
> 但仍不适合作为生产级日常浏览器。密码、自动填充、WebAuthn、完整扩展兼容、
> Safe Browsing、同步、签名更新等成熟浏览器服务仍在后续路线中。

## English summary

Chroma is an independent Chromium/Electron browser rewritten from scratch.
It uses an Arc-inspired visual language and studies Zen Browser workflows,
without porting Zen's Firefox code or reusing Arc/Zen brand assets. The project
is runnable and actively tested, but it is still an early development milestone
rather than a production-ready daily browser.

## 当前进度

| 模块 | 状态 | 当前能力与主要缺口 |
|---|---:|---|
| Arc 风格底板与垂直侧边栏 | 基础可用 | 无边框窗口、圆角网页外框、macOS 红绿灯、可调宽度侧边栏、完全隐藏与左缘悬浮唤出已实现；右侧布局和跨平台材质仍待完善 |
| 标签页与 Essentials | 可用 | 真实标签、排序、关闭/恢复、固定、静音、手动卸载、Essential 保存页复位、单页崩溃恢复已实现；自动内存回收和跨窗口移动仍缺失 |
| Workspaces 与文件夹 | 基础可用 | 创建、切换、拖动排序、删除、标签跨 Space 移动、标签拖入/拖出文件夹已实现；更丰富的批量管理和跨窗口同步仍缺失 |
| 二至四页分屏 | 可用 | 拖拽标签创建分屏、胶囊排序/脱离、2–4 个真实 `WebContentsView`、嵌套比例、实时拖动和 50/50、70/30、30/70 预设已实现 |
| 地址栏与导航 | 基础可用 | URL/搜索、前进后退、刷新停止、标题、图标、弹窗转标签和新标签页已实现；默认搜索引擎设置和完整 Chromium Omnibox 能力仍缺失 |
| 书签 | 基础可用 | 本地收藏、八级嵌套文件夹、拖放、重命名、搜索、地址栏建议、Netscape HTML 导入/导出已实现；多选管理和同步仍缺失 |
| 历史与下载 | 可用 | 本地历史查询/删除/保留策略，以及 Electron 下载暂停、继续、取消、打开、定位和持久化终态均已实现 |
| 容器身份 | 基础可用 | 独立 Chromium 存储分区、创建/重命名/删除、标签迁入迁出、独立代理和 User-Agent 已实现；容器级扩展、书签和历史策略仍缺失 |
| Chrome 扩展 | 基础可用 | 可安装、持久恢复、重载和移除解压后的 MV3 扩展；支持 action 图标和受限弹窗；Web Store、`.crx` 和完整 `chrome.*` API 尚未支持 |
| Glance、实时文件夹与媒体 | 基础可用 | 链接临时预览、RSS/Atom 文件夹、媒体播放/暂停、画中画、Now Playing 和硬件播放键已实现；更完整的媒体传输与订阅策略仍缺失 |
| 站点信息与认证 | 基础可用 | 连接状态、容器提示、复制地址、按来源清除站点数据，以及 HTTP Basic/Proxy 临时认证对话框已实现；证书详情、持久权限管理、密码库和 WebAuthn 仍缺失 |
| 外观 | 可用 | System/Light/Dark、Space 强调色和 Reduce Transparency 已持久化；完整设置中心尚未实现 |
| 本地 macOS 包 | 可用 | 可以生成并启动验证未签名 `.app`、DMG 和 ZIP；正式发布仍需要 Developer ID 签名、Hardened Runtime、公证和更新系统 |

更细的能力矩阵和剩余工作见
[`docs/PARITY.md`](docs/PARITY.md)。

## 主要功能

### 窗口、侧边栏与页面底板

- Arc 风格的统一底板、圆角网页表面、纵向标签栏和 macOS 窗口控制。
- 展开侧边栏默认宽 228 px，可拖动调整；收起后不保留可见窄条。
- 鼠标进入左侧不可见热区时显示不挤压页面的圆角悬浮侧边栏，离开后完全隐藏。
- 深色、浅色和跟随系统主题；可按 Space 设置强调色，并提供降低透明度模式。
- 网页使用真实原生边界和缩放值 `1` 进行重排，不通过缩小字体伪造响应式布局。

### 标签、工作区与分屏

- 标签选择、拖动排序、关闭/重新打开、固定、Essential、音频状态、静音和手动卸载。
- 页面渲染进程异常退出时，只隐藏出错 pane；可在不破坏标签 ID、文件夹和分屏拓扑的情况下重载恢复。
- Space 创建、切换、拖放排序和确认删除；符合条件的普通标签可以跨 Space 移动。
- 标签文件夹支持创建、重命名、删除、折叠以及标签拖入/拖出。
- 通过把标签拖到另一个标签的左、右、上、下区域创建二至四页分屏。
- 活动分屏胶囊按真实 pane 拓扑和比例显示，非活动分屏压缩为单行。
- 分隔线支持鼠标实时预览、键盘调整、双击复位和持久化比例。
- 每个标签可请求移动版、桌面版或自动 User-Agent，以处理窄 pane 中不响应的网页。

### 浏览数据与生产力

- 真实 Chromium 地址导航、网页搜索、前进/后退、刷新/停止和弹窗转标签。
- 本地历史支持搜索、日期分组、分页、选择删除、时间范围清理和记录/保留/退出清理策略。
- 下载支持暂停、继续、取消、打开、在 Finder 中显示、移除和清理完成记录。
- 书签支持嵌套文件夹、拖放整理、重命名、搜索、地址栏建议及 Chrome/Firefox/Zen 通用的 Netscape HTML 导入导出。
- 命令面板支持中英文检索、上下文可用性判断和键盘操作。
- 应用菜单、Shell、悬浮侧边栏和网页使用同一份严格修饰键匹配的浏览器快捷键注册表。

### 隔离、扩展与页面能力

- 容器标签使用独立持久 Chromium partition，Cookie、缓存和站点存储不会与默认身份或其他容器混用。
- 每个容器可以单独设置 `http`/`https`/`socks4`/`socks5` 代理和 User-Agent。
- 支持加载解压后的 MV3 扩展、持久恢复、重载、移除、action 图标及受限扩展弹窗。
- Glance 可以在当前页面上方临时预览链接；`Esc` 关闭，`Cmd/Ctrl+Enter` 转为真实标签。
- RSS/Atom 实时文件夹最多展示 30 条内容，支持后台限频刷新，并在失败时保留最后一次成功数据。
- 媒体命令支持播放/暂停和画中画；Now Playing 列表展示 MediaSession 标题、作者、封面、静音和跳转。
- 站点信息面板支持查看基础连接状态、复制地址，以及在标签自己的 partition 中清除当前来源的数据并刷新。
- HTTP Basic/Proxy 认证凭据只交给 Chromium 当前请求，Chroma 不自行持久保存。

### 安全边界

- 普通网页启用 Chromium sandbox、`contextIsolation` 和 `webSecurity`，禁用 Node.js 集成。
- Preload 只暴露明确允许的命令和经过净化的数据结构。
- 不支持的外部 scheme、危险导航和越界扩展资源默认拒绝。
- 权限处理、窗口销毁和 WebContents 访问采用 fail-closed 逻辑，避免销毁竞态变成主进程异常。

## 本地运行

环境要求：

- Node.js 22 或更高版本
- npm
- 当前主要在 macOS 上开发和验证；Windows/Linux 路径存在，但尚未完成同等级原生材质与交互验收

```bash
npm install
npm start
```

开发配置保存在 Electron 对应平台的 `Chroma` user-data 目录中，
主要浏览器状态写入该目录下的 `browser-state.json`。

## 测试与验收

完整串行门禁：

```bash
npm run verify
```

`verify` 依次执行：

1. 语法检查及 Node 单元/源码契约测试；
2. 多启动 URL、单窗口所有权和失败窗口清理；
3. 多次重启后的标签、Space、文件夹、分屏、侧边栏及外观恢复；
4. 真实 Electron 运行时交互和清理测试；
5. Shell/首个页面启动时间及 1/8 标签完整进程树 RSS 回归门禁。

确定性视觉回归独立执行：

```bash
npm run visual
```

当前视觉门禁在 1280×720、DPR 1 下组合 Shell 和原生网页截图，覆盖深/浅色展开、
完全收起、独立悬浮侧边栏、60/40 两分屏、非对称三分屏和 2×2 四分屏。
它衡量的是 Chroma 自身基线回归，不是 Arc 或 Zen 的相似度分数。

详细测试边界见 [`TESTING.md`](TESTING.md)，视觉证据说明见
[`UI_COMPARISON.md`](UI_COMPARISON.md)，性能方法见
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)。

## macOS 本地打包

生成并验证可启动的未签名 `.app`：

```bash
npm run package-smoke
```

生成未签名 DMG 和 ZIP：

```bash
npm run package:mac
```

典型产物：

- `dist/mac-arm64/Chroma.app`（具体目录取决于主机架构）
- `dist/Chroma-0.1.0-arm64-unsigned.dmg`
- `dist/Chroma-0.1.0-arm64-unsigned.zip`

打包门禁会校验 bundle identifier、图标、ASAR 运行时白名单、Preload bridge、初始真实浏览器状态，
并拒绝把测试、脚本、文档、生成制品或本地 profile 泄漏进应用包。
许可证和 notice 会作为可直接读取的资源写入 `Contents/Resources/licenses/`。

这些产物是本地测试包，**未签名、未公证，不是正式发布包**。
公开分发前仍需 Developer ID、Hardened Runtime、entitlements、公证、自动更新、
发行通道、冻结制品 SBOM 和完整法律审查。详见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 架构

```text
Renderer Shell 与交互状态
            │
        白名单命令桥
            │
     Electron 浏览器宿主
            │
沙箱化 Chromium WebContentsView 网页
```

- `src/shared/`：版本化状态、导航、命令、快捷键、搜索排序、分屏树、几何和状态修复。
- `src/renderer/`：不直接导入 Electron 的 Chroma Shell 与交互界面。
- `src/preload/`：窄化的 `window.chromaBrowser` 安全桥。
- `src/main/`：窗口、WebContentsView、导航、会话、历史、下载、权限、扩展、持久化和生命周期。
- `scripts/`：真实 Electron E2E、会话恢复、窗口生命周期、性能、视觉和打包门禁。

当前 profile schema 为 **13**：

- schema 3：本地历史；
- schema 4：下载终态记录；
- schema 5：分屏比例树；
- schema 6：外观设置；
- schema 7：书签文件夹；
- schema 8：容器身份；
- schema 9：RSS/Atom 实时文件夹；
- schema 10：嵌套书签文件夹；
- schema 11：Essential 保存页；
- schema 12：容器代理；
- schema 13：容器 User-Agent。

这种边界让 Chroma 将来可以替换为更深层的 Chromium browser-layer 宿主，
而不需要丢弃现有产品 UI 和浏览器无关状态模型。详细决策见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`DESIGN.md`](DESIGN.md)。

## 尚未完成

- 生产级 Chromium 密码、自动填充、WebAuthn、Safe Browsing、证书和完整权限管理；
- 完整 Chrome Web Store/`.crx` 安装、全部 MV3 API 与容器扩展策略；
- 云同步、私密窗口、多窗口状态协调、崩溃上报和成熟会话恢复体验；
- 完整设置中心、默认搜索引擎管理、快捷键重映射和扩展命令；
- Widevine、专有编解码器和需要供应商密钥的服务；
- Windows/Linux 同等级视觉验收、签名安装程序、自动更新与发布回滚；
- 完整无障碍、本地化和长时间压力/能耗测试。

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：宿主边界与未来 Chromium 路线
- [`DESIGN.md`](DESIGN.md)：已实现交互和关键设计决策
- [`docs/PARITY.md`](docs/PARITY.md)：能力状态及剩余工作
- [`TESTING.md`](TESTING.md)：自动化证据、打包/视觉门禁和人工验收边界
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)：启动/RSS 回归方法、阈值和当前测量
- [`UI_COMPARISON.md`](UI_COMPARISON.md)：Chroma 自回归视觉基线及外部对比限制
- [`docs/HISTORY-SPEC.md`](docs/HISTORY-SPEC.md)：本地历史契约
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)：依赖许可证快照和发布义务

## 许可证与商标

Chroma 源代码采用 [Apache License 2.0](LICENSE)。第三方依赖仍使用其各自许可证；
重新分发源代码或二进制文件时必须保留相应 notice。另见
[`NOTICE.md`](NOTICE.md) 和 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

`Chroma` 是本独立项目名称。Arc、The Browser Company、Zen Browser、Firefox、
Chromium、Electron、Chrome、macOS、Windows 和 Linux 均为其各自权利人的名称或商标。
本文对 Arc 和 Zen 的提及仅用于说明设计灵感与交互研究，不代表所有权、关联、背书、
源码复用或品牌资产使用授权。
