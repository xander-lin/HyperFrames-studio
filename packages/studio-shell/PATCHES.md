# 上游改动清单

本文件登记对上游 `@hyperframes/studio` 源码的**每一处**改动。升级上游时按此重放。
每处改动在源码内都有 `MYSTUDIO:` 注释，可 `grep -rn "MYSTUDIO:" src/` 定位。

基线：`heygen-com/hyperframes` `packages/studio` @ **0.9.21**（Apache-2.0）。

---

## 1. `src/App.tsx` — 挂载批注层

**位置**：`StudioApp` 的返回值，`DomEditProvider` 内部，`<StudioOverlays />` 之后。

```tsx
<MyStudioOverlay />
```

**顶部 import**：

```tsx
import { MyStudioOverlay } from "./annotate/mount";
```

**必须挂在 provider 内部**：批注层要读 `useStudioPlaybackContext()`
（播放头、composition 路径）与 `useStudioShellContextOptional()`（画布尺寸），
挂在外面会抛 `useStudioPlaybackContext must be used within StudioPlaybackProvider`，
整个 Studio 变成错误页（已实测）。

**不要在这里加 padding**：早期版本为右侧批注栏加了
`paddingRight: var(--mystudio-panel-width, 320px)`，等于永久砍掉 320px 画面。
现在批注是**模式**而非侧栏，覆盖在画布上，完全不参与布局。

---

## 2. `src/components/StudioHeader.tsx` — 去掉两个不属于桌面端的入口 + 登记动作

**改动 A**：移除 `<OpenInDesktopButton />`（含其 import）。
那个按钮是给浏览器版 Studio 用的，我们的应用**本身就是桌面端**，
它只会误导用户去下载一个已经装好的东西。

**改动 B**：移除 `<Dock.WindowMenu />`（含 `Dock` import）。
版面显隐改由「屏幕小精灵」承担——它吸附在窗口边缘，并且能同时列出
此刻可用的快捷键。一个只有文字的 "Window" 按钮既没表达出它能做什么，
也让顶栏显得拥挤。

**改动 C**：给根节点加 `data-mystudio-header=""`，供 CSS 整条隐藏。

**改动 D**：用 `registerHeaderActions({...})` 把顶栏能力登记出去
（Capture / Inspector / Export / 主题）。顶栏被隐藏时，小精灵从这份注册表里
调用同样的逻辑——**不存在两套实现**。

---

## 3. `src/components/dock/panelRegistry.ts` — 新增顶层版面清单

```ts
export const TOP_LEVEL_PANELS: readonly PanelId[] = PANEL_IDS.filter(
  (id) => PANEL_DEFINITIONS[id].reopen.direction !== "within",
);
```

**为什么**：`Assets` / `Code` / `Layers` / `Renders` 等是**面板组内部的标签页**
（`direction: "within"`），不是可独立开关的版面。小精灵只列
Preview / Timeline / Compositions / Design 这四项。
纯新增，不改变任何既有行为。

---

## 4. `src/main.tsx` — 引入界面覆盖样式

```ts
import "./annotate/mystudio.css";
```

只引入一个我们自己的 CSS 文件（顶栏可隐藏等），不改上游样式表本身。

---

## 5. 未改动的上游文件

除上述文件外，`src/` 下所有上游文件逐字节未改。上游自带的 700 个测试文件
完整保留（未删除、未弱化），只是不在本仓库运行——它们依赖上游 monorepo 的
fixture 与 workspace 布局。它们是升级时的行为对照资产。

---

## 升级步骤

```bash
# 1. 替换 src/ 为上游目标版本
# 2. 重放上面 4 处改动
grep -rn "MYSTUDIO:" src/          # 确认每处都在
# 3. 构建 + 类型检查
pnpm --filter @mystudio/studio-shell build
pnpm --filter @mystudio/studio-shell typecheck
# 4. 跑本项目自己的测试（不含上游 700 个）
pnpm --filter @mystudio/studio-shell test
```

若上游把 `PropertyPanel` 改为不再由 dockview 承载，需同步检查
`src/annotate/inspectorBridge.ts` 的 `findDesignPanel()` 锚点
（当前依赖 `data-tab-panel-id="design"` + `aria-controls`）。
