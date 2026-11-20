# dsh-modelscope-pts

[English](README.md) | [简体中文](README.zh-CN.md)

一个 DeepSeek Harness（DSH）Desktop 插件，在两处实时显示你的 **ModelScope 账号剩余魔粒（积分）余额**：

- **模型选择器**——每个 ModelScope 模型行旁的魔粒 chip（`魔粒 N`），余额不足时附带**低余额警告牌**；
- **插件页**——完整余额面板与凭据管理，位于 **插件 → 已安装 → dsh-modelscope-pts → 配置**。

## 工作原理

插件读取 ModelScope 余额接口：

```
GET https://www.modelscope.cn/openapi/v1/magicubes/balance
```

并展示 `data.available_balance`（可用）与 `frozen_amount`（冻结）：插件页面板显示两项，模型选择器 chip 只显示可用余额。（`total_balance` 会拉取但不展示。）

### 低余额警告

当可用余额降至 **25 魔粒及以下**（阈值常量 `LOW_BALANCE_THRESHOLD`，见 `lib/client.js`）时，模型选择器的魔粒 chip 右侧出现一枚红色三角感叹号警告牌，悬浮文案末尾追加「，余额不足」。警告牌只在 chip 本身渲染时出现（ModelScope provider 的模型行、下拉选项位、展示开关开启），且必须有有效余额读数——没有读数时不会误报。

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
| `lib/client.js` | 客户端半身：注册模型行徽章与插件配置卡片。 |
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
