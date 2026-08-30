# dsh-pet — 设计与实现

> 状态：已实现并运行。本文档描述当前实际实现；与代码有出入时以代码为准。
> 仓库：https://github.com/PC2005-cloud/dsh-pet

---

## 1. 项目定位

在 DeepSeek Harness Web 界面（`dsh web`）显示一只**常驻动画宠物**：待机呼吸、随机动作（含打瞌睡）、偶尔转向、屏幕漫游、点击反应、可拖拽。

**三件套成果**：

1. **提示词**（`prompts/`）——各动作的生成配方（绿幕规范 + 按秒分解）
2. **素材生成链**（`scripts/` + `video/`）——源视频 → 透明动画的完整处理管线
3. **插件**（`dsh-pet/`）——运行在 DSH 里的成品

任何人 clone 仓库后，可用提示词生成自己的宠物，跑素材链得到动画，安装插件使用——**从零到宠物全流程可复现**。

## 2. 素材处理链（Python + ffmpeg）

素材链在工作区 `scripts/` 目录，Python + ffmpeg 构成流水线：

> 注：`video/` 源 mp4 不入 git，托管在 GitHub Releases 的 `assets-videos.zip`（全部源视频打包，浏览器直接下载）。`dsh-pet/assets/preview/` GIF 在仓库内（README 用 raw 直链渲染——GitHub 不支持仓库内 webm 在 README 内联播放，GIF 是唯一可靠的仓库内渲染方案；Release 附件以 `application/octet-stream` 返回也无法渲染，故 GIF 必须留在仓库）。

```
video/（原始绿幕 mp4 + 水印 mask；源视频从 Releases assets-videos 下载）
  → watermark_step01.py  水印遮罩填充                → step01/（mp4）
  → step02（透明 webm）双轨：
      路线 A  chroma_step02.py   HSV 色相自动绿幕抠像  （默认，人人可复现）
      路线 B  pr_import_step02.py PR 手工抠像透明 .mov 导入（可选，质量覆盖，本项目全量采用）
  → normalize_step03.py  归一化 2160×1215 统一站立居中 → step03/（母版）
  → encode_thumbs.py     转码 640×360 播放变体        → step04/（thumb）
```

**step02 双轨说明**：两条路线产出同一级 `step02/`（透明 webm），后续步骤完全一致。

- 路线 A 全自动：HSV 色相绿幕抠像，适合无第三方物品、绿幕干净的场景，任何用户 clone 即可一键复现。
- 路线 B 手工覆盖：针对"含第三方物品/透明边缘复杂"的动作，自动抠像易残边（绿色溢出）或误抠（道具与绿幕交界），PR 手动遮罩质量更高。操作：在 PR 工程（`prproj/`，含 .prproj + 遮罩缓存）里抠像后导出带 alpha 的透明 mov（ProRes 4444 with Alpha）放入 `pr/`（文件名与动作名一致），跑 `pr_import_step02.py` 覆盖对应 step02。`pr/` 与 `prproj/` 均为本地工作数据，不入 git。
- 本项目 91 个动作**全量采用路线 B**；`chroma_step02.py` 保留作自动化兜底。

- 运行方式：`cd scripts && python watermark_step01.py`（依次 4 步；`make_mask_black.py` 生成水印 mask，`fill_nn.py` 被 watermark_step01 调用；路线 B 在第 2 步改跑 `python pr_import_step02.py`）
- 依赖：Python 标准库 + numpy + scipy + 工作区自带 ffmpeg（`.tools/`）
- 关键点（踩过的坑）：
  - `chromakey` + `format=yuva420p` 保留 alpha 透明
  - `-c:v libvpx-vp9` 必须放在 `-i` 前（libvpx 解码才能保留 VP9 alpha，否则黑底）
  - Windows 下 `subprocess.run(text=True)` 需 `encoding="utf-8", errors="replace"`
  - 绿幕抠像最终采用 **HSV 色相方案**（非 chromakey/RGB 差值）：仅绿相 70~~170° 且饱和度/明度 ≥0.15 才抠掉，人物保留 97~~98%、绿幕清除 99.6%+，不误伤亮绿残边/白衣/蓝衣
  - 水平居中用**非透明像素 x 中位数**（非 bbox 中点）：手/零食等扩展物会把 bbox 中心带偏 200px，中位数全片稳定
- step04 产物同步到 `dsh-pet/assets/webm/`（npm 包自包含播放资源；Safari 额外经独立流水线产出 `assets/mov/` HEVC-alpha）

## 3. 插件架构（dsh-pet/）

### 3.1 双半侧 bundle

