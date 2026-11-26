/**
 * dsh-modelscope-pts — client half.
 *
 * 手写 __ModuleLoader__ 信封，无构建步骤：写出来就能被 dsh-client-modules 直接加载。
 * 信封形状照抄 dsh-amd-model-load（其源自 dsh-pause / dsh-zcode-connect）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 *
 * 三个挂载点：前两个共用一份数据（任务单 2026-11-18-002 定的两个展示位），
 * 第三个是 0.2.0 新增的每日魔粒互动组件卡（独立数据源）：
 *   1. **插件行配置页**（slot `plugins.row.config`，key = `dsh-modelscope-pts#modelscope-pts`）——
 *      宿主「插件 → 已安装 → dsh-modelscope-pts」行详情页的配置区。提供凭据表单
 *     （访问令牌 + 会话 Cookie，密钥输入框、保存后即清空、永不回显原文）、凭据
 *      状态（只显示已配置/未配置）与实时余额面板（可用/冻结 + 更新时间）。
 *   2. **模型选择列表行徽章**（slot `conversation.input.model.label`，priority -1）——
 *      在模型选择菜单每一行的模型名右边追加一枚魔粒徽章（「魔粒 265」）。
 *   3. **每日魔粒互动组件卡**（slot `plugins.row.config`，key = `dsh-modelscope-pts#modelscope-magicube`，
 *      0.2.0 新增）——同一 keyed slot 的第二个 key：每日点赞任务的设置（每日时间/点赞数）
 *      与状态（今日完成/上次结果/运行中）。通道 `/dsh-modelscope-pts-magicube`，独立
 *      30s 轻量轮询 store，不与余额 store 共享。0.3.0 起本卡还承载：每日奖励页打开
 *      设置（勾选框 + 自定义地址，并入 saveSettings）与模型可用性探测（「立即探测」
 *      按钮 + 结果区 + 下架红色警示，探测经 probeNow 端点触发）。
 *
 * ## ⚠️ 模型行徽章最重要的一条（参考实现已验证的契约）
 *
 * 父级（`dsh-client-ui-model-selection`）这样调用：
 *   `renderSlot("conversation.input.model.label", {provider, model, placement, selected},
 *               { fallback: model.name })`
 *
 * 而 `fallback` 只在该 slot **一个贡献者都没有**时生效（宿主
 * `dsh-client-ui-renderer/lib/client.js` 的 single 分支：`if (!entry) return … fallback`）。
 * 我们注册之后 `entry` 恒存在，`fallback` 永不参与 —— 组件返回 `null` 会让那个
 * `<span data-model-id>` 变成空白（模型名消失）。
 *
 * 结论：**组件必须在所有分支都自己渲染 `model.name`**，包括
 * `placement !== "option"`（收起按钮 trigger / 菜单顶部 menu）与配置关闭时。
 * 绝不返回 null。
 *
 * ## ⚠️ priority = -1 不是调优项，缺了功能整体失效
 *
 * `conversation.input.model.label` 是 `kind:"single"` 的 slot，宿主内置插件
 * `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` 已以 priority 0 占用。
 * slots 核心对 single 的同 priority 重复注册**直接抛错**；取 -1 排在它前面成为
 * `entriesOfSlot()[0]`（第一个非 abdicated 条目生效），我们才是真正的渲染者。
 * 代价是内置的 1017 徽章没人画了 —— 由我们**逐字复刻**它的判定条件代为渲染，
 * 见 deepSeek1017Name()。
 *
 * ## 与参考实现的差异（均为任务单要求，已记入 docs/dev-notes-20261118-002.md）
 *
 *   - `fetchBalance` 每次走 host 的实时凭据策略（缓存新鲜时读缓存），因此
 *     client 的轮询只是「让数字保持新鲜」，不做任何上游请求；
 *   - client 的轮询间隔可被插件 Config 覆盖：store 启动时调一次 `getConfig`
 *     RPC（host 返回 refreshIntervalMs 与两个展示位开关），间隔变更会重启节拍；
 *   - 参考实现的第三个 slot（`plugins.bundle.config` 包详情页）仍然刻意不注册，
 *     凭据与余额集中在插件行配置页。0.2.0 起在 `plugins.row.config` 上注册**两个
 *     key**（余额卡 + 每日魔粒互动卡）：keyed slot 按 key 各自定位，互不影响。
 *
 * ## 显示纪律
 *
 *   1. **绝不在这里拉 ModelScope**。这里只调本地 RPC（打 host 内存缓存，毫秒级）。
 *   2. **数字旁必须带「更新于 HH:MM」**，否则用户会把上一轮的读数当实时值。
 *   3. **密钥绝不回显**。输入框 type=password、保存成功即清空、状态只显示
 *      已配置/未配置 —— client 侧根本拿不到值（RPC 只返回布尔）。
 *   4. 徽章 chip 永远在场（无数据显示「魔粒 —」+ 悬浮原因）：
 *      chip 整个消失会像插件没装。
 */
