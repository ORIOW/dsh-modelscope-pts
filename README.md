# dsh-modelscope-pts

A DeepSeek Harness (DSH) Desktop plugin that shows your **ModelScope account's remaining magicubes (points) balance** in two places, updated in real time:

- the **model selector** — a chip next to each model row (`魔粒 N`), and
- the **plugin page** — a full balance panel plus credential management, under **Plugins → Installed → dsh-modelscope-pts → Configure**.

## How it works

The plugin reads the ModelScope balance endpoint:

```
GET https://www.modelscope.cn/openapi/v1/magicubes/balance
```

and displays `data.available_balance` (available), `total_balance` (total) and `frozen_amount` (frozen).

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

Install through the Harness **Plugin Manager** (bundle install). The plugin targets DSH Desktop **0.14.0** and the `web` client platform.

After installing, open the plugin's Configure page, enter a token or cookie, and save. The balance refreshes automatically (default interval 60 s, configurable).

## License

MIT — see [LICENSE](LICENSE).
