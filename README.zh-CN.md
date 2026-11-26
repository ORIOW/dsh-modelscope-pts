# dsh-modelscope-pts

[English](README.md) | [简体中文](README.zh-CN.md)

一个 DeepSeek Harness（DSH）Desktop 插件，在两处实时显示你的 **ModelScope 账号剩余魔粒（积分）余额**：

- **模型选择器**——每个 ModelScope 模型行旁的魔粒 chip（`魔粒 N`），余额不足时附带**低余额警告牌**；
- **插件页**——完整余额面板与凭据管理，位于 **插件 → 已安装 → dsh-modelscope-pts → 配置**。

本包还附带第二个可独立启停的组件——**ModelScope 每日互动**：按计划自动为未星标的模型点赞领取魔粒。见[组件](#组件)。

## 组件

本包含**两个组件**（插件 → 已安装 → dsh-modelscope-pts → *包含的组件*），各自独立启停、各自有组件卡：

### ModelScope 魔粒余额（`modelscope-pts`）

即下文描述的余额展示：模型选择器 chip、低余额警告、插件页面板与凭据管理。这里配置的凭据与每日互动组件共用。

### ModelScope 每日互动（`modelscope-magicube`）

按计划自动点赞领取魔粒的任务（每次点赞 2 分、每日 10 次封顶）：

- 只点**未星标**的模型，绝不取消已有的喜欢；跳过本人模型（按 Path 属主与创建者判断），从目录翻页收集（`/api/v1/dolphin/models`，≤6 页 × 100 条，点赞前随机洗牌）。
- 每日运行时间可配置（`HH:MM`，默认 `09:30`）；到点没开机会在下次启动后**补跑**。若到点时运行失败（如网络未就绪、Cookie 失效），当天不再自动重试（避免全天空转），修复后用组件卡上的**立即运行**按钮恢复。
- 相邻两次点赞之间**随机等待 1~10 秒**。
- 需要**会话 Cookie**——与余额组件共用同一份；仅访问令牌无法点赞。
- 每日互动运行时会自动用**默认浏览器**打开 ModelScope 页面领取登录奖励（**每天最多一次**）。地址默认「我的概览」页 `https://www.modelscope.cn/my/overview`；组件卡可配置自定义地址或关闭该行为。打开失败只记日志，**绝不阻塞点赞**。
- 内置**模型可用性探测**：按可配置间隔（默认 14 天）核对「已添加的 ModelScope 模型」是否仍可推理；组件卡可**立即探测**，结果按模型任务分类分组展示，有模型下架时给出**红色警示**。探测只读——**绝不修改**你的模型配置。
- 组件卡展示每日结果（成功/失败/跳过）；运行记录存放在 volatile 配置字段，重启不丢。

本组件是独立 Python 项目 `modelscope-magicube` 的**插件实现**（同一套每日点赞流程）；插件版直接跑在 DSH Desktop 里，**无需 Python**。

## 工作原理

插件读取 ModelScope 余额接口：

```
GET https://www.modelscope.cn/openapi/v1/magicubes/balance
```

并展示 `data.available_balance`（可用）与 `frozen_amount`（冻结）：插件页面板显示两项，模型选择器 chip 只显示可用余额。（`total_balance` 会拉取但不展示。）

### 低余额警告

当可用余额降至 **25 魔粒及以下**（阈值常量 `LOW_BALANCE_THRESHOLD`，见 `lib/client.js`）时，模型选择器的魔粒 chip 右侧出现一枚红色三角感叹号警告牌，悬浮文案末尾追加「，余额不足」。警告牌只在 chip 本身渲染时出现（ModelScope provider 的模型行、下拉选项位、展示开关开启），且必须有有效余额读数——没有读数时不会误报。

### 每日登录奖励（自动打开浏览器）

每日互动任务（定时或手动「立即运行」）运行当天首次会尝试用默认浏览器打开 ModelScope 页面，领取登录奖励：

- 地址：默认「我的概览」页 `https://www.modelscope.cn/my/overview`（2026-11-26 起 profile 页无法访问，已弃用）；组件卡配置的自定义地址（须 `http(s)://` 开头）优先于默认值。
- 「每天最多一次」按**尝试**计：打开失败也记录当天已尝试（volatile `lastBrowserOpenDate`），同日手动重跑不会重复打开。
- 平台实现：Windows `cmd /c start`、macOS `open`、Linux `xdg-open`（detached 启动，不阻塞插件）；失败只写日志。

### 模型可用性探测

插件按 `probeIntervalDays`（默认 14 天，下限 1）周期探测你在 profile 用户补丁层（`llm-pi-ai` 行）添加的 ModelScope 模型是否仍可推理：

1. 读取 profile 补丁文件（`DSH_PROFILE_DIR` 优先，兜底 `%APPDATA%\dsh-desktop\harness\profiles\desktop\cordis.patch.yml`），解析出 `config.providers.modelscope.models[].id`；读不到时状态显示「未找到已添加的 ModelScope 模型」，不报错。
2. `GET https://api-inference.modelscope.cn/v1/models` 取可推理 id 集合（匿名可读；若凭据库解析到 `MODELSCOPE_API_KEY` 则附带 Bearer，值绝不进日志/RPC/UI）。
3. 两级判定：不在推理清单 → `GET /api/v1/models/{ns}/{name}` 确认——404 + `Code: 10010205001` 判「已下架」；200 判「推理不可用」（可能 gated）；在清单判「可用」。
4. 结果按详情 `Data.Tasks[0].ChineseName`（缺则 `Name`）分组展示；有模型下架时摘要行出现红色警示「⚠ N 个已添加模型已下架：…」。

探测与每日点赞互不阻塞（共用 60 秒调度 tick，两把独立互斥锁）；探测失败只影响探测状态。该功能**只读**——只提示，绝不增删改你的模型配置。

### 凭据

ModelScope 使用会话 Cookie 鉴权，而宿主侧插件无法读取浏览器里的 Cookie。因此本插件支持两种凭据来源，均在插件配置页填写：

1. **访问令牌**（`ms-…`）——以 `Authorization: Bearer <token>` 发送。在 ModelScope → 个人主页 → 账号设置 → 访问令牌 页面创建。
2. **会话 Cookie**——从已登录的 `www.modelscope.cn` 请求头里复制的完整 `Cookie:` 字符串（核心是 httpOnly 的 `m_session_id`）。

策略：**令牌优先、Cookie 回退**。配置了令牌则先走令牌；若请求被以鉴权错误（HTTP 401/403）拒绝且同时配置了 Cookie，插件会改用 Cookie 重试。只配 Cookie 则直接使用。凭据存放在宿主凭据库（`ctx.credentials`）——绝不写入插件配置文件，也绝不回显到界面。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `package.json` | 插件清单（`dsh.bundle.patch`、`dsh.client`）。 |
| `cordis.patch.yml` | 注册插件的 bundle 补丁。 |
| `lib/index.js` | 宿主半身：拉取余额、管理凭据、暴露 RPC。 |
| `lib/rpc.js` | 共用 RPC 通道机制（信封、信任判定、限长）。 |
| `lib/client.js` | 客户端半身：注册模型行徽章与两张插件配置卡。 |
| `lib/magicube.js` | 每日互动组件宿主半身：调度、点赞任务、RPC。 |
| `magicube/` | 每日互动组件资源：locale（`meta.title`/`meta.description`）与图标。 |
| `locale/` | 显示元数据（标题/描述），中英双语。 |
| `icon.svg` | 插件图标。 |

## 安装

通过 Harness **插件管理器**安装——可以从 DSH 插件市场里本仓库的条目安装，也可以作为本地 bundle tarball 安装（`install_bundle`）。插件面向 DSH Desktop **0.14.0** 与 `web` 客户端平台。

### 无需手改 YAML

插件通过**随包分发**的 bundle 补丁自我注册（[`cordis.patch.yml`](cordis.patch.yml)，经 `package.json` 的 `dsh.bundle.patch` 声明）。插件管理器把本包加入 profile 的 bundle 列表后，Harness 加载器会在启动时自动叠加该补丁层。你**不需要**手动编辑以下任何文件：

- profile 级 `cordis.patch.yml`（用户层），
- `pnpm-workspace.yaml`，
- profile 的 `package.json`（包括任何 overrides 行）。

### 前置条件

- 安装前后可能需要重启一次：若 profile 存在未落地的 pending generation 更新，插件管理器会拒绝应用新 bundle，直到 DSH Desktop 重启过一次。（这是插件管理器的通用行为，非本插件特有。）
- 模型选择器的 chip 只出现在 **ModelScope** provider 的模型行旁（`provider.id === "modelscope"`）。若 profile 未配置 ModelScope provider，插件依然可用——余额面板在其配置页上——只是没有 ModelScope 模型行可装饰。

### 首次运行

1. 安装插件，重启 DSH Desktop（或新开一个会话）。
2. 打开 **插件 → 已安装 → dsh-modelscope-pts → 配置**。
3. 填写凭据——访问令牌（`ms-…`）或会话 Cookie。插件令牌优先、鉴权失败时回退 Cookie，见[凭据](#凭据)。
4. 保存。余额面板与模型选择器 chip 自动刷新（默认间隔 60 秒，可配置）。

## 许可

MIT — 见 [LICENSE](LICENSE)。