```
dsh-pet/
├── package.json            # "dsh": {"bundle"} + exports["./client"] + "dsh":{"client"}
├── cordis.patch.yml        # insert pet 行
├── tsconfig.json / tsdown.config.mjs   # TS + tsdown 构建配置（双入口 client/host）
├── assets/
│   ├── config.jsonc        # 默认配置（桌宠、动画、通知、余额与刷新周期）
│   ├── webm/*.webm         # Chrome/Edge/Firefox 播放资源
│   ├── mov/*.mov           # Safari HEVC-alpha 播放资源
│   └── preview/*.gif       # README 预览（拼音命名）
├── src/
│   ├── host/*.ts           # host：路由、余额、逐会话计费、定价与配置合并
│   └── client/*.ts         # client：动画、会话隔离、设置、余额气泡与通知
├── lib/                    # tsdown 构建产物（gitignored，prepare 自动构建）
│   ├── index.js            # host 半侧（构建产物）
│   ├── client.js           # 浏览器半侧（构建产物，__ModuleLoader__ 形态）
│   └── types/              # TypeScript 声明
├── scripts/prepack-check.js # npm 发布前健康检查
├── README.md               # 极简（指向仓库）
└── LICENSE                 # MIT
```

### 3.2 host 半侧（src/host → lib/index.js）

- 注册 `/dsh-pet-7340/` 前缀路由（`ctx.webServer.register`）：
  - `thumb/<name>.webm|mov` → 用户动画目录优先，其次包内对应格式资源
  - `config.jsonc` → 包内默认配置；`config` → `$DSH_HOME/dsh-pet/main-config.json` 的 GET / PUT / DELETE
  - `balance` / `balance/trigger` → 当前会话 provider 的余额与 `/balance` 手动触发计数
  - `turn-spend` / `turn-spend/debug` → 当前会话最近一轮费用与去标识诊断
- 订阅 DSH `session/event`：以 `request/header` 的实际 provider/model 路由和 `assistant/message` usage 结算；非 DeepSeek、未知模型、未完成或混合币种回合不生成金额
- 官方定价页每 6 小时单次抓取全部模型；同一 provider 的余额请求单飞；所有会话状态均按 session id 隔离并有数量上限
- 静态文件做规范化与真实路径双重防穿越；配置请求体限 1 MB，局部 PUT 保留未提交的高级字段

### 3.3 浏览器半侧（src/client → lib/client.js）

- 启动时经 `/dsh-pet-7340/config.jsonc` + `/dsh-pet-7340/config` 拉取并严格校验默认配置与用户覆盖
- 注册到官方 `shell.overlay` 列表槽（全应用浮动层，点击穿透）
- **多开**：`PetMulti` 容器按 `pets` 列表渲染多个 `PetCard` 实例，每只独立大小/位置/播放/漫游/拖拽；动画池共享（`ANIM` 只读）
- **设置页**：`settings.section` 插槽注入「桌宠配置」（id: pet-config）——大小/位置/边距编辑、增删宠物，保存即时生效（`petBridge.sync`）
- **会话跟随**：订阅 `ctx.sessions.list`，切换 DSH 会话时清空旧余额/费用并改查新会话；多桌宠只显示一份单轮费用
- **请求调度**：余额、费用与命令触发均使用完成后 `setTimeout` 的串行轮询；余额刷新在 client/host 两侧单飞
- **系统通知**：消费 DSH mux/host 事件，仅失焦时提示；权限仅由设置页用户手势申请，重放去重集合有上限
- **双缓冲播放**：两个 `<video>` 层叠交叉淡入，切换永无空白帧
- **竞态防护**：`genRef` 代数守卫 + `old !== el`，快速连点不导致宠物消失
- **朝向系统**：`facing`（left/right），right 时 CSS `scaleX(-1)` 镜像（素材全对称、不穿帮）
- **落地对齐**：360 画布脚底 y=330，按比例平移舞台使脚踩地面

### 3.4 构建形态

- TypeScript 源码在 `src/`（host 半侧 `src/host/`、浏览器半侧 `src/client/`），`tsdown` 按 `tsdown.config.mjs` 双入口构建为单文件 `lib/index.js` / `lib/client.js`
- `lib/*.js` 为构建产物（gitignored）；发布前必须运行 `prepare:webm` 或 `prepare:mov` 完成构建与扩展名注入
- `prepack` 依次执行单元测试、类型检查、lint、格式检查与产物健康检查；若 `__PET_EXT__` 尚未注入或素材格式不匹配会阻止发布
- 运行形态不变：client 半侧为官方 `__ModuleLoader__.load({ id, factory })`，React 从 DSH 外壳平台模块表 require（不自己打包）
- 开发构建：`npm run bundle`；可安装发布产物：`npm run prepare:webm` / `npm run prepare:mov`

## 4. 动画流程（链式模型）

**核心设计：没有常驻待机、没有定时器**。每个动画（含待机呼吸休闲）都是一次性播放，播完立即按概率选下一个——首尾相接、永不停止。

### 4.1 动画分类

