# dsh-modelscope-pts

[English](README.md) | [简体中文](README.zh-CN.md)

A DeepSeek Harness (DSH) Desktop plugin that shows your **ModelScope account's remaining magicubes (points) balance** in two places, updated in real time:

- the **model selector** — a chip next to each ModelScope model row (`魔粒 N`), with a **low-balance warning** badge when the balance runs short, and
- the **plugin page** — a full balance panel plus credential management, under **Plugins → Installed → dsh-modelscope-pts → Configure**.

The bundle also ships a second, independently toggleable component, **ModelScope daily magicubes** — a scheduled daily like task that earns points. See [Components](#components).

## Components

The bundle ships **two components** (Plugins → Installed → dsh-modelscope-pts → *Included components*), each with its own on/off switch and its own card on the plugin page:

### ModelScope points (`modelscope-pts`)

The balance display described below: model-selector chip, low-balance warning, plugin-page panel and credential management. Credentials entered here are shared with the daily component.

### ModelScope daily magicubes (`modelscope-magicube`)

A scheduled daily like task that earns magicubes (2 points per like, 10 likes/day cap):

- Picks models you have **not starred yet** and never cancels an existing star, skipping your own models (by path owner and by creator), from the catalog (`/api/v1/dolphin/models`, up to 6 pages × 100 entries, shuffled before picking).
- Runs at a configurable time of day (`HH:MM`, default `09:30`); if DSH was not running at that time the task **catches up** on the next start. If the run fails (network not ready, expired cookie), it does not retry automatically for the rest of the day — recover with the card's **Run now** button.
- Waits a **random 1–10 seconds** between consecutive likes.
- Requires a **session cookie** — the same one configured on the points component. Likes cannot be done with an access token alone.
- When a daily run starts, the component automatically opens a ModelScope page in your **default browser** to claim the login reward (**at most once per day**). The URL defaults to the My Overview page `https://www.modelscope.cn/my/overview`; a custom URL can be configured on the card, and the behavior can be turned off there. Open failures are only logged and **never block liking**.
- Ships a built-in **model availability probe**: on a configurable interval (default 14 days) it checks whether the ModelScope models you added are still servable; the card offers a **Probe now** button, groups results by the model's task category, and shows a **red warning** when any model has been removed. The probe is read-only — it **never modifies** your model configuration.
- Shows per-day results (liked / failed / skipped) on the component card; the run record lives in volatile config fields and survives restarts.

This component is the **plugin implementation** of the standalone Python project `modelscope-magicube` (same daily-like workflow); the plugin version runs inside DSH Desktop with **no Python required**.

## How it works

The plugin reads the ModelScope balance endpoint:

```
GET https://www.modelscope.cn/openapi/v1/magicubes/balance
```

and displays `data.available_balance` (available) and `frozen_amount` (frozen): the plugin-page panel shows both, while the model-selector chip shows the available balance only. (`total_balance` is fetched but not displayed.)

### Low-balance warning

When the available balance drops to **25 magicubes or below** (`LOW_BALANCE_THRESHOLD` in `lib/client.js`), a small red warning triangle appears right of the chip in the model selector, and the hover title gains a `，余额不足` ("insufficient balance") suffix. The badge only renders while the chip itself renders (ModelScope provider rows, option placement, switch on) and a valid balance reading exists — with no data there is no false warning.

### Daily login reward (automatic browser open)

On the first daily-interaction run of a day (scheduled or via **Run now**), the plugin tries to open a ModelScope page in your default browser to claim the login reward:

- URL: `https://www.modelscope.cn/my/overview` (the My Overview page) by default — the profile page became inaccessible on 2026-11-26 and is deprecated; a custom URL configured on the component card (must start with `http(s)://`) takes precedence.
- "At most once per day" counts **attempts**: a failed open is still recorded for the day (volatile `lastBrowserOpenDate`), and a manual re-run the same day will not open again.
- Platform implementation: `cmd /c start` on Windows, `open` on macOS, `xdg-open` on Linux (spawned detached, never blocking the plugin); failures are only logged.

### Model availability probe

On the `probeIntervalDays` interval (default 14 days, minimum 1) the plugin probes whether the ModelScope models you added on the profile user patch layer (the `llm-pi-ai` row) are still servable:

1. It reads the profile patch file (`DSH_PROFILE_DIR` first, falling back to `%APPDATA%\dsh-desktop\harness\profiles\desktop\cordis.patch.yml`) and extracts `config.providers.modelscope.models[].id`; when unreadable the status shows "未找到已添加的 ModelScope 模型" (no added ModelScope models found) without raising an error.
2. `GET https://api-inference.modelscope.cn/v1/models` provides the set of servable ids (anonymous; if the credential store resolves a `MODELSCOPE_API_KEY` it is sent as a Bearer header — the value never reaches logs/RPC/UI).
3. Two-tier verdict: not in the servable list → confirm via `GET /api/v1/models/{ns}/{name}` — 404 + `Code: 10010205001` means "已下架" (removed); 200 means "推理不可用" (exists but not servable, possibly gated); in the list means "可用" (available).
4. Results are grouped by the detail's `Data.Tasks[0].ChineseName` (falling back to `Name`); when any model is removed the summary line gains a red warning "⚠ N 个已添加模型已下架：…".

Probing never blocks liking (both share the 60-second scheduler tick under two independent mutexes); a probe failure only affects the probe status. The feature is **read-only** — it only reports, never touches your model configuration.

### Credentials

ModelScope authenticates with a session cookie, which a host-side plugin cannot read from your browser. This plugin therefore supports two credential sources, entered on the plugin Configure page:

1. **Access token** (`ms-…`) — sent as `Authorization: Bearer <token>`.
2. **Session cookie** — the full `Cookie` header string copied from your logged-in browser request headers.

Policy: **token first, cookie fallback**. If a token is configured it is used first; if the request is rejected with an authentication error (HTTP 401/403) and a cookie is also configured, the plugin retries with the cookie. If only a cookie is configured it is used directly. Credentials are stored in the host credential store (`ctx.credentials`) — never in the plugin config file, and never echoed back to the UI.

## Layout

| Path | Purpose |
| --- | --- |
| `package.json` | Plugin manifest (`dsh.bundle.patch`, `dsh.client`). |
| `cordis.patch.yml` | Bundle patch that registers the plugin. |
| `lib/index.js` | Host half: fetches the balance, manages credentials, exposes RPC. |
| `lib/rpc.js` | Shared RPC channel mechanism (envelope, trust check, body limits). |
| `lib/client.js` | Client half: registers the model-row badge and the two plugin configure cards. |
| `lib/magicube.js` | Host half of the daily-magicubes component: scheduler, like task, RPC. |
| `magicube/` | Daily-magicubes component resources: locale (`meta.title`/`meta.description`) and icon. |
| `locale/` | Display metadata (title/description) in English and Chinese. |
| `icon.svg` | Plugin icon. |

## Installation

Install through the Harness **Plugin Manager** — either from the DSH plugin marketplace entry for this repository, or as a local bundle tarball (`install_bundle`). The plugin targets DSH Desktop **0.14.0** and the `web` client platform.

### No manual YAML editing required

The plugin registers itself through the bundle patch that ships **inside the package** ([`cordis.patch.yml`](cordis.patch.yml), declared via `dsh.bundle.patch` in `package.json`). Once the Plugin Manager adds this package to the profile's bundle list, the Harness loader overlays that patch layer automatically at start-up. You do **not** need to edit any of these by hand:

- the profile-level `cordis.patch.yml` (user layer),
- `pnpm-workspace.yaml`,
- the profile `package.json` (including any overrides lines).

### Prerequisites

- A restart may be required around installation: if the profile has a pending, not-yet-applied generation update, Plugin Manager refuses to apply a new bundle until DSH Desktop has been restarted once. (General Plugin Manager behavior, not specific to this plugin.)
- The model-selector chip only appears next to models from the **ModelScope** provider (`provider.id === "modelscope"`). If your profile has no ModelScope provider configured, the plugin still works — the balance panel lives on its Configure page — there simply are no ModelScope model rows to decorate.

### First run

1. Install the plugin, then restart DSH Desktop (or open a new session).
2. Open **Plugins → Installed → dsh-modelscope-pts → Configure**.
3. Enter a credential — an access token (`ms-…`, created under ModelScope → My Profile → Settings → Access Token) or a session cookie (copy the `Cookie:` header from a logged-in `www.modelscope.cn` request). The plugin uses token first and falls back to the cookie on an authentication error; see [Credentials](#credentials).
4. Save. The balance panel and the model-selector chip refresh automatically (default interval 60 s, configurable).

## License

MIT — see [LICENSE](LICENSE).