window.__ModuleLoader__.load({
  id: "dsh-modelscope-pts",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    //#region constants
    /** 插件名；同时也是插件行配置 key 的 bundle 部分（见 PLUGIN_ROW_KEY）。 */
    const NS = "dsh-modelscope-pts";

    /** 模型选择行徽章在本 slot 内的贡献者 id。 */
    const MODEL_ROW_ID = "dsh-modelscope-pts.modelrow";

    /**
     * 注册优先级。**必须为 -1**：内置 1017 插件已以 priority 0 占用这个 single
     * slot，同 priority 再注册直接抛错；取 -1 才能排在它前面成为实际渲染者。
     * 详见文件头注释。
     */
    const MODEL_ROW_PRIORITY = -1;

    /**
     * 插件行配置 slot 与它的注册 key。
     *
     * 宿主契约（`dsh-client-ui-plugin-manager`，从 DSH Desktop 0.14.0 asar 原文核对，
     * 与参考实现同源）：`rowConfigKey(bundle, rowId) = `${bundle}#${rowId}``。
     * 只有 ledger 里存在这个 key，「插件 → 已安装 → dsh-modelscope-pts」行才会
     * 出现「配置」按钮；行详情页把该 slot 渲染两次（view:"summary" 填描述位、
     * view:"page" 填 `div[data-plugin-config]` 配置区）。slot 声明是 `kind:"keyed"`
     * ⇒ spec 用 `key` 定位，id/order/label 在这个 slot 上无意义。
     *
     * 两个组成值都来自仓库文件，不写字面量第二次：
     *   - bundle 部分 = package.json 的 `"name"`（即 NS 常量）
     *   - rowId 部分  = cordis.patch.yml 的 `- id: modelscope-pts`
     */
    const ROW_CONFIG_SLOT = "plugins.row.config";
    const PLUGIN_ROW_ROW_ID = "modelscope-pts";
    const PLUGIN_ROW_KEY = NS + "#" + PLUGIN_ROW_ROW_ID;

    /**
     * 第二张组件卡（0.2.0 新增）：每日魔粒互动。同一个 keyed slot 上的另一个 key，
     * rowId = cordis.patch.yml 第二条 insert 的 id（modelscope-magicube）。
     */
    const MAGICUBE_ROW_ID = "modelscope-magicube";
    const MAGICUBE_ROW_KEY = NS + "#" + MAGICUBE_ROW_ID;
    /** 每日魔粒互动的 RPC 通道，必须与 lib/magicube.js 的 CHANNEL 完全一致。 */
    const MAGICUBE_CHANNEL = "/dsh-modelscope-pts-magicube";
    /** 每日魔粒互动卡的轮询间隔（毫秒）：独立轻量 store，30s 一次状态读取。 */
    const MAGICUBE_POLL_MS = 30_000;
    /** 与 lib/magicube.js 相同的 HH:MM 校验（保存前先在 client 侧拦一道）。 */
    const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

    /** 模型选择行徽章的 slot 名（apply 的注入清单与日志共用这一个常量）。 */
    const MODEL_LABEL_SLOT = "conversation.input.model.label";

    /** RPC 通道前缀，必须与 host 的 CHANNEL 完全一致。 */
    const CHANNEL = "/dsh-modelscope-pts";

    /** 本地 RPC 轮询间隔的默认值（毫秒）。host 的 getConfig 可覆盖（下限 10000）。 */
    const CLIENT_POLL_MS = 60_000;
    const MIN_POLL_MS = 10_000;

    /** 只有展开菜单里的**可选项**（placement === "option"）才显示徽章。 */
    const PLACEMENT_OPTION = "option";

    /**
     * 只有 ModelScope provider 的模型才显示魔粒徽章。`provider.id` 就是 provider 的 key，
     * profile 的 cordis.patch.yml 里 `providers.modelscope` 的那个就是 "modelscope"。
     * 其他 provider（deepseek 等）零侵入 —— 只渲染模型名，不碰任何魔粒数据。
     */
    const MODELSCOPE_PROVIDER_ID = "modelscope";

    /**
     * 魔粒余额不足警告阈值（单位：魔粒）。已取到有效余额读数且
     * `available <= 该值` 时，模型选择器魔粒 chip 右侧追加一枚红色三角
     * 感叹号警告牌（含义在 chip 的悬浮 title 里表达，本体不加文字标签）。
     */
    const LOW_BALANCE_THRESHOLD = 25;

    /**
     * 行内 chip 的容器样式。一枚 18px 高的胶囊：背景与描边走宿主主题 token
     * （fallback 供脱离宿主的预览渲染用）；描边用 inset box-shadow 而不是
     * border —— border 会把盒高撑到 20px，模型行行高抖动。inline-flex、不换行、
     * 不设固定宽度（宽度由内容决定）。
     */
    const CHIP_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      height: "18px",
      padding: "0 6px",
      borderRadius: "999px",
      lineHeight: "18px",
      verticalAlign: "middle",
      whiteSpace: "nowrap",
      marginLeft: "6px",
      background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))",
      boxShadow: "inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127,127,127,0.22))",
    };

    /** chip 内文本：11px / 600 / tabular-nums，随主题文字色。 */
    const CHIP_TEXT_STYLE = {
      fontSize: "11px",
      fontWeight: 600,
      fontVariantNumeric: "tabular-nums",
      letterSpacing: "0",
      color: "var(--sys-color-on-surface, light-dark(#1f2328, #ffffff))",
    };

    /** 余额点的两种实色：正常=魔粒金，陈旧=灰。无数据用虚线环（见 dotStyleFor）。 */
    const PTS_DOT_COLOR = "#d97706";
    const PTS_DOT_STALE_COLOR = "#9ca3af";

    /** 通用小字样式（配置页说明与状态行）。 */
    const SMALL_TEXT_STYLE = { fontSize: "11px", lineHeight: 1.6, opacity: 0.75 };

    /** 凭据输入框样式：主题 token 底色 + inset 描边（同 chip 的做法）。 */
    const INPUT_STYLE = {
      width: "100%",
      boxSizing: "border-box",
      fontSize: "12px",
      lineHeight: "18px",
      padding: "5px 8px",
      borderRadius: "6px",
      background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))",
      boxShadow: "inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127,127,127,0.22))",
      border: "none",
      outline: "none",
      color: "var(--sys-color-on-surface, light-dark(#1f2328, #ffffff))",
    };

    /** 保存按钮样式：复刻 Tag tone="info" 的主题配色（与宿主按钮观感一致）。 */
    const BUTTON_STYLE = {
      alignSelf: "flex-start",
      fontSize: "12px",
      lineHeight: "20px",
      padding: "3px 12px",
      borderRadius: "6px",
      border: "none",
      cursor: "pointer",
      background: "color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)",
      color: "var(--dsw-alias-state-business-primary)",
    };

    /** 保存按钮禁用态。 */
    const BUTTON_DISABLED_STYLE = { ...BUTTON_STYLE, opacity: 0.5, cursor: "default" };

    /** 「陈旧」小标签（沿用参考实现的琥珀色徽标）。 */
    const STALE_TAG_STYLE = {
      fontSize: "10px",
      padding: "1px 5px",
      borderRadius: "3px",
      background: "rgba(234,179,8,0.18)",
      color: "#b45309",
    };
    //#endregion

    //#region helpers
    /**
     * 把时间戳格式化成 HH:MM（24 小时制，本地时区）。无时间戳返回 null。
     *
     * @param {number|null} ts - 毫秒时间戳。
     * @returns {string|null}
     */
    function formatTime(ts) {
      if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
      const date = new Date(ts);
      const hh = String(date.getHours()).padStart(2, "0");
      const mm = String(date.getMinutes()).padStart(2, "0");
      return hh + ":" + mm;
    }

    /**
     * 复刻内置 1017 插件的渲染结果：命中时返回「模型名 + 1017 徽章」，
     * 否则只返回模型名（与内置插件 `return model.name` 一致）。
     *
     * 为什么需要它：我们以 priority:-1 抢占了 `conversation.input.model.label`，
     * 内置的 `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`（priority 0）
     * 从此不再渲染 —— 它的 1017 徽章由我们代画，判定条件与文案**逐字照抄**
     * 内置插件（三个条件是 AND，`model.name` 必须精确等于 `DeepSeek-V4.1-Flash`）：
     *   1. `provider.id` ∈ {deepseek-account, deepseek-official}
     *   2. `model.id === "deepseek-flash"`
     *   3. `model.name === "DeepSeek-V4.1-Flash"`
     * 文案固定 "1017"，不查 locale 字典 —— 内置插件的中英文字典值都是 "1017"。
     *
     * @param provider - 父级传入的 provider（可能畸形）。
     * @param model - 父级传入的 model（可能畸形）。
     * @param modelName - 已算好的展示名（name 缺失时回退 id）。
     * @returns {object} React 元素：纯文本，或「名字 + 徽章」的 span。
     */
    function deepSeek1017Name(provider, model, modelName) {
      const providerId = provider !== null && typeof provider === "object" ? provider.id : undefined;
      const isOfficial =
        typeof providerId === "string" && DEEPSEEK_1017_PROVIDERS.indexOf(providerId) !== -1;
      const isTargetModel =
        model !== null &&
        typeof model === "object" &&
        model.id === DEEPSEEK_1017_MODEL_ID &&
        model.name === DEEPSEEK_1017_MODEL_NAME;

      if (!isOfficial || !isTargetModel) return modelName;

      return React.createElement(
        "span",
        { style: DEEPSEEK_1017_LABEL_STYLE },
        React.createElement("span", null, modelName),
        " ",
        React.createElement("span", { style: DEEPSEEK_1017_BADGE_STYLE }, DEEPSEEK_1017_LABEL),
      );
    }

    /** 内置 1017 徽章的判定条件与样式 —— 逐字照抄内置插件，不要改动语义。 */
    const DEEPSEEK_1017_PROVIDERS = ["deepseek-account", "deepseek-official"];
    const DEEPSEEK_1017_MODEL_ID = "deepseek-flash";
    const DEEPSEEK_1017_MODEL_NAME = "DeepSeek-V4.1-Flash";
    const DEEPSEEK_1017_LABEL = "1017";
    const DEEPSEEK_1017_BADGE_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      borderRadius: "999px",
      padding: "1px 8px",
      fontSize: "11px",
      lineHeight: "17px",
      fontWeight: 500,
      whiteSpace: "nowrap",
      background: "color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)",
      color: "var(--dsw-alias-state-business-primary)",
    };
    const DEEPSEEK_1017_LABEL_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      verticalAlign: "baseline",
      whiteSpace: "nowrap",
    };
    //#endregion

    //#region 共享快照订阅器
    /**
     * 创建一个**共享的**余额快照订阅器（形状照抄参考实现，两处扩展）：
     *
     * 不变量（与 dsh-amd-model-load 的 store 一致）：
     *   - **全插件只有一个 interval**：第一个订阅者到来时启动，最后一个退订时停掉。
     *   - **并发拉取只发一次请求**：pull() 共用同一个 in-flight promise。
     *   - **失败保留旧数据**：只更新 error，data 保持上一次成功值。
     *   - **订阅即刻拿到当前快照**：新订阅者不用等下一个 tick。
     *   - 快照是**同一个对象引用**发给所有 listener ⇒ 配置页与徽章的
     *     「更新于」必然一致。
     *
     * 扩展一：**配置随快照分发**。启动时调一次 `getConfig`，把 host Config 里的
     *   refreshIntervalMs（覆盖轮询间隔，下限 10000）与两个展示位开关并入快照；
     *   间隔变化会重启节拍。配置端点缺席时保持默认值，不致命。
     * 扩展二：**凭据状态随快照分发**。每次拉取顺带读一次 `getCredentialStatus`
     *   （host 侧只回布尔），saveCredentials 成功后立即更新并触发一次重拉。
     *
     * @param {object|undefined} rpc - connection.rpc；connection 缺席时为 undefined。
     * @returns {{subscribe: Function, getSnapshot: Function, pull: Function,
     *            saveCredentials: Function, stop: Function, listenerCount: Function}}
     */
    function createSnapshotStore(rpc) {
      /** @type {Set<Function>} */
      const listeners = new Set();
      /**
       * 当前快照。`loaded` 区分「还没拉到」与「拉到了但无余额」；
       * `cred` 只含布尔（client 永远拿不到凭据原文）；`config` 为 null 表示
       * 配置尚未到达（此时按默认值渲染）。
       */
      let state = { data: null, error: null, loaded: false, cred: { hasToken: false, hasCookie: false }, config: null };
      let timer = null;
      let inFlight = null;
      let pollMs = CLIENT_POLL_MS;

      /** 把当前快照发给所有 listener。单个 listener 抛错不能影响其他 listener。 */
      function notify() {
        for (const listener of Array.from(listeners)) {
          try {
            listener(state);
          } catch {
            /* listener 自身的错误与数据分发无关，忽略。 */
          }
        }
      }

      /** 读一次插件配置；间隔变化时重启节拍。失败保持默认，不打扰余额。 */
      async function loadConfig() {
        if (rpc === undefined || rpc === null) return;
        try {
          const result = await Promise.resolve(rpc.call(CHANNEL, "getConfig", {}));
          if (
            result === null ||
            typeof result !== "object" ||
            result.ok !== true ||
            result.value === null ||
            typeof result.value !== "object"
          ) {
            return;
          }
          const raw = result.value;
          const requested = typeof raw.pollMs === "number" && Number.isFinite(raw.pollMs) ? raw.pollMs : CLIENT_POLL_MS;
          const next = Math.max(MIN_POLL_MS, requested);
          state = {
            ...state,
            config: {
              pollMs: next,
              showInModelSelector: raw.showInModelSelector !== false,
              showInPluginRow: raw.showInPluginRow !== false,
            },
          };
          if (next !== pollMs) {
            pollMs = next;
            if (timer !== null) {
              clearInterval(timer);
              timer = setInterval(() => {
                void pull();
              }, pollMs);
              if (typeof timer?.unref === "function") timer.unref();
            }
          }
          notify();
        } catch {
          /* 配置端点缺席不致命。 */
        }
      }

      /** 拉一次余额（顺带刷凭据状态）。失败只写 error，不动 data。 */
      function pull() {
        if (rpc === undefined || rpc === null) return Promise.resolve(state);
        if (inFlight !== null) return inFlight;
        inFlight = Promise.resolve(rpc.call(CHANNEL, "fetchBalance", {}))
          .then(async (result) => {
            if (
              result !== null &&
              typeof result === "object" &&
              result.ok === true &&
              result.value !== null &&
              typeof result.value === "object"
            ) {
              const value = result.value;
              if (value.ok === true) {
                // ok=true 时 error 仍可能非空（旧数据 + 最近一次刷新失败）——原样透传，
                // 让 UI 同时显示数字与失败原因。
                const message = typeof value.error === "string" && value.error !== "" ? value.error : null;
                state = { data: value, error: message, loaded: true, cred: state.cred, config: state.config };
              } else {
                // 业务失败（未配置凭据 / 鉴权失效 / 网关拒绝）：保留旧数据，只更新错误。
                const message = typeof value.error === "string" && value.error !== "" ? value.error : "读取失败";
                state = { data: state.data, error: message, loaded: state.loaded, cred: state.cred, config: state.config };
              }
            } else {
              const message =
                result !== null && typeof result === "object" && result.error && typeof result.error.message === "string"
                  ? result.error.message
                  : "读取失败";
              state = { data: state.data, error: message, loaded: state.loaded, cred: state.cred, config: state.config };
            }
            // 凭据状态顺带刷新（host 读 records，毫秒级）；失败不影响余额。
            try {
              const statusResult = await Promise.resolve(rpc.call(CHANNEL, "getCredentialStatus", {}));
              if (
                statusResult !== null &&
                typeof statusResult === "object" &&
                statusResult.ok === true &&
                statusResult.value !== null &&
                typeof statusResult.value === "object"
              ) {
                const value = statusResult.value;
                state = { ...state, cred: { hasToken: value.hasToken === true, hasCookie: value.hasCookie === true } };
              }
            } catch {
              /* 保旧。 */
            }
            notify();
            return state;
          })
          .catch((cause) => {
            state = {
              data: state.data,
              error: cause instanceof Error ? cause.message : String(cause),
              loaded: state.loaded,
              cred: state.cred,
              config: state.config,
            };
            notify();
            return state;
          })
          .finally(() => {
            inFlight = null;
          });
        return inFlight;
      }

      /** 启动节拍：立即拉一次，然后每 pollMs 一次；同时装载一次配置。幂等。 */
      function start() {
        if (timer !== null) return;
        void pull();
        void loadConfig();
        timer = setInterval(() => {
          void pull();
        }, pollMs);
        if (typeof timer?.unref === "function") timer.unref();
      }

      /** 停表。最后一个订阅者退订时调用。 */
      function stop() {
        if (timer === null) return;
        clearInterval(timer);
        timer = null;
      }

      /**
       * 订阅。返回退订函数。
       * 订阅即启动节拍（若尚未启动），并**立刻**把当前快照推给新订阅者。
       */
      function subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        listeners.add(listener);
        start();
        try {
          listener(state);
        } catch {
          /* 同上，忽略。 */
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) stop();
        };
      }

      /**
       * 保存/清除凭据的公共发送通道（凭据原文只在本调用里单向流向 host，绝不进快照）。
       * 成功后用返回的布尔状态更新快照，并立刻重拉一次余额（新凭据生效）。
       *
       * @param {object} payload - host saveCredentials 的载荷：{token, cookie} 或 {clearToken, clearCookie}。
       * @param {string} failLabel - 失败时的默认文案前缀。
       * @returns {Promise<{ok: boolean, hasToken?: boolean, hasCookie?: boolean, error?: string}>}
       */
      function sendCredentials(payload, failLabel) {
        if (rpc === undefined || rpc === null) return Promise.resolve({ ok: false, error: "RPC 通道不可用" });
        return Promise.resolve(rpc.call(CHANNEL, "saveCredentials", payload))
          .then((result) => {
            if (
              result !== null &&
              typeof result === "object" &&
              result.ok === true &&
              result.value !== null &&
              typeof result.value === "object"
            ) {
              const value = result.value;
              state = { ...state, cred: { hasToken: value.hasToken === true, hasCookie: value.hasCookie === true } };
              notify();
              void pull();
              return { ok: true, hasToken: value.hasToken === true, hasCookie: value.hasCookie === true };
            }
            const message =
              result !== null && typeof result === "object" && result.error && typeof result.error.message === "string"
                ? result.error.message
                : failLabel;
            return { ok: false, error: message };
          })
          .catch((cause) => ({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
      }

      /**
       * 保存凭据：空串 = 该项不修改（host 侧语义），非空去空白后存储。
       *
       * @param {string} token - 访问令牌原文（可为空串 = 不更新令牌）。
       * @param {string} cookie - 会话 Cookie 原文（可为空串 = 不更新 Cookie）。
       */
      function saveCredentials(token, cookie) {
        return sendCredentials({ token, cookie }, "保存失败");
      }

      /** 清除已保存的凭据（两项都清；对未配置的项是安全 no-op）。 */
      function clearCredentials() {
        return sendCredentials({ clearToken: true, clearCookie: true }, "清除失败");
      }

      return {
        subscribe,
        getSnapshot: () => state,
        pull,
        saveCredentials,
        clearCredentials,
        stop,
        listenerCount: () => listeners.size,
      };
    }

    /**
     * store 缺席时的空快照。**必须是模块级常量**：每次渲染新建对象会让 useState
     * 的初值不断变化，虽然不影响正确性，但会白白多一次比较。
     */
    const EMPTY_SNAPSHOT = { data: null, error: null, loaded: false, cred: { hasToken: false, hasCookie: false }, config: null };

    /**
     * 把 store 接到组件 state 上的 hook。
     *
     * `useState(store.getSnapshot())` 只取首帧值，之后全靠 subscribe 推；
     * 订阅时 store 会立刻推一次当前快照，所以「挂载即有数据」不用额外分支。
     *
     * ⚠️ `store` 可以为 null —— 这不是防御式编程，而是为了满足 Hooks 规则：
     * 调用方必须在**每个分支都调用本 hook**，否则同一组件实例在 placement
     * 变化（option ↔ trigger）时 hook 数量会变，React 会抛
     * 「Rendered more hooks than during the previous render」。
     *
     * @param store - 快照订阅器，可为 null。
     * @param emptySnapshot - store 缺席时返回的空快照（调用方按自己的快照形状传入：
     *   余额侧传 EMPTY_SNAPSHOT，magicube 卡传 EMPTY_MAGICUBE_SNAPSHOT）。
     */
    function useSnapshot(store, emptySnapshot) {
      const usable = store !== undefined && store !== null;
      const [snapshot, setSnapshot] = React.useState(usable ? store.getSnapshot() : emptySnapshot);
      React.useEffect(() => {
        if (!usable) return undefined;
        return store.subscribe(setSnapshot);
      }, [store, usable]);
      return usable ? snapshot : emptySnapshot;
    }
    //#endregion

    //#region 每日魔粒互动：独立轻量轮询 store（0.2.0 新增）
    /**
     * 创建每日魔粒互动的状态 store（形状比余额 store 轻）：
     *   - 单 interval（30s）+ listener 集合 + in-flight 去重 + 失败保留旧状态；
     *   - 只读一个端点 getStatus（通道 /dsh-modelscope-pts-magicube），没有配置
     *     下发 —— magicube 没有可调轮询参数，30s 是固定值；
     *   - runNow/saveSettings 走这里发出，完成后立刻 pull 一次让 running/
     *     todayDone/lastRun 尽快更新。
     *
     * @param {object|undefined} rpc - connection.rpc；connection 缺席时为 undefined。
     * @returns {{subscribe: Function, getSnapshot: Function, pull: Function,
     *            runNow: Function, saveSettings: Function, stop: Function,
     *            listenerCount: Function}}
     */
    function createMagicubeStore(rpc) {
      /** @type {Set<Function>} */
      const listeners = new Set();
      /** status 为 null 表示还没拉到状态；error 是最近一次读取失败的文案。 */
      let state = { loaded: false, error: null, status: null };
      let timer = null;
      let inFlight = null;

      /** 把当前快照发给所有 listener。单个 listener 抛错不影响其他 listener。 */
      function notify() {
        for (const listener of Array.from(listeners)) {
          try {
            listener(state);
          } catch {
            /* listener 自身的错误与数据分发无关，忽略。 */
          }
        }
      }

      /** 把一次 RPC 结果并入快照。 */
      function applyResult(result) {
        if (
          result !== null &&
          typeof result === "object" &&
          result.ok === true &&
          result.value !== null &&
          typeof result.value === "object"
        ) {
          state = { loaded: true, error: null, status: result.value };
        } else {
          const message =
            result !== null && typeof result === "object" && result.error && typeof result.error.message === "string"
              ? result.error.message
              : "状态读取失败";
          state = { ...state, error: message };
        }
      }

      /** 读一次状态。失败只写 error，status 保持上一次的值。 */
      function pull() {
        if (rpc === undefined || rpc === null) return Promise.resolve(state);
        if (inFlight !== null) return inFlight;
        inFlight = Promise.resolve(rpc.call(MAGICUBE_CHANNEL, "getStatus", {}))
          .then((result) => {
            applyResult(result);
            notify();
            return state;
          })
          .catch((cause) => {
            state = { ...state, error: cause instanceof Error ? cause.message : String(cause) };
            notify();
            return state;
          })
          .finally(() => {
            inFlight = null;
          });
        return inFlight;
      }

      /** 启动节拍：立即拉一次，然后每 30s 一次。幂等。 */
      function start() {
        if (timer !== null) return;
        void pull();
        timer = setInterval(() => {
          void pull();
        }, MAGICUBE_POLL_MS);
        if (typeof timer?.unref === "function") timer.unref();
      }

      /** 停表。最后一个订阅者退订时调用。 */
      function stop() {
        if (timer === null) return;
        clearInterval(timer);
        timer = null;
      }

      /** 订阅。返回退订函数；订阅即启动节拍并立刻推一次当前快照。 */
      function subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        listeners.add(listener);
        start();
        try {
          listener(state);
        } catch {
          /* 同上，忽略。 */
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) stop();
        };
      }

      /**
       * 手动触发一次任务。host 侧互斥：已有任务在运行时返回 ok:false。
       * 发出后立刻 pull，让 running 标志尽快点亮。
       */
      async function runNow() {
        if (rpc === undefined || rpc === null) return { ok: false, error: "RPC 通道不可用" };
        try {
          const result = await Promise.resolve(rpc.call(MAGICUBE_CHANNEL, "runNow", {}));
          void pull();
          if (result !== null && typeof result === "object" && result.ok === true) return { ok: true };
          return {
            ok: false,
            error:
              result !== null && typeof result === "object" && result.error && typeof result.error.message === "string"
                ? result.error.message
                : "启动失败",
          };
        } catch (cause) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        }
      }

      /**
       * 手动触发一次模型可用性探测。host 侧互斥：已有探测在运行时返回 ok:false。
       * 发出后立刻 pull，让 probing 标志尽快点亮。
       */
      async function probeNow() {
        if (rpc === undefined || rpc === null) return { ok: false, error: "RPC 通道不可用" };
        try {
          const result = await Promise.resolve(rpc.call(MAGICUBE_CHANNEL, "probeNow", {}));
          void pull();
          if (result !== null && typeof result === "object" && result.ok === true) return { ok: true };
          return {
            ok: false,
            error:
              result !== null && typeof result === "object" && result.error && typeof result.error.message === "string"
                ? result.error.message
                : "启动失败",
          };
        } catch (cause) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        }
      }

      /** 保存设置（host 侧校验；0.3.0 起包含浏览器打开开关/地址与探测间隔）。 */
      async function saveSettings(dailyTime, likeCount, openBrowser, openUrl, probeIntervalDays) {
        if (rpc === undefined || rpc === null) return { ok: false, error: "RPC 通道不可用" };
        try {
          const result = await Promise.resolve(
            rpc.call(MAGICUBE_CHANNEL, "saveSettings", { dailyTime, likeCount, openBrowser, openUrl, probeIntervalDays }),
          );
          if (result !== null && typeof result === "object" && result.ok === true) return { ok: true };
          return {
            ok: false,
            error:
              result !== null && typeof result === "object" && result.error && typeof result.error.message === "string"
                ? result.error.message
                : "保存失败",
          };
        } catch (cause) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        }
      }

      return {
        subscribe,
        getSnapshot: () => state,
        pull,
        runNow,
        probeNow,
        saveSettings,
        stop,
        listenerCount: () => listeners.size,
      };
    }
    //#endregion

    //#region 魔粒徽章视图（纯派生 + 缓存）
    /** badgeView 缓存。键 = 快照对象引用 + 快照级错误（store 只在成功拉取时整体替换 data）。 */
    let BADGE_VIEW_CACHE = { data: undefined, error: undefined, view: null };

    /**
     * 把「余额快照」压成徽章所需的派生值。
     *
     *   - text   「魔粒 265」；无读数时是「魔粒 —」（与 0 是不同的串：0 是读数、— 是没有读数）
     *   - title  悬浮文案（「ModelScope 魔粒：可用 265，更新于 17:20」或错误原因）
     *   - stale  数据已旧于两个刷新周期（点变灰）
     *   - has    是否有可用读数（驱动点的样式）
     *   - low    读数有效且可用余额 ≤ LOW_BALANCE_THRESHOLD（驱动警告牌与 title 追加）
     *
     * @param data - snapshot.data（可能为 null）。
     * @param snapshotError - 快照级错误（data 为 null 时它是唯一的原因来源，如「未配置凭据」）。
     * @returns {{text: string, title: string, stale: boolean, has: boolean, low: boolean}}
     */
    function ptsBadgeView(data, snapshotError) {
      if (BADGE_VIEW_CACHE.data === data && BADGE_VIEW_CACHE.error === snapshotError) return BADGE_VIEW_CACHE.view;
      const has =
        data !== null &&
        typeof data === "object" &&
        data.ok === true &&
        typeof data.available === "number" &&
        Number.isFinite(data.available);
      const text = has ? "魔粒 " + String(data.available) : "魔粒 —";
      const lastError =
        data !== null && typeof data === "object" && typeof data.error === "string" && data.error !== ""
          ? data.error
          : typeof snapshotError === "string"
            ? snapshotError
            : "";
      const low = has === true && data.available <= LOW_BALANCE_THRESHOLD;
      let title;
      if (has) {
        const disabledPart = data.disabled === true ? "（魔粒功能已被禁用）" : "";
        const updatedAt = formatTime(typeof data.ts === "number" ? data.ts : null);
        const timePart = updatedAt === null ? "" : "，更新于 " + updatedAt;
        const errorPart = lastError !== "" ? "，最近刷新失败：" + lastError : "";
        title = "ModelScope 魔粒：可用 " + data.available + disabledPart + timePart + errorPart + (low ? "，余额不足" : "");
      } else if (lastError !== "") {
        title = "ModelScope 魔粒：" + lastError;
      } else {
        title = "ModelScope 魔粒：暂无数据";
      }
      const stale = (has === true && data.stale === true) || lastError !== "";
      const view = { text, title, stale, has, low };
      BADGE_VIEW_CACHE = { data, error: snapshotError, view };
      return view;
    }

    /**
     * 低余额警告牌：一枚红色三角内嵌感叹号的 inline SVG，渲染在魔粒 chip 右侧。
     *
     * - 颜色：优先宿主主题 danger token（`--dsw-alias-state-danger`），找不到回退固定红。
     * - 尺寸：13px 高，与 chip 的行内元素对齐，不破行高；不加任何文字标签。
     * - 可访问性：`aria-hidden="true"`（含义已在 chip 的 title 悬浮文案里表达）。
     */
    function ptsLowBalanceWarnIcon(title) {
      const red = "var(--dsw-alias-state-danger, #e5484d)";
      return React.createElement(
        "span",
        {
          "aria-hidden": "true",
          title: title,
          style: { flex: "none", display: "inline-flex", alignItems: "center", height: "13px", marginLeft: "4px" },
        },
        React.createElement(
          "svg",
          { width: "14", height: "13", viewBox: "0 0 24 22", style: { display: "block" } },
          // 圆角三角形：stroke 同色 + round join 造圆角。
          React.createElement("path", {
            d: "M12 2.5 L21.5 19.5 L2.5 19.5 Z",
            fill: red,
            stroke: red,
            strokeWidth: "3",
            strokeLinejoin: "round",
          }),
          React.createElement("rect", { x: "10.9", y: "8", width: "2.2", height: "7", rx: "1.1", fill: "#ffffff" }),
          React.createElement("circle", { cx: "12", cy: "17", r: "1.3", fill: "#ffffff" }),
        ),
      );
    }

    /** 魔粒点的内联样式：有数据=实心圆（正常金/陈旧灰），无数据=虚线环。 */
    function ptsDotStyle(view) {
      const base = { flex: "none", width: "6px", height: "6px" };
      if (!view.has) {
        return {
          ...base,
          borderRadius: "50%",
          background: "transparent",
          border: "1px dashed " + PTS_DOT_STALE_COLOR,
          boxSizing: "border-box",
        };
      }
      return { ...base, borderRadius: "50%", background: view.stale ? PTS_DOT_STALE_COLOR : PTS_DOT_COLOR };
    }
    //#endregion

    //#region 插件行配置页组件
    /** 凭据状态行：「访问令牌：已配置 · 会话 Cookie：未配置」。 */
    function CredentialStatusLine(props) {
      const cred = props.cred !== null && typeof props.cred === "object" ? props.cred : { hasToken: false, hasCookie: false };
      return React.createElement(
        "div",
        { style: SMALL_TEXT_STYLE },
        "访问令牌：" +
          (cred.hasToken === true ? "已配置" : "未配置") +
          " · 会话 Cookie：" +
          (cred.hasCookie === true ? "已配置" : "未配置"),
      );
    }

    /** 一个带标签的密钥输入行。type=password，保存成功后由父级清空，永不回显。 */
    function SecretField(props) {
      return React.createElement(
        "label",
        { style: { display: "flex", flexDirection: "column", gap: "3px" } },
        React.createElement("span", { style: { fontSize: "11px", opacity: 0.85 } }, props.label),
        React.createElement("input", {
          type: "password",
          value: props.value,
          placeholder: props.placeholder,
          autoComplete: "new-password",
          spellCheck: false,
          style: INPUT_STYLE,
          onChange: (event) => props.onChange(event.target.value),
        }),
      );
    }

    /**
     * 插件行配置页：凭据表单 + 实时余额面板。
     *
     * 宿主的行详情页会把本组件渲染**两次**（与参考实现同源）：
     *   - view:"summary" —— 行描述位。**只给单行摘要**，渲染整卡会把描述区撑大；
     *     showInPluginRow=false 时摘要只说明展示位已关闭（凭据状态仍可见于 page 视图）。
     *   - view:"page"（或缺省）—— `div[data-plugin-config]` 配置区主体，渲染完整卡，
     *     但**不渲染页面级大标题**：行详情页自己已有「modelscope-pts」标题。
     *
     * ⚠️ Hooks 规则：所有 useState/useEffect 在任何分支之前无条件调用。
     */
    function PtsCard(props) {
      const store = props.store;
      // ⚠️ Hooks 规则：useSnapshot 必须无条件调用（store 可为 null/undefined，
      // 函数内部已处理；条件分支里调 hook 会因行详情页双渲染复用实例而崩溃）。
      const snapshot = useSnapshot(store ?? null, EMPTY_SNAPSHOT);

      const data = snapshot.data;
      const error = snapshot.error;
      const config = snapshot.config;
      const balanceHidden = config !== null && config.showInPluginRow === false;
      const updatedAt = formatTime(data !== null && typeof data === "object" ? data.ts : null);
      const stale = data !== null && typeof data === "object" && data.stale === true;
      const hasBalance = data !== null && typeof data === "object" && data.ok === true;

      // —— 凭据表单 state（无条件声明） ——
      const [tokenValue, setTokenValue] = React.useState("");
      const [cookieValue, setCookieValue] = React.useState("");
      const [saveState, setSaveState] = React.useState({ kind: "idle", message: "" });
      const saving = saveState.kind === "saving";

      async function handleSave() {
        if (saveState.kind === "saving") return;
        const token = tokenValue.trim();
        const cookie = cookieValue.trim();
        if (token === "" && cookie === "") {
          setSaveState({ kind: "error", message: "请至少填写访问令牌或会话 Cookie 中的一项" });
          return;
        }
        setSaveState({ kind: "saving", message: "" });
        try {
          const result = await store.saveCredentials(token, cookie);
          if (result !== null && typeof result === "object" && result.ok === true) {
            // 成功反馈只含布尔状态；输入框立即清空，原文绝不回显。
            setSaveState({
              kind: "ok",
              message:
                "凭据已保存（访问令牌：" +
                (result.hasToken === true ? "已配置" : "未配置") +
                "，会话 Cookie：" +
                (result.hasCookie === true ? "已配置" : "未配置") +
                "）",
            });
            setTokenValue("");
            setCookieValue("");
          } else {
            const message = result !== null && typeof result === "object" && typeof result.error === "string" ? result.error : "保存失败";
            setSaveState({ kind: "error", message });
          }
        } catch (cause) {
          setSaveState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
        }
      }

      async function handleClear() {
        if (saveState.kind === "saving") return;
        setSaveState({ kind: "saving", message: "" });
        try {
          const result = await store.clearCredentials();
          if (result !== null && typeof result === "object" && result.ok === true) {
            setSaveState({ kind: "ok", message: "已清除全部已保存的凭据（访问令牌、会话 Cookie）" });
            setTokenValue("");
            setCookieValue("");
          } else {
            const message = result !== null && typeof result === "object" && typeof result.error === "string" ? result.error : "清除失败";
            setSaveState({ kind: "error", message });
          }
        } catch (cause) {
          setSaveState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
        }
      }

      // —— summary 视图：单行描述 ——
      if (props.view === "summary") {
        const line = balanceHidden
          ? "魔粒余额展示已关闭"
          : hasBalance
            ? "魔粒 " +
              String(data.available) +
              (stale ? "（陈旧）" : "") +
              (updatedAt === null ? "" : " · 更新于 " + updatedAt)
            : error !== null
              ? "魔粒读取失败：" + error
              : "魔粒暂无数据";
        return React.createElement(
          "p",
          { style: { margin: "0", fontSize: "11px", lineHeight: 1.6, opacity: 0.8 } },
          line,
        );
      }

      // —— page 视图：完整卡（无页面级大标题） ——
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        // 时间行 + 陈旧标记（余额面板被关闭时这行也省了，别让空时间行占位）
        balanceHidden
          ? null
          : React.createElement(
              "div",
              { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
              React.createElement(
                "span",
                { style: { fontSize: "11px", opacity: 0.55 } },
                updatedAt === null ? "尚未取到数据" : "更新于 " + updatedAt,
              ),
              stale ? React.createElement("span", { style: STALE_TAG_STYLE }, "陈旧") : null,
            ),
        // 余额面板
        balanceHidden
          ? React.createElement(
              "div",
              { style: { fontSize: "11px", opacity: 0.55 } },
              "魔粒余额展示已在插件配置中关闭（showInPluginRow）；凭据仍可在此管理。",
            )
          : React.createElement(
              "div",
              { style: { display: "flex", gap: "18px" } },
              [
                ["可用", hasBalance ? String(data.available) : "—"],
                ["冻结", hasBalance && typeof data.frozen === "number" ? String(data.frozen) : "—"],
              ].map(([label, value]) =>
                React.createElement(
                  "div",
                  { key: label, style: { display: "flex", flexDirection: "column", gap: "1px" } },
                  React.createElement("span", { style: { fontSize: "10px", opacity: 0.55 } }, label),
                  React.createElement(
                    "span",
                    { style: { fontSize: "18px", fontWeight: 700, fontVariantNumeric: "tabular-nums" } },
                    value,
                  ),
                ),
              ),
            ),
        hasBalance && data.disabled === true
          ? React.createElement(
              "div",
              { style: { fontSize: "11px", color: "#b45309", lineHeight: 1.5 } },
              "魔粒功能已被账号侧禁用（is_disabled），生成请求会被拒绝。",
            )
          : null,
        // 错误行：保留旧数据的同时告诉用户为什么数字没动
        error !== null && !balanceHidden
          ? React.createElement(
              "div",
              { style: { fontSize: "11px", color: "#b45309", lineHeight: 1.5 } },
              "余额读取失败：" + error,
            )
          : null,
        // 凭据区（唯一凭据入口，任何配置下都渲染）
        React.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "6px", borderTop: "1px solid rgba(127,127,127,0.18)", paddingTop: "8px" } },
          React.createElement(CredentialStatusLine, { cred: snapshot.cred }),
          React.createElement(SecretField, {
            label: "访问令牌（ms- 开头；留空 = 不修改）",
            placeholder: "ms-xxxxxxxx-xxxx-xxxx",
            value: tokenValue,
            onChange: setTokenValue,
          }),
          React.createElement(SecretField, {
            label: "会话 Cookie（整串；留空 = 不修改）",
            placeholder: "m_session_id=…; …（从已登录浏览器的请求头整串复制）",
            value: cookieValue,
            onChange: setCookieValue,
          }),
          React.createElement(
            "div",
            { style: { display: "flex", gap: "8px", alignItems: "center" } },
            React.createElement(
              "button",
              { type: "button", style: saving ? BUTTON_DISABLED_STYLE : BUTTON_STYLE, onClick: handleSave },
              saving ? "保存中…" : "保存凭据",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                style: { ...BUTTON_STYLE, background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))", color: "var(--sys-color-on-surface, light-dark(#1f2328, #ffffff))" },
                onClick: handleClear,
              },
              "清除已存凭据",
            ),
          ),
          saveState.kind === "error"
            ? React.createElement(
                "div",
                { style: { fontSize: "11px", color: "#b45309", lineHeight: 1.5 } },
                saveState.message,
              )
            : null,
          saveState.kind === "ok"
            ? React.createElement("div", { style: { fontSize: "11px", color: "#15803d", lineHeight: 1.5 } }, saveState.message)
            : null,
          React.createElement(
            "div",
            { style: { fontSize: "10px", opacity: 0.55, lineHeight: 1.6 } },
            "凭据保存在宿主凭据存储中，不写入配置文件，也不会回显。" +
              "请求策略：令牌优先，鉴权失败自动回退 Cookie。「清除已存凭据」会同时移除令牌与 Cookie。" +
              "若凭据均失效，请重新获取后在此更新。",
          ),
        ),
      );
    }
    //#endregion

    //#region 模型选择行徽章
    /**
     * 模型选择列表行徽章：在模型名右边追加一枚魔粒徽章（「魔粒 265」）。
     *
     * ## 为什么这个组件**任何分支都不返回 null**
     *
     * 父级用 `renderSlot(..., { fallback: model.name })` 把模型名的渲染责任交给我们。
     * 而 `fallback` 只在「该 slot 一个贡献者都没有」时生效（见文件头注释）。
     * 我们注册之后 fallback 永不参与 —— 返回 null 会让那一行模型名消失。
     *
     * 所以本组件的**每个分支都渲染 `model.name`**（可能带代画的 1017 徽章），
     * 魔粒 chip 只是「额外」追加：
     *   - `placement !== "option"`（trigger / menu）→ 只渲染名字
     *   - 配置 showInModelSelector=false            → 只渲染名字
     *   - `provider.id !== "modelscope"`（非 ModelScope provider）→ 只渲染名字（零侵入）
     *   - 无余额读数                                 → 名字 + chip（虚线环点 + 魔粒 —）
     *   - 有余额                                     → 名字 + chip（实心点 + 魔粒 N）
     *   - 有余额且 ≤ LOW_BALANCE_THRESHOLD           → 再追加右侧红色三角警告牌
     *
     * ## 样式约束（行内元素）
     *
     * 父级把它塞进 `<span data-model-id>` 里，作为 model.name 的兄弟节点：
     * inline-flex、marginLeft 6px、nowrap、不设固定宽度、tabular-nums、
     * chip 高度固定 18px（inset box-shadow 描边，盒高不变，行高不抖）。
     */
    function ModelRowBadge(props) {
      // ⚠️ 渲染期只读：本函数体内不改任何模块级状态。观测写入都在 useEffect。
      const model = props.model !== null && typeof props.model === "object" ? props.model : {};
      const modelName = typeof model.name === "string" && model.name !== "" ? model.name : String(model.id ?? "");
      const provider = props.provider !== null && typeof props.provider === "object" ? props.provider : {};
      // 魔粒徽章只认 ModelScope provider：其他 provider（deepseek 等）零侵入，只渲染模型名。
      const isModelscope = provider.id === MODELSCOPE_PROVIDER_ID;
      // ⚠️ Hooks 规则：useSnapshot 必须在所有分支之前无条件调用（placement 在
      // option ↔ trigger 之间切换时 React 复用同一组件实例，hook 数量不能变）。
      const snapshot = useSnapshot(props.store, EMPTY_SNAPSHOT);

      // 代画内置 1017 徽章（我们以 priority:-1 抢占后，priority 0 的它不再渲染）。
      const with1017 = deepSeek1017Name(provider, model, modelName);

      const isOption = props.placement === PLACEMENT_OPTION;
      const config = snapshot.config;
      const chipEnabled = config === null || config.showInModelSelector !== false;
      // 分支 1：不显示魔粒徽章的场景 —— 但仍然渲染模型名（可能带 1017）。
      // 三个条件任一为假都只渲染名字：非 option、开关关闭、非 ModelScope provider。
      if (!isOption || !chipEnabled || !isModelscope) {
        return with1017;
      }

      // 分支 2/3：option + 展示开关打开 —— 渲染「名字（可能带 1017）+ 魔粒 chip」。
      // ⚠️ 第一个孩子必须传 with1017 而不是裸 modelName：deepseek-flash 的 option 行
      // 也会走到这里，传 modelName 会把代画的 1017 徽章丢掉（非 1017 行两者相同）。
      // 整段 try/catch：这里任何一处抛错都会被宿主的 SlotErrorBoundary 捕获并把
      // 本条目 abdicate（让位给内置 1017）—— 宁可降级为纯名字。
      try {
        const view = ptsBadgeView(snapshot.data, snapshot.error);
        return React.createElement(
          React.Fragment,
          null,
          with1017,
          React.createElement(
            "span",
            {
              // role="img" + aria-label：把「点 + 数字」读成一枚有语义的整体。
              role: "img",
              title: view.title,
              "aria-label": view.title,
              style: CHIP_STYLE,
            },
            React.createElement("span", { "aria-hidden": "true", style: ptsDotStyle(view) }),
            React.createElement("span", { style: CHIP_TEXT_STYLE }, view.text),
          ),
          view.low === true ? ptsLowBalanceWarnIcon(view.title) : null,
        );
      } catch (error) {
        // 降级：任何意外都只损失徽章，不损失模型名，更不损失整个条目。
        const message = error instanceof Error ? error.message : String(error);
        console.error(LOG_PREFIX + "模型行徽章渲染失败，降级为纯模型名：" + message, error);
        return with1017;
      }
    }
    //#endregion

    //#region 每日魔粒互动组件卡（0.2.0 新增）
    /** store 缺席时的空快照（形状与 createMagicubeStore 的 state 一致）。 */
    const EMPTY_MAGICUBE_SNAPSHOT = { loaded: false, error: null, status: null };

    /** 规则说明小字（与 host 侧行为一一对应）。 */
    const MAGICUBE_RULES_TEXT =
      "每日互动规则：每次点赞 2 魔粒、每日 10 次封顶；两次点赞之间随机等待 1~10 秒。" +
      "到设定时间后的每 60 秒检查一次，错过时间（如宿主未开机）会在插件启动后补跑。" +
      "点赞是 toggle 操作：插件只点未星标且非本人创建的模型，绝不取消已有的喜欢。" +
      "每日互动运行时会自动用默认浏览器打开 ModelScope 页面领登录奖励（每天最多一次）。" +
      "组件还会按可配置间隔（默认 14 天）自动探测已添加 ModelScope 模型的可用性，" +
      "有模型下架时给出红色警示（只提示，绝不修改你的模型配置）。" +
      "本组件是插件实现，无需安装独立的 Python 版 modelscope-magicube。";

    /**
     * 把上次运行摘要压成展示行与明细列表。run 缺席/畸形返回 null（调用方跳过该区块）。
     *
     * @param run - getStatus 返回的 lastRun（已由 host 解析成对象）。
     * @returns {{likedList: Array, failedList: Array, lines: string[]}|null}
     */
    function magicubeRunLines(run) {
      if (run === null || typeof run !== "object") return null;
      const likedList = Array.isArray(run.liked) ? run.liked : [];
      const failedList = Array.isArray(run.failed) ? run.failed : [];
      const finishedAt = formatTime(typeof run.finishedAt === "string" ? Date.parse(run.finishedAt) : null);
      const lines = [];
      lines.push(
        "上次运行 " +
          String(run.date ?? "?") +
          (finishedAt === null ? "" : " " + finishedAt) +
          "（" + (run.trigger === "manual" ? "手动" : "定时") + "）：" +
          (run.ok === true ? "按计划完成" : "未按计划完成"),
      );
      lines.push(
        "成功（今日累计）" + likedList.length + " · 本次新增 " + String(run.likedCount ?? 0) +
          " · 失败 " + String(run.failedCount ?? 0) + " · 跳过 " + String(run.skippedCount ?? 0),
      );
      if (run.interrupted === "cookie") {
        lines.push("任务曾因 Cookie 失效中断：请更新 Cookie 后点「立即运行」。");
      }
      if (typeof run.error === "string" && run.error !== "") {
        lines.push("上次错误：" + run.error);
      }
      return { likedList, failedList, lines };
    }

    /** 探测下架红色警示样式：优先宿主 danger token，回退固定红。 */
    const PROBE_WARN_STYLE = {
      fontSize: "11px",
      color: "var(--dsw-alias-state-danger, #dc2626)",
      lineHeight: 1.6,
      fontWeight: 600,
    };

    /**
     * 把探测摘要压成一行汇总文案（页视图结果区用）。lastProbe 已由 host 解析成对象。
     */
    function probeSummaryLine(lastProbe) {
      const trigger = lastProbe.trigger === "manual" ? "手动" : "定时";
      return (
        "上次探测 " +
        String(lastProbe.date ?? "?") +
        "（" +
        trigger +
        "）：共 " +
        String(lastProbe.total ?? 0) +
        " · 可用 " +
        String(lastProbe.availableCount ?? 0) +
        " · 推理不可用 " +
        String(lastProbe.unavailableCount ?? 0) +
        " · 已下架 " +
        String(lastProbe.removedCount ?? 0) +
        (typeof lastProbe.errorCount === "number" && lastProbe.errorCount > 0
          ? " · 确认失败 " + String(lastProbe.errorCount)
          : "")
      );
    }

    /**
     * 每日魔粒互动组件卡（keyed slot 的第二个 key）。
     *
     * 与余额卡（PtsCard）的分工：
     *   - 数据通道不同：/dsh-modelscope-pts-magicube（getStatus/runNow/saveSettings）；
     *   - 轮询独立且更慢（30s）：这里没有实时数字，只有「计划/完成/上次结果」；
     *   - 点赞凭据就是余额卡里配的那份会话 Cookie —— 本卡只读布尔并引导用户去
     *     余额卡配置，绝不在这里再放一个凭据输入框（密钥只有一个入口）。
     *
     * ⚠️ Hooks 规则：所有 useState/useEffect 在分支之前无条件调用；
     * ⚠️ 任何分支都不返回 null（keyed slot 条目不能渲染成空白）。
     */
    function MagicubeCard(props) {
      const store = props.store;
      // ⚠️ Hooks 规则：useSnapshot 无条件调用（store 可为 null/undefined，
      // 函数内部已处理；条件分支里调 hook 会因行详情页双渲染复用实例而崩溃）。
      const snapshot = useSnapshot(store ?? null, EMPTY_MAGICUBE_SNAPSHOT);
      const status = snapshot.status;

      // —— 设置/运行表单 state（无条件声明，Hooks 规则） ——
      const [dailyDraft, setDailyDraft] = React.useState("");
      const [countDraft, setCountDraft] = React.useState("");
      // 勾选框/地址框：undefined = 用户还没碰过（跟随 status 的当前值）。
      const [browserDraft, setBrowserDraft] = React.useState(undefined);
      const [urlDraft, setUrlDraft] = React.useState(undefined);
      const [draftsSeeded, setDraftsSeeded] = React.useState(false);
      const [saveState, setSaveState] = React.useState({ kind: "idle", message: "" });
      const [runState, setRunState] = React.useState({ kind: "idle", message: "" });
      const [probeState, setProbeState] = React.useState({ kind: "idle", message: "" });

      // 探测状态派生（0.3.0）：probe 缺席一律视为「无探测数据」，绝不抛错。
      const probe = status !== null && status.probe !== null && typeof status.probe === "object" ? status.probe : null;
      const lastProbe = probe !== null && probe.lastProbe !== null && typeof probe.lastProbe === "object" ? probe.lastProbe : null;
      const isProbing = probe !== null && probe.probing === true;
      const missingCount = lastProbe !== null && typeof lastProbe.removedCount === "number" ? lastProbe.removedCount : 0;
      const missingModels =
        lastProbe !== null && Array.isArray(lastProbe.missingModels)
          ? lastProbe.missingModels.filter((id) => typeof id === "string")
          : [];
      const browserChecked = browserDraft === undefined ? status !== null && status.openBrowser !== false : browserDraft === true;
      const urlValue = urlDraft === undefined ? (status !== null && typeof status.openUrl === "string" ? status.openUrl : "") : urlDraft;

      // 状态首次到达时播种表单初值（此后不再覆盖用户输入）。
      React.useEffect(() => {
        if (draftsSeeded || status === null) return;
        setDraftsSeeded(true);
        setDailyDraft(typeof status.dailyTime === "string" ? status.dailyTime : "");
        setCountDraft(status.likeCount === undefined || status.likeCount === null ? "" : String(status.likeCount));
      }, [status, draftsSeeded]);

      async function handleSaveSettings() {
        if (saveState.kind === "saving") return;
        const time = dailyDraft.trim();
        const count = Number(countDraft.trim());
        const url = urlValue.trim();
        if (!DAILY_TIME_PATTERN.test(time)) {
          setSaveState({ kind: "error", message: "每日运行时间格式应为 HH:MM（24 小时制两位数，如 09:30）" });
          return;
        }
        if (!Number.isInteger(count) || count < 1 || count > 10) {
          setSaveState({ kind: "error", message: "每次点赞数量必须是 1~10 的整数" });
          return;
        }
        if (browserChecked && url !== "" && !/^https?:\/\//i.test(url)) {
          setSaveState({ kind: "error", message: "自定义打开地址必须以 http:// 或 https:// 开头（留空使用「我的概览」页）" });
          return;
        }
        setSaveState({ kind: "saving", message: "" });
        try {
          // 探测间隔原样回传 host 当前生效值（本卡不提供间隔输入，避免把用户配置冲回默认）。
          const result = await store.saveSettings(time, count, browserChecked, url, probe !== null ? probe.intervalDays : undefined);
          if (result !== null && typeof result === "object" && result.ok === true) {
            setSaveState({ kind: "ok", message: "已保存；普通字段在插件重启后生效（宿主会自动重启）" });
          } else {
            const message =
              result !== null && typeof result === "object" && typeof result.error === "string"
                ? result.error
                : "保存失败";
            setSaveState({ kind: "error", message });
          }
        } catch (cause) {
          setSaveState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
        }
      }

      async function handleRunNow() {
        if (runState.kind === "starting") return;
        setRunState({ kind: "starting", message: "" });
        try {
          const result = await store.runNow();
          if (result !== null && typeof result === "object" && result.ok === true) {
            setRunState({ kind: "ok", message: "已启动；完成后状态自动刷新（轮询 30 秒）" });
          } else {
            const message =
              result !== null && typeof result === "object" && typeof result.error === "string"
                ? result.error
                : "启动失败";
            setRunState({ kind: "error", message });
          }
        } catch (cause) {
          setRunState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
        }
      }

      async function handleProbeNow() {
        if (probeState.kind === "starting") return;
        setProbeState({ kind: "starting", message: "" });
        try {
          const result = await store.probeNow();
          if (result !== null && typeof result === "object" && result.ok === true) {
            setProbeState({ kind: "ok", message: "探测已启动；完成后状态自动刷新（轮询 30 秒）" });
          } else {
            const message =
              result !== null && typeof result === "object" && typeof result.error === "string" ? result.error : "启动失败";
            setProbeState({ kind: "error", message });
          }
        } catch (cause) {
          setProbeState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
        }
      }

      // —— summary 视图：单行摘要 ——
      if (props.view === "summary") {
        let line;
        if (status === null) {
          line = snapshot.error !== null ? "每日互动状态读取失败：" + snapshot.error : "每日互动：正在读取状态…";
        } else if (status.hasCookie !== true) {
          line = "每日互动未就绪：缺少会话 Cookie（点赞必须使用 Cookie，请在「ModelScope 魔粒余额」组件页配置）";
        } else if (status.running === true) {
          line = "每日互动：任务运行中…";
        } else if (status.todayDone === true) {
          const likedCount =
            status.lastRun !== null && typeof status.lastRun === "object" && Array.isArray(status.lastRun.liked)
              ? status.lastRun.liked.length
              : 0;
          line = "每日互动：今日已完成（成功 " + likedCount + "）";
        } else {
          line =
            "每日互动：今日未运行，计划时间 " +
              String(typeof status.dailyTime === "string" ? status.dailyTime : "09:30") +
              "（到点自动运行）";
        }
        // missingCount > 0：摘要行直接带红色下架警示（0.3.0 规格：summary 行加红警示）。
        const summaryChildren =
          missingCount > 0
            ? [
                line,
                " ",
                React.createElement(
                  "span",
                  { style: PROBE_WARN_STYLE },
                  "⚠ " + String(missingCount) + " 个已添加模型已下架：" + missingModels.join("、"),
                ),
              ]
            : line;
        return React.createElement("p", { style: { margin: "0", fontSize: "11px", lineHeight: 1.6, opacity: 0.8 } }, summaryChildren);
      }

      // —— page 视图：完整卡（无页面级大标题） ——
      const hasCookie = status !== null && status.hasCookie === true;
      const hasToken = status !== null && status.hasToken === true;
      const isRunning = status !== null && status.running === true;
      const run = status !== null && status.lastRun !== null && typeof status.lastRun === "object" ? status.lastRun : null;
      const runView = magicubeRunLines(run);
      const saving = saveState.kind === "saving";
      const starting = runState.kind === "starting";
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        // 凭据状态行（布尔；凭据本体只在余额卡的表单里）
        React.createElement(
          "div",
          { style: SMALL_TEXT_STYLE },
          "会话 Cookie：" + (hasCookie ? "已配置" : "未配置") +
            " · 访问令牌：" + (hasToken ? "已配置" : "未配置") +
            (hasToken && !hasCookie ? "（仅令牌无法点赞）" : ""),
        ),
        // 缺 Cookie 引导（点赞唯一前置条件）
        !hasCookie
          ? React.createElement(
              "div",
              { style: { fontSize: "11px", color: "#b45309", lineHeight: 1.6 } },
              "点赞需要完整会话 Cookie（必须含 httpOnly 的 m_session_id 与 csrf_token；仅访问令牌无法点赞）。" +
                "请打开组件「ModelScope 魔粒余额」的配置页，在「会话 Cookie」输入框粘贴从已登录 " +
                "www.modelscope.cn 请求头复制的整串 Cookie 并保存，然后回到本页点「立即运行」验证。",
            )
          : null,
        // 状态行
        status === null
          ? React.createElement(
              "div",
              { style: SMALL_TEXT_STYLE },
              snapshot.error !== null ? "状态读取失败：" + snapshot.error : "正在读取状态…",
            )
          : React.createElement(
              "div",
              { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
              React.createElement(
                "span",
                { style: { fontSize: "11px", opacity: 0.55 } },
                isRunning
                  ? "任务运行中…"
                  : status.todayDone === true
                    ? "今日已完成"
                    : "今日未运行，计划 " + String(typeof status.dailyTime === "string" ? status.dailyTime : "09:30"),
              ),
              status.todayDone === true && run !== null && run.ok === false
                ? React.createElement("span", { style: STALE_TAG_STYLE }, "上次未按计划完成")
                : null,
            ),
        // 设置表单 + 立即运行
        React.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "6px", borderTop: "1px solid rgba(127,127,127,0.18)", paddingTop: "8px" } },
          React.createElement(
            "label",
            { style: { display: "flex", flexDirection: "column", gap: "3px" } },
            React.createElement("span", { style: { fontSize: "11px", opacity: 0.85 } }, "每日运行时间（HH:MM，24 小时制）"),
            React.createElement("input", {
              type: "text",
              value: dailyDraft,
              placeholder: "09:30",
              spellCheck: false,
              style: INPUT_STYLE,
              onChange: (event) => setDailyDraft(event.target.value),
            }),
          ),
          React.createElement(
            "label",
            { style: { display: "flex", flexDirection: "column", gap: "3px" } },
            React.createElement("span", { style: { fontSize: "11px", opacity: 0.85 } }, "每次点赞数量（1~10，每日 10 次封顶）"),
            React.createElement("input", {
              type: "number",
              min: 1,
              max: 10,
              step: 1,
              value: countDraft,
              style: INPUT_STYLE,
              onChange: (event) => setCountDraft(event.target.value),
            }),
          ),
          React.createElement(
            "label",
            { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px" } },
            React.createElement("input", {
              type: "checkbox",
              checked: browserChecked,
              onChange: (event) => setBrowserDraft(event.target.checked === true),
            }),
            "每日互动运行时打开浏览器领登录奖励（每天最多一次）",
          ),
          browserChecked
            ? React.createElement(
                "label",
                { style: { display: "flex", flexDirection: "column", gap: "3px" } },
                React.createElement(
                  "span",
                  { style: { fontSize: "11px", opacity: 0.85 } },
                  "打开地址（可选，http(s):// 开头；留空 = 打开「我的概览」页）",
                ),
                React.createElement("input", {
                  type: "text",
                  value: urlValue,
                  placeholder: "https://www.modelscope.cn/my/overview",
                  spellCheck: false,
                  style: INPUT_STYLE,
                  onChange: (event) => setUrlDraft(event.target.value),
                }),
              )
            : null,
          React.createElement(
            "div",
            { style: { display: "flex", gap: "8px", alignItems: "center" } },
            React.createElement(
              "button",
              { type: "button", style: saving ? BUTTON_DISABLED_STYLE : BUTTON_STYLE, onClick: handleSaveSettings },
              saving ? "保存中…" : "保存设置",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                style:
                  isRunning || starting
                    ? BUTTON_DISABLED_STYLE
                    : { ...BUTTON_STYLE, background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))", color: "var(--sys-color-on-surface, light-dark(#1f2328, #ffffff))" },
                onClick: handleRunNow,
              },
              isRunning ? "运行中…" : "立即运行",
            ),
          ),
          saveState.kind === "error"
            ? React.createElement("div", { style: { fontSize: "11px", color: "#b45309", lineHeight: 1.5 } }, saveState.message)
            : null,
          saveState.kind === "ok"
            ? React.createElement("div", { style: { fontSize: "11px", color: "#15803d", lineHeight: 1.5 } }, saveState.message)
            : null,
          runState.kind === "error"
            ? React.createElement("div", { style: { fontSize: "11px", color: "#b45309", lineHeight: 1.5 } }, runState.message)
            : null,
          runState.kind === "ok"
            ? React.createElement("div", { style: { fontSize: "11px", color: "#15803d", lineHeight: 1.5 } }, runState.message)
            : null,
        ),
        // 上次结果明细
        runView !== null
          ? React.createElement(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "4px", borderTop: "1px solid rgba(127,127,127,0.18)", paddingTop: "8px" } },
              runView.lines.map((line, index) =>
                React.createElement("div", { key: "line" + index, style: { fontSize: "11px", lineHeight: 1.6, opacity: 0.85 } }, line),
              ),
              runView.likedList.length > 0
                ? React.createElement(
                    "div",
                    { style: { fontSize: "10px", opacity: 0.75, lineHeight: 1.7 } },
                    "成功明细：" +
                      runView.likedList
                        .map((item) => String(item.name ?? item.path ?? "?") + (typeof item.stars === "number" ? "（Stars " + item.stars + "）" : ""))
                        .join("；"),
                  )
                : null,
              runView.failedList.length > 0
                ? React.createElement(
                    "div",
                    { style: { fontSize: "10px", color: "#b45309", lineHeight: 1.7 } },
                    "失败明细：" +
                      runView.failedList
                        .map((item) => String(item.name ?? item.path ?? "?") + "（" + String(item.error ?? "未知错误") + "）")
                        .join("；"),
                  )
                : null,
            )
          : null,
        // 模型可用性探测（0.3.0）：状态行 + 红色下架警示 + 分组明细 + 立即探测按钮
        React.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "4px", borderTop: "1px solid rgba(127,127,127,0.18)", paddingTop: "8px" } },
          React.createElement("div", { style: { fontSize: "11px", fontWeight: 600, opacity: 0.85 } }, "模型可用性探测"),
          React.createElement(
            "div",
            { style: { fontSize: "11px", lineHeight: 1.6, opacity: 0.85 } },
            isProbing
              ? "探测运行中…"
              : lastProbe === null
                ? "尚未探测（每 " + String(probe !== null ? probe.intervalDays : 14) + " 天自动探测一次）"
                : probeSummaryLine(lastProbe),
          ),
          lastProbe !== null && typeof lastProbe.error === "string" && lastProbe.error !== ""
            ? React.createElement("div", { style: { fontSize: "11px", color: "#b45309", lineHeight: 1.5 } }, "探测失败：" + lastProbe.error)
            : null,
          lastProbe !== null && typeof lastProbe.note === "string" && lastProbe.note !== ""
            ? React.createElement("div", { style: { fontSize: "11px", opacity: 0.75, lineHeight: 1.6 } }, lastProbe.note)
            : null,
          missingCount > 0
            ? React.createElement(
                "div",
                { style: PROBE_WARN_STYLE },
                "⚠ " + String(missingCount) + " 个已添加模型已下架：" + missingModels.join("、"),
              )
            : null,
          ...(lastProbe !== null && Array.isArray(lastProbe.groups)
            ? lastProbe.groups.map((group, groupIndex) =>
                React.createElement(
                  "div",
                  { key: "probe-group-" + groupIndex, style: { fontSize: "10px", opacity: 0.75, lineHeight: 1.7 } },
                  String(group !== null && typeof group === "object" ? group.category : "其他") +
                    "：" +
                    (group !== null && typeof group === "object" && Array.isArray(group.models) ? group.models : [])
                      .map(
                        (item) =>
                          String(item !== null && typeof item === "object" ? item.id : "?") +
                          "（" +
                          String(item !== null && typeof item === "object" ? item.status : "?") +
                          "）",
                      )
                      .join("；"),
                ),
              )
            : []),
          React.createElement(
            "div",
            { style: { display: "flex", gap: "8px", alignItems: "center" } },
            React.createElement(
              "button",
              {
                type: "button",
                style:
                  isProbing || probeState.kind === "starting"
                    ? BUTTON_DISABLED_STYLE
                    : {
                        ...BUTTON_STYLE,
                        background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))",
                        color: "var(--sys-color-on-surface, light-dark(#1f2328, #ffffff))",
                      },
                onClick: handleProbeNow,
              },
              isProbing ? "探测中…" : "立即探测",
            ),
          ),
          probeState.kind === "error"
            ? React.createElement("div", { style: { fontSize: "11px", color: "#b45309", lineHeight: 1.5 } }, probeState.message)
            : null,
          probeState.kind === "ok"
            ? React.createElement("div", { style: { fontSize: "11px", color: "#15803d", lineHeight: 1.5 } }, probeState.message)
            : null,
        ),
        // 规则说明
        React.createElement("div", { style: { fontSize: "10px", opacity: 0.55, lineHeight: 1.6 } }, MAGICUBE_RULES_TEXT),
      );
    }
    //#endregion

    //#region 统一日志前缀
    /** 统一日志前缀：注册失败等异常都带此前缀打到浏览器 console，便于过滤。 */
    const LOG_PREFIX = "[modelscope-pts] ";

    /**
     * slots.register 的观测包装：前后打日志，失败改记 console.error（不再静默抛）。
     *
     * 为什么吞掉错误：register 抛错发生在 slots.inject 的声明回调里，向上抛会走
     * unhandled-rejection 路径 —— 只有 DevTools 能看到，且会把 slots.inject 的
     * 控制器 stop 掉。改成「记录 + 返回空 disposer」后：宿主机制保持健康、失败
     * 原因进 console.error。注册失败的最坏结果退化为「徽章不显示」。
     *
     * @param ctx - 客户端根上下文。
     * @param tag - slot 名，只用于日志。
     * @param spec - 传给 ctx.slots.register 的注册 spec。
     * @param component - 组件。
     * @returns register 的 disposer；失败时返回空函数。
     */
    function safeRegister(ctx, tag, spec, component) {
      console.log(
        LOG_PREFIX +
          "slots.register → " +
          tag +
          "（priority=" +
          (spec.priority ?? 0) +
          "，key=" +
          String(spec.key ?? "(无)") +
          "，id=" +
          String(spec.id ?? "(无)") +
          "）",
      );
      try {
        const dispose = ctx.slots.register(spec, component);
        console.log(LOG_PREFIX + "slots.register ← " + tag + " 成功，条目已进 ledger");
        return dispose;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(LOG_PREFIX + "slots.register ✗ " + tag + " 失败：" + message, error);
        return () => {};
      }
    }
    //#endregion

    //#region plugin body
    /** slots 注册两个挂载点；connection 提供 rpc 载体。 */
    const inject = ["slots", "connection"];

    /**
     * 装配 client 半身：建余额共享快照 store 与 magicube 独立 store，然后注册挂载点
     * （余额卡与模型行徽章共享前者；magicube 卡用后者）。
     *
     * 卡片用 `plugins.row.config`（keyed slot，key = NS + "#" + rowId）：只有注册了
     * 这个 key，插件行才会出现「配置」按钮，行详情页的 summary/page 两处才会渲染
     * 我们的卡。参考实现的 `plugins.bundle.config`（包详情页）刻意不注册 ——
     * 任务单只要求两个挂载点，且两处渲染同一张卡会让人以为有两个设置页。
     *
     * ⚠️ slots.inject 对未声明的 slot 是**静默等待**（不报错、不打日志）：宿主没有
     * `plugins.row.config`（DSH Desktop < 0.14.0）时，配置页会无声消失。所以 apply
     * 入口先打一行「将注册」日志 —— 真机上 grep 这一行就能区分「注册了但宿主没渲染」
     * 与「根本没注册」。
     *
     * 模型选择行用 `conversation.input.model.label`（父级声明为
     * `kind:"single", scope:"session", inline:true`）。同 priority 注册会抛错，
     * priority -1 让我们排在内置 1017 之前成为实际渲染者，同时代画它的徽章。
     *
     * 余额侧两个 slot 的 `inject` 返回**同一个 store 实例** —— 这是「配置页与列表
     * 徽章永远同一份数据、同一个时间戳」的实现要点；magicube 卡的 inject 返回
     * 独立 store（不同通道、不同节奏）。
     *
     * @param ctx 客户端根上下文。
     */
    function apply(ctx) {
      console.log(
        LOG_PREFIX +
          "apply: connection=" +
          (ctx.connection === undefined || ctx.connection === null ? "缺席" : "在位") +
          "，建共享快照 store",
      );
      console.log(
        LOG_PREFIX +
          "apply: 将注册 slots=[" +
          ROW_CONFIG_SLOT +
          "（key=" +
          PLUGIN_ROW_KEY +
          "）, " +
          ROW_CONFIG_SLOT +
          "（key=" +
          MAGICUBE_ROW_KEY +
          "）, " +
          MODEL_LABEL_SLOT +
          "（priority=" +
          MODEL_ROW_PRIORITY +
          "）]",
      );
      const connection = ctx.connection;
      const rpc = connection === undefined || connection === null ? undefined : connection.rpc;

      // 余额侧整个生命周期只有这一个共享 store（也只有一个 interval）。
      const store = createSnapshotStore(rpc);
      // 每日魔粒互动卡的数据源：独立通道 + 独立 30s 轮询，不与余额 store 共享。
      const magicubeStore = createMagicubeStore(rpc);

      // 插件行配置页（插件 → 已安装 → dsh-modelscope-pts → 配置）：keyed slot。
      ctx.slots.inject(ROW_CONFIG_SLOT, () => {
        const dispose = safeRegister(
          ctx,
          ROW_CONFIG_SLOT,
          {
            name: ROW_CONFIG_SLOT,
            // keyed slot：宿主用 rowConfigKey(包名, 行 id) 定位条目，id/order/label 无意义。
            key: PLUGIN_ROW_KEY,
            inject: () => ({ store }),
          },
          PtsCard,
        );
        return dispose;
      });

      // 每日魔粒互动卡（0.2.0 新增）：同一 keyed slot 的第二个 key，rowId 对应
      // cordis.patch.yml 第二条 insert。独立 store（30s 轮询），与余额卡互不影响。
      ctx.slots.inject(ROW_CONFIG_SLOT, () => {
        const dispose = safeRegister(
          ctx,
          ROW_CONFIG_SLOT + "（magicube）",
          {
            name: ROW_CONFIG_SLOT,
            key: MAGICUBE_ROW_KEY,
            inject: () => ({ store: magicubeStore }),
          },
          MagicubeCard,
        );
        return dispose;
      });

      // 模型选择行徽章：single slot，priority 必须 -1（见常量注释）。
      ctx.slots.inject(MODEL_LABEL_SLOT, () => {
        const dispose = safeRegister(
          ctx,
          MODEL_LABEL_SLOT,
          {
            name: MODEL_LABEL_SLOT,
            id: MODEL_ROW_ID,
            priority: MODEL_ROW_PRIORITY,
            inject: () => ({ store }),
          },
          ModelRowBadge,
        );
        return dispose;
      });
    }

    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    exports.name = NS;
    // 以下不属于宿主契约（宿主只读 apply / inject / name）—— 供后续测试直接驱动
    // 派生逻辑，而不是经组件间接断言。
    exports.ptsBadgeView = ptsBadgeView;
    exports.createSnapshotStore = createSnapshotStore;
    exports.createMagicubeStore = createMagicubeStore;
    return module.exports;
  },
});