| 组       | 动画                                 | 用途                                |
| -------- | ------------------------------------ | ----------------------------------- |
| 待机     | 待机呼吸休闲                         | 链中一环（30% 概率），播 10s 后切走 |
| 转向     | 东张西望                             | 播完翻转 facing                     |
| 移动     | 螃蟹走路、原地漂浮踏步、原地左转奔跑 | 漫游姿态（位置由代码驱动）          |
| 动作池   | 其余全部（含打瞌睡被惊醒）           | 等概率随机抽 1 段                   |
| 点击回应 | 点击回应（多项）                     | 仅点击触发                          |
| 拖拽     | 被鼠标拖拽悬空反馈                   | 仅拖拽触发                          |

### 4.2 动画链

```
开始（初始待机呼吸休闲）
  │ 播完（10s）
  ▼
pickNext() 按权重选下一个 ────────────────────────┐
  idle/turn/move 权重 + 分类权重全部配置于 config.jsonc │
  （默认 idle10 / turn5 / move5，分类合计 80）        │
  └──────────────────────────────────────────────┘
        ▲ 播完
        └── 循环（永不停止）

交互打断：点击/拖拽 → 交互动画 → 播完先回待机缓冲 → 待机播完进动画链
```

### 4.3 关键机制

- **`pickNext()`**：权重制。`roll = Math.random()`，按 `animationWeights`（默认 idle10/turn5/move5）归一化切分：`roll < wI/100` 待机、`< (wI+wT)/100` 转向、`< (wI+wT+wM)/100` 尝试移动（空间不足回退分类抽）、其余走 `pickWeightedCategory` 抽动作分类（分类自带 weight：小动作20/玩耍20/吃什么16/时节14/文字10）
- **`noMirror`**：文字类分类 `noMirror: true`——宠物面向右（CSS 镜像）时剔除该类，其余分类权重归一化重算，避免镜像后文字颠倒穿帮
- **`seq` 序号**：每次切换 +1，连续选中同一动画也强制重播
- **移动系统**：动画是"皮"（姿态）、rAF 是"骨架"（位移），位置随 `video.currentTime` 同步；前后各 2s 准备/收尾位置不动，中间 6s 走完全程；播放前检查屏幕空间
- **交互**：点击回应随机、拖拽超 5px 判定 + 跟手、松手停在拖拽处

## 5. 配置项

配置分两层：包内 `dsh-pet/assets/config.jsonc` 是完整默认值，用户覆盖写入 `$DSH_HOME/dsh-pet/main-config.json`：

- `pets` 数组定义默认宠物列表（每只：`id` / `size` / `balanceEnabled` / `position`），首只是「添加宠物」模板
- 设置页使用局部 PUT，只更新自己提交的宠物或通知字段；已有动画、刷新周期、定价等字段保持不变
- 「恢复默认」删除整个用户层并将运行中桌宠、通知与配置同步回默认值
- 客户端对合并后的完整配置严格校验；格式错误会显式报错，不运行残缺配置

| 配置                               | 说明                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pets[]`                           | 默认宠物：`id` / `size` / `balanceEnabled` / `position`；多只即多开                                                   |
| `animations.idle/turn/drag/clicks` | 待机 / 转向 / 拖拽 / 点击回应 动画池（数组）                                                                          |
| `animations.moves`                 | 移动池：`default` 公共参数 + 每动作 `params` 覆盖（minDist/maxDist/margin/leadSec/tailSec，默认 60-240px/20px/2s/2s） |
| `animations.categories`            | 动作分类池（小动作/玩耍/吃什么/时节/文字），含 `weight` 与 `noMirror`                                                 |
| `animationWeights`                 | 动画链顶层权重 idle/turn/move（默认 10/5/5，与分类权重合计 100）                                                      |
| `eventsRefreshSec.balance`         | 余额刷新秒数，默认 180；点击桌宠和 `/balance` 可即时触发                                                              |
| `deepseekFullBalanceCny`           | DeepSeek 钱袋动画满额参考值，默认 20，仅影响档位                                                                      |
| `notificationsEnabled`             | 系统通知总开关                                                                                                        |
| `pricing.models.<modelId>`         | 可选的逐模型 DeepSeek 定价覆盖；旧式平铺 `pricing` 仅兼容 flash                                                       |
| `scripts/encode_thumbs.py`         | 转码分辨率/质量（640×360 / CRF 40），脚本侧常量                                                                       |

## 6. 构建与发布

```
1. scripts/*.py（素材链）    video/ → step01 → step02（自动或 PR 导入）→ step03 → step04
2. step04 → dsh-pet/assets/webm/（同步；Safari mover 由独立流水线产出到 assets/mov/）
3. prepack-check.js          npm publish 前健康检查
4. npm pack                  检查 tarball（~10MB）
5. npm publish               之后 dsh plugin add dsh-pet 一条命令安装
6. GitHub Releases           仅作源视频存储：`assets-videos` release 放 `assets-videos.zip`，视频内容变化时替换该资产（不随插件版本发布）
```

## 7. 许可

- 代码：MIT（仓库根 + dsh-pet/LICENSE）
- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**
