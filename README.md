# 归档会话 / Archive Manager

一个 DSH（DeepSeek Harness）插件，把三件事装进**同一个包**：

| 能力 | 位置 |
| --- | --- |
| **归档会话** 管理器（本插件的主功能） | 设置 → **归档会话** |
| **技能管理**（原 `dsh-plugin-skill-manager`） | 左侧边栏 → **技能** |
| **工作区配色**（原 `dsh-plugin-workspace-colors`） | 工作区行右键 / “…”菜单 → **更改颜色** |

安装这一个插件即可同时得到三者；原来的两个插件可以卸载。三者也能**单独开关**，见下面「功能开关」。

---

## 功能开关

一个包，四个开关。最简单的入口是插件自己的设置页：**设置 → 插件功能**，开关随点随存（保存在本机 `localStorage`）。也可以在 **设置 → 插件 → 归档会话 → 配置** 里改这一行的 `config`（部署级默认值），两者同时生效——功能只有在**两边都开着**时才运行。

| 键 | 默认 | 关闭后 |
| --- | --- | --- |
| `archive` | `true` | 设置里没有「归档会话」，会话「…」菜单没有「删除会话」，`/archive-manager/api` 不挂载 |
| `skills` | `true` | 侧边栏没有「技能」入口，`/skill-manager/api` 不挂载 |
| `colors` | `true` | 工作区没有彩色徽标、同色竖线与调色板（图标不受影响） |
| `icons` | `true` | 工作区「…」菜单没有「更改图标」，徽标回到 `#`（颜色不受影响） |

```yaml
- insert:
    - id: archive-manager
      name: 'dsh-plugin-archive-manager'
      config:
        archive: true
        skills: true
        colors: false   # 只关掉配色
        icons: true     # 图标照旧可用
```

宿主侧保存后立即生效（不挂载的路由即刻消失）；浏览器半边是在页面加载时读取同一组开关的，所以改完按 **⌘R** 刷新一次页面（「插件功能」页里有「立即刷新」按钮）。三个都关掉也不会报错——插件只保留这个开关页，方便你再打开。

## 1. 设置 → 归档会话

DSH 会把「归档」过的会话从侧边栏隐藏起来，但从来没有提供查看、恢复或删除它们的入口。这个页面补上这条路：

- **按项目分组** —— 每个已注册工作区一个分组，显示会话数量与占用空间；找不到所属项目的会话归入「未分组」。
- **搜索** —— 按标题、路径、项目名或会话 id 过滤，忽略大小写。
- **按项目筛选** —— 顶部项目胶囊（chip）一键只看某个项目。
- **重新激活** —— 单个会话，或整组「全部重新激活」，它立刻回到工作区里的原位置。
- **删除** —— 单个会话或整组删除，带二次确认；永久删除会话日志与投影缓存，**不可恢复**。
- **会话菜单里的「删除会话」** —— 会话行「…」菜单的最后一项，确认后永久删除该会话（**不需要先归档**）；「运行中」的会话仍会被拒绝。
- **状态可见** —— 每行显示标题、最后活动时间、日志大小，以及两种状态标记：
  - `运行中`：这一轮正在执行（来自宿主 `SessionSummary.running`）。
  - `已打开`：会话仍在这个窗口里开着，但当前没有在跑。归档只把会话从工作区列表隐藏，**不会关掉它的窗口**，所以归档后「已打开」是正常状态。
- **删除与「已打开」** —— `已打开` 的会话**可以删**：归档只隐藏会话，不关闭窗口，所以删除后那个窗口会失去这个会话，刷新就好。唯一会拒绝删除的是 `运行中`——先停止这一轮再删。
- **删除会通知界面** —— 删除成功后宿主发出 `api-session/removed`，浏览器随即把该行从会话目录里移除，所以侧边栏不会再把已删会话显示成「未分组」；旧版本需要手动刷新才会消失。

> 「重新激活」与「删除」都走宿主（Host）侧的真实接口：重新激活调用 DSH 自己的 workspace registry，删除前会先把会话从工作区分离并移出归档集合。

### 删除会做什么、不会做什么

- 删除前**拒绝**：正在运行的会话（`live`）、未归档的会话、id 不是 `session-<uuid>` 形式的请求。
- 删除时依次执行：从容纳它的工作区 `detachSession` → 从归档集合 `unarchiveSession` → 递归删除 `<DSH_HOME>/sessions/<编码cwd>/session-<uuid>/` → 删除 `session_projcache*` 下对应的缓存 JSON。
- 所有删除目标都必须证明位于 `<DSH_HOME>/sessions` 或 `<DSH_HOME>/storages` 之内，逐段做符号链接检查；任何越界项按失败上报，不中断整批。
- 删除**不会**碰你的工作区目录或任何项目文件。

---

