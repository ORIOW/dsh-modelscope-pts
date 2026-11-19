# dsh-modelscope-pts

A DeepSeek Harness (DSH) Desktop plugin that shows your **ModelScope account's remaining magicubes (points) balance** in two places, updated in real time:

- the **model selector** — a chip next to each model row (`魔粒 N`), and
- the **plugin page** — a full balance panel plus credential management, under **Plugins → Installed → dsh-modelscope-pts → Configure**.

## How it works

The plugin reads the ModelScope balance endpoint:

```
GET https://www.modelscope.cn/openapi/v1/magicubes/balance
```

and displays `data.available_balance` (available) and `frozen_amount` (frozen): the plugin-page panel shows both, while the model-selector chip shows the available balance only. (`total_balance` is fetched but not displayed.)

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
| `lib/client.js` | Client half: registers the model-row badge and the plugin configure card. |
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