## 2. 侧边栏 → 技能（技能管理）

- 范围切换：**用户级**（`$DSH_HOME/skills`）或当前**工作区**（`<项目>/.dsh/skills`）。
- 列出现有技能（名称、描述、来源、是否被同名技能遮挡、是否符号链接）。
- 启用 / 停用：把 `SKILL.md` 就地改名为 `SKILL.md.disabled`，符号链接技能不会被写穿到源目录。
- 删除、新建、从文件夹导入，以及从其它 agent 工具（如 Claude Code）的 skills 目录导入（复制或链接）。

## 3. 工作区配色

- 为工作区行替换带色 `#` 徽标，并给同工作区的会话加一条同色竖线。
- **10 种颜色**：灰、红、橙、黄、绿、青、蓝、紫、粉、棕，另有「默认颜色」清除当前配色；调色板超出窗口高度时在浮层内滚动。
- **颜色与图标是两个独立开关**：`colors` 管颜色（徽标底色、调色板、同色竖线），`icons` 管图标替换，互不影响；只开图标时徽标用中性灰底。
- **图标替换**：工作区「…」菜单里的「更改图标」提供 24 个内置图标（文件夹、终端、代码、搜索、分支、云、数据库、地球、心形、星形、书本、图表、对话、芯片、齿轮、首页、图片、钥匙、链接、邮件、地图、音乐、闪电、盾牌），选中后替换 `#` 徽标；没设颜色的工作区用中性灰底，选「默认图标（#）」恢复。
- 调色板是真正的 `shell.overlay` 浮层；颜色保存在浏览器 `localStorage`（`dsh.workspace-colors.v1`），不离开本机。

---

## 安装

安装的是**这个目录**（或这个仓库）。DSH 桌面端：**设置 → 插件 → 安装本地插件**，选择本目录。已装 `dsh` CLI 时也可以：

```bash
dsh plugin --profile desktop add /绝对路径/dsh-plugin-archive-manager
```

从 GitHub 安装：

```bash
dsh plugin --profile desktop add github:xwclr/dsh-plugin-archive-manager
```

安装后**刷新页面**（⌘R / Ctrl+R）：浏览器侧的「设置 → 归档会话」与「技能」入口在页面加载时注册。

### 从旧插件迁移

本插件合并了两个旧插件，安装后请把它们卸载或停用，否则会出现两个「技能」入口和两个调色菜单：

- `dsh-plugin-skill-manager`
- `dsh-plugin-workspace-colors`

原来两个仓库仍然保留，可以单独使用；但**不要和本插件同时启用**。

---

## 工作方式

```
设置 → 归档会话 ──POST /archive-manager/api/list|restore|delete──> lib/archive.cjs
侧边栏 → 技能   ──POST /skill-manager/api/*────────────────────> lib/skills.cjs
工作区配色      ──（纯浏览器，localStorage）──────────────────> lib/client.js
```

- 两个 HTTP 面都是宿主自己的 `webServer` 上的 JSON 路由，与 DSH 自带插件路由同样设防：只接受环回或受信主机、拒绝跨站浏览器请求。
- 浏览器半边是一个模块（一个包只能有一个 `dsh.client`），由 `src/features/` 里三份特性工厂拼装而成；其中一份激活失败不会带走另外两份。
- `lib/skills.cjs` 与 `lib/archive.cjs` 在每次 apply 时被重新 `require`，所以改完宿主逻辑切换一次插件开关即可生效，不必重启 DSH。

完整接口契约见 [`docs/API.md`](docs/API.md)。

## 目录结构

```
lib/
  index.js        宿主入口：解析 yaml、挂载两个路由
  archive.cjs     归档会话的宿主实现（list / restore / delete）
  skills.cjs      技能管理的宿主实现（原样迁入）
  client.js       浏览器半边（由 scripts/build-client.mjs 生成，勿手改）
src/
  features/skills.factory.js    技能页
  features/colors.factory.js    工作区配色
  features/archive.factory.js   设置 → 归档会话
  original/                     两个旧插件的原始 client 包（切分来源）
scripts/
  extract-factory.mjs   从 src/original 切出工厂体
  build-client.mjs      拼装 lib/client.js
test/
  archive-host.cjs      归档宿主的端点/守卫/文件副作用测试
  route-harness.cjs     两个路由前缀的端到端 HTTP 测试
  client-harness.cjs    浏览器半边：注册 + 渲染 + 交互
docs/API.md
locale/{zh,en}.json
icon.svg
```

## 开发

```bash
npm run build   # 切分 src/features + 生成 lib/client.js
npm run check   # node --check 全部运行时代码
npm test        # 三个 harness
```

改动只写入 `src/features/` 与 `lib/*.cjs`，然后 `npm run build`；直接编辑 `lib/client.js` 会被下一次构建覆盖。

## 许可

MIT
