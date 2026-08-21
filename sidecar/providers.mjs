// LLM Provider 抽象。两种接入方式:
//   transport: "anthropic" —— provider 自带 Anthropic Messages 兼容端点(DeepSeek/Kimi/GLM/Qwen/MiniMax)。
//               直接给 Claude Code CLI 注入 ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL 即可。
//   transport: "openai"    —— provider 只有 OpenAI 兼容端点(Grok/OpenAI-Codex/Gemini)。
//               sidecar 起一个本地 Anthropic→OpenAI 转译代理(openai-proxy.mjs),
//               ANTHROPIC_BASE_URL 指向 http://127.0.0.1:<proxy>/<provider>,CLI 无感。
//
// 约定:非 claude 的模型 value 一律带 "<id>/" 前缀(如 "deepseek/deepseek-v4-pro"、"grok/grok-4")。
// 无前缀 / "default" = claude。一个字符串就能判出 provider + 真实模型 id。
//
// 注意:下面各家的 baseUrl / 模型 id 会随版本、区域、套餐漂移 —— 这里只给"出厂默认",
// 用户可在设置里覆盖(settings.providerConfig[id] = { baseUrl, apiKey 另存 providerKeys, models }),
// 所以默认值不必追最新,能连上即可。ponytail: 默认值会过时,升级路径 = 设置里改,不改代码。
//
// baseUrlCN: 该家在国内另有一套域名(国际站在国内要么慢要么连不上)。设置里勾「使用国内节点」后生效,
//            仍低于用户手填的 baseUrl 覆盖。没有 CN 域名的(DeepSeek/Kimi 本身就在国内)不写。
// vision:    该端点收不收 image 块。false 的会在输入框直接拦下图片并说明。
//            按各家「编程端点」的常见配置给保守默认;单个模型可在设置的模型表里加 "vision": true 覆盖。
//            这道前端拦截是**唯一**防线,别当成锦上添花:实测 DeepSeek 的 anthropic 兼容层收到不支持图片的
//            模型 + image 块时,不回 400,而是**静默丢掉图片照常作答**(deepseek-v4-flash 只多算 5 个壳子
//            token,答案是编的)。放行等于让用户拿到一本正经的错答案,连个报错都没有。
//            反过来,vision 模型认 Anthropic 原生块 {type:"image",source:{type:"base64",…}},
//            不用转 image_url —— vision-exp 同一句话带图多算 117 token 且答对了颜色(2026-08 实测)。
// subscriptionUsage: 这家是订阅制(有 5h/周额度窗口)还是按 token 计费。用量条据此二选一:
//            订阅制显示两个额度窗口,按量计费显示本会话累计花费/token(见 spend.mjs)。
// price:     每 100 万 token 的单价 { in, out, cacheRead, cacheWrite, currency }。in = 缓存未命中价,
//            cacheWrite 不填则按 in 算。只写有官方价格页可查的出厂价,查不到就不写 ——
//            没价只显示 token 数,绝不按猜的价格显示金额。用户可在设置的模型表里覆盖。
//            分时定价的家再挂一个 price.offPeak = { in, out, cacheRead, peakHours: [[9,12],[14,18]] }:
//            落在 peakHours 里按外层价,其余时段按 offPeak(见 spend.mjs 的 effPrice)。
//            **peakHours 一律按北京时间(UTC+8)判**,不看用户本机时区 —— 官方是拿北京时间划的窗口,
//            按本机时区算等于给时差用户报错价(纽约的用户会在 21:00-24:00 被当成高峰)。
// DeepSeek 的高峰时段(北京时间),三个模型共用。半开区间 [起, 止)。
const DS_PEAK = [[9, 12], [14, 18]];

export const PROVIDERS = {
  claude: {
    id: "claude", label: "Claude", subscriptionUsage: true,
    transport: null, models: null, // 动态从 SDK supportedModels 取
  },

  // ---- Anthropic 原生兼容(直连)----
  deepseek: {
    id: "deepseek", label: "DeepSeek", transport: "anthropic", subscriptionUsage: false, vision: false,
    baseUrl: "https://api.deepseek.com/anthropic",
    smallFast: "deepseek-v4-flash",
    // 有账户余额接口(Bearer = 同一把 key)。path 从 baseUrl 剥掉 /anthropic 后拼,各家形状不一样,
    // 所以取值交给 pick。官方只给余额不给消费明细 —— 今日/本月由本地账本算(spend.mjs 的 ledger)。
    balanceApi: { path: "/user/balance", pick: (j) => ({ balance: Number(j?.balance_infos?.[0]?.total_balance), currency: j?.balance_infos?.[0]?.currency }) },
    // 出厂价来自官方价格页 api-docs.deepseek.com/zh-cn/quick_start/pricing/(2026-08-22 重抄)。
    // 2026-08-17 起峰谷两套价:外层是高峰价,offPeak 是空闲价(五折)。原句「高峰时段为北京时间
    // 9:00 - 12:00、14:00 - 18:00(其余为空闲时段)」—— 一天里只有 7 小时是高峰,别只记高峰价,
    // 那会把大多数时段的花费翻倍报。三个模型共用同一个高峰窗口。
    models: [
      { value: "deepseek/deepseek-v4-flash", model: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", description: "deepseek-v4-flash · 快", provider: "deepseek", contextWindow: 1_000_000, price: { in: 3, out: 9, cacheRead: 0.1, currency: "¥", offPeak: { in: 1.5, out: 4.5, cacheRead: 0.05, peakHours: DS_PEAK } } },
      { value: "deepseek/deepseek-v4-pro",   model: "deepseek-v4-pro",   displayName: "DeepSeek V4 Pro",   description: "deepseek-v4-pro · 最强", provider: "deepseek", contextWindow: 1_000_000, price: { in: 9, out: 27, cacheRead: 0.3, currency: "¥", offPeak: { in: 4.5, out: 13.5, cacheRead: 0.15, peakHours: DS_PEAK } } },
      // 唯一收图片的 DeepSeek 模型,价格与 flash 同档。vision 必须写在模型这级 —— provider 那级是 false,
      // 不写就会被输入框拦掉图片(见顶部 vision 说明)。图片按尺寸折算成 token,和文本一起计费。
      { value: "deepseek/deepseek-v4-flash-vision-exp", model: "deepseek-v4-flash-vision-exp", displayName: "DeepSeek V4 Flash Vision", description: "deepseek-v4-flash-vision-exp · 看图", provider: "deepseek", contextWindow: 1_000_000, vision: true, price: { in: 3, out: 9, cacheRead: 0.1, currency: "¥", offPeak: { in: 1.5, out: 4.5, cacheRead: 0.05, peakHours: DS_PEAK } } },
    ],
  },
  kimi: {
    id: "kimi", label: "Kimi", transport: "anthropic", vision: false,
    // Kimi 有两套互不相通的账号体系,端点完全不同,同一把 key 只在其中一边有效(实测:打错那边一律 401)。
    // 用户不用自己说填的是哪种 —— 存 key 时逐个变体探一遍(见 server.mjs 的 probeEndpoint),
    // 探中哪个就按哪个的计费形态渲染用量条:订阅显示额度窗口,平台显示余额 + 本地账本。
    variants: [
      {
        // ① kimi.com/code 编程订阅。key 从 kimi.com/code/console 拿。有 5h/周额度窗口。
        baseUrl: "https://api.kimi.com/coding", subscriptionUsage: true, kimiUsageApi: true,
        smallFast: "kimi-for-coding-highspeed",
        // 订阅制按额度不按 token,不写 price —— 写了用量条会显示一个用户根本不会被扣的金额。
        models: [
          { value: "kimi/k3",                        model: "k3",                        displayName: "Kimi K3",             description: "k3 · 最强", provider: "kimi", contextWindow: 1_000_000 },
          { value: "kimi/kimi-for-coding",           model: "kimi-for-coding",           displayName: "Kimi K2.7",           description: "kimi-for-coding · 稳", provider: "kimi", contextWindow: 256_000 },
          { value: "kimi/kimi-for-coding-highspeed", model: "kimi-for-coding-highspeed", displayName: "Kimi K2.7 Highspeed", description: "kimi-for-coding-highspeed · 快", provider: "kimi", contextWindow: 256_000 },
        ],
      },
      // ② Kimi 开放平台(原 Moonshot),按 token 计费,有账户余额接口。国内 / 国际两个域名同属这一体系,
      //    key 只在其中一边有效,所以是两个独立候选。出厂价抄自 platform.kimi.com/docs/pricing/(2026-08)。
      ...["https://api.moonshot.cn/anthropic", "https://api.moonshot.ai/anthropic"].map((baseUrl, i) => ({
        baseUrl, cn: i === 0, subscriptionUsage: false,
        // 余额接口在根域,不在 /anthropic 下 —— refreshBalances 会先剥掉 /anthropic 再拼 path。
        // 实测 GET https://api.moonshot.cn/v1/users/me/balance → { data: { available_balance, voucher_balance, cash_balance } },单位元。
        balanceApi: { path: "/v1/users/me/balance", pick: (j) => ({ balance: Number(j?.data?.available_balance), currency: "CNY" }) },
        smallFast: "kimi-k2.6",
        models: [
          { value: "kimi/kimi-k3",                 model: "kimi-k3",                 displayName: "Kimi K3",             description: "kimi-k3 · 最强", provider: "kimi", contextWindow: 1_048_576, price: { in: 20, out: 100, cacheRead: 2, currency: "¥" } },
          { value: "kimi/kimi-k2.7-code",          model: "kimi-k2.7-code",          displayName: "Kimi K2.7 Code",      description: "kimi-k2.7-code · 编码", provider: "kimi", contextWindow: 262_144, price: { in: 6.5, out: 27, cacheRead: 1.3, currency: "¥" } },
          { value: "kimi/kimi-k2.7-code-highspeed", model: "kimi-k2.7-code-highspeed", displayName: "Kimi K2.7 Code 高速", description: "kimi-k2.7-code-highspeed · 快", provider: "kimi", contextWindow: 262_144, price: { in: 13, out: 54, cacheRead: 2.6, currency: "¥" } },
          { value: "kimi/kimi-k2.6",               model: "kimi-k2.6",               displayName: "Kimi K2.6",           description: "kimi-k2.6 · 通用", provider: "kimi", contextWindow: 262_144, price: { in: 6.5, out: 27, cacheRead: 1.1, currency: "¥" } },
        ],
      })),
    ],
  },
  glm: {
    id: "glm", label: "GLM", transport: "anthropic", subscriptionUsage: false, vision: false,
    baseUrl: "https://api.z.ai/api/anthropic",
    baseUrlCN: "https://open.bigmodel.cn/api/anthropic",
    smallFast: "glm-4.5-air",
    models: [
      { value: "glm/glm-4.6",     model: "glm-4.6",     displayName: "GLM-4.6",     description: "glm-4.6 · 最强", provider: "glm", contextWindow: 200_000 },
      { value: "glm/glm-4.5-air", model: "glm-4.5-air", displayName: "GLM-4.5 Air", description: "glm-4.5-air · 快", provider: "glm", contextWindow: 128_000 },
    ],
  },
  qwen: {
    id: "qwen", label: "Qwen", transport: "anthropic", subscriptionUsage: false, vision: false,
    baseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    baseUrlCN: "https://dashscope.aliyuncs.com/apps/anthropic",
    smallFast: "qwen3-coder-flash",
    models: [
      { value: "qwen/qwen3-coder-plus",  model: "qwen3-coder-plus",  displayName: "Qwen3 Coder Plus",  description: "qwen3-coder-plus · 最强", provider: "qwen", contextWindow: 1_000_000 },
      { value: "qwen/qwen3-coder-flash", model: "qwen3-coder-flash", displayName: "Qwen3 Coder Flash", description: "qwen3-coder-flash · 快", provider: "qwen", contextWindow: 1_000_000 },
    ],
  },
  minimax: {
    id: "minimax", label: "MiniMax", transport: "anthropic", subscriptionUsage: false, vision: false,
    baseUrl: "https://api.minimax.io/anthropic",
    baseUrlCN: "https://api.minimaxi.com/anthropic",
    smallFast: "MiniMax-M2",
    models: [
      { value: "minimax/MiniMax-M2", model: "MiniMax-M2", displayName: "MiniMax M2", description: "MiniMax-M2 · 编码", provider: "minimax", contextWindow: 200_000 },
    ],
  },

  // ---- 仅 OpenAI 兼容(过本地转译代理)----
  // 这几家不写 vision:代理会把 image 块转成 image_url 发过去(见 openai-proxy.mjs),能不能收由模型定,
  // 不声明 = 放行。国内多半连不上,也没有 CN 域名可给。
  grok: {
    id: "grok", label: "Grok", transport: "openai", subscriptionUsage: false,
    baseUrl: "https://api.x.ai/v1",
    smallFast: "grok-code-fast-1",
    models: [
      { value: "grok/grok-code-fast-1", model: "grok-code-fast-1", displayName: "Grok Code Fast", description: "grok-code-fast-1 · 编码", provider: "grok", contextWindow: 256_000 },
      { value: "grok/grok-4",           model: "grok-4",           displayName: "Grok 4",          description: "grok-4 · 最强", provider: "grok", contextWindow: 256_000 },
    ],
  },
  openai: {
    id: "openai", label: "OpenAI Codex", transport: "openai", subscriptionUsage: false,
    baseUrl: "https://api.openai.com/v1",
    smallFast: "gpt-5-mini",
    models: [
      { value: "openai/gpt-5-codex", model: "gpt-5-codex", displayName: "GPT-5 Codex", description: "gpt-5-codex · 编码", provider: "openai", contextWindow: 400_000 },
      { value: "openai/gpt-5",       model: "gpt-5",       displayName: "GPT-5",       description: "gpt-5 · 通用", provider: "openai", contextWindow: 400_000 },
    ],
  },
  gemini: {
    id: "gemini", label: "Gemini", transport: "openai", subscriptionUsage: false,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", // Gemini 的 OpenAI 兼容端点
    smallFast: "gemini-2.5-flash",
    models: [
      { value: "gemini/gemini-2.5-pro",   model: "gemini-2.5-pro",   displayName: "Gemini 2.5 Pro",   description: "gemini-2.5-pro · 最强", provider: "gemini", contextWindow: 1_000_000 },
      { value: "gemini/gemini-2.5-flash", model: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", description: "gemini-2.5-flash · 快", provider: "gemini", contextWindow: 1_000_000 },
    ],
  },
};

// 本地转译代理端口,server.mjs 启动时设。openai 传输的 provider baseUrl 由此拼出。
let PROXY_PORT = 0;
export function setProxyPort(p) { PROXY_PORT = p; }
export function getProxyPort() { return PROXY_PORT; }

// 模型 value 属于哪个 provider
export function providerOf(modelValue) {
  if (!modelValue || modelValue === "default") return "claude";
  const pre = String(modelValue).split("/")[0];
  return pre !== "claude" && PROVIDERS[pre] ? pre : "claude";
}

// 传给 SDK query.model 的真实模型 id(去掉 provider 前缀)
export function modelArg(modelValue) {
  const p = providerOf(modelValue);
  return p === "claude" ? modelValue : String(modelValue).slice(p.length + 1);
}

// 这把 key 可能打得通的所有候选。一个候选 = 一个端点 + 它自带的计费形态(models / price /
// subscriptionUsage / balanceApi)。候选之间为什么不同,探测器不关心 —— 它只关心哪个不回 401:
//   · 大多数家:只差域名(国际站 / 国内站是两套账号,key 只在一边有效),属性全一样;
//   · Kimi:订阅端点和开放平台端点连模型表和计费方式都不同(见上面的 variants)。
// 手填了 baseUrl 就只有那一个候选(用户说了算,不探,也不拿他指定的地址去试别的)。
//
// 顺序 = 探测顺序。「优先国内节点」开关只决定先试哪个,不决定最终用哪个:两边都认这把 key 时听开关的,
// 只有一边认时听探测的 —— 勾了开关也绝不会把用户钉在一个会 401 的域名上。
export function variantsOf(id, settings) {
  const def = PROVIDERS[id];
  if (!def) return [];
  // 没显式声明 variants 的,由 baseUrl/baseUrlCN 生成两个只差域名的候选
  const all = def.variants || [{ baseUrl: def.baseUrl }, def.baseUrlCN ? { baseUrl: def.baseUrlCN, cn: true } : null].filter(Boolean);
  const cfg = settings?.providerConfig?.[id] || {};
  if (cfg.baseUrl) {
    // 手填**只换地址**,模型表/单价/计费形态仍继承对应的候选:地址能对上就用那个候选,
    // 对不上(自建代理)就用头一个。别返回裸的 { baseUrl } —— 那会把 smallFast 和 models 一并抹掉,
    // 后果是背景小任务改用贵模型跑、/model 菜单里这家的模型直接消失。
    const base = all.find((v) => v.baseUrl === cfg.baseUrl) || all[0] || {};
    return [{ ...base, baseUrl: cfg.baseUrl }];
  }
  return settings?.cnEndpoint ? [...all].sort((a, b) => (b.cn ? 1 : 0) - (a.cn ? 1 : 0)) : all;
}

// 候选的 baseUrl 列表(probeEndpoint 要挨个打的那些)
export function endpointsOf(id, settings) {
  return variantsOf(id, settings).map((v) => v.baseUrl);
}

// 出厂默认 + 选中的候选 + 用户覆盖,三层合并成本次实际生效的配置。
// 选哪个候选:探测命中的那个(settings.providerEndpoint,见 server.mjs 的 probeEndpoint);
// 还没探到就用候选表的头一个 —— 而候选表已按「优先国内节点」排过序,等于沿用开关的意思。
// 探测结果只在还是候选之一时才认 —— 出厂端点改版后旧记录自动作废,不会把用户钉在死地址上。
// 用户手填的 baseUrl / smallFast / models 压过一切(models 是整表替换,便于增删改)。
export function resolvedProvider(id, settings) {
  const def = PROVIDERS[id];
  if (!def) return null;
  const cfg = settings?.providerConfig?.[id] || {};
  const vs = variantsOf(id, settings);
  const probed = settings?.providerEndpoint?.[id];
  const v = vs.find((x) => x.baseUrl === probed) || vs[0] || {};
  return {
    ...def, ...v, // 候选自带的 models/price/subscriptionUsage/balanceApi 覆盖 provider 级默认
    baseUrl: cfg.baseUrl || v.baseUrl || def.baseUrl,
    smallFast: cfg.smallFast || v.smallFast || def.smallFast,
    models: Array.isArray(cfg.models) && cfg.models.length ? cfg.models : (v.models || def.models),
  };
}

export function isConfigured(providerId, keys) {
  return providerId === "claude" ? true : !!keys?.[providerId];
}

// 该模型要给 CLI 注的环境变量(claude 用系统默认鉴权,返回空)。settings = 本地 settings 全量。
export function envForModel(modelValue, settings) {
  const p = providerOf(modelValue);
  if (p === "claude") return {};
  const def = resolvedProvider(p, settings);
  const keys = settings?.providerKeys || {};
  const model = modelArg(modelValue);
  const token = keys?.[p] || "";
  // openai 传输:指向本地代理,由代理转译后打真正的 OpenAI 兼容端点。
  const baseUrl = def.transport === "openai" ? `http://127.0.0.1:${PROXY_PORT}/${p}` : def.baseUrl;
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: def.smallFast || model, // 背景小任务走同家便宜模型,别打 claude haiku(会 404)
    // CLI 起来还会打遥测/统计/自动更新检查,全是 Anthropic 的域名。走第三方 provider 时这些请求
    // 一没用二打不通(国内直连要么慢要么超时),每次起会话白等十几秒,看起来像 ChatCode 卡死。
    // 只在非 claude 会话关(本函数在 claude 时已提前 return),claude 用户该走的照走。
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}

// 已配置 key 的非 claude provider 的模型(拼进 /model 菜单),用合并后的配置。
export function extraModels(settings) {
  const keys = settings?.providerKeys || {};
  const out = [];
  for (const p of Object.values(PROVIDERS)) {
    if (p.id === "claude") continue;
    if (!isConfigured(p.id, keys)) continue;
    const r = resolvedProvider(p.id, settings);
    if (r?.models) out.push(...r.models);
  }
  return out;
}

// provider 是否走本地代理(openai 传输)
export function isProxied(providerId) { return PROVIDERS[providerId]?.transport === "openai"; }

// 「优先国内节点」的出厂默认:机器本身在国内就默认开。国际站在国内要么慢要么连不上,
// 让国内用户先试国内站更可能一次连通;真不认这把 key 时探针会改判(见 server.mjs 的 probeEndpoint),
// 所以这个默认最坏只是多探一个域名,不会把人钉在 401 的端点上。
// 判据只用时区 + 语言:这是本地信息,不用为了猜网络环境先联一次网(联不上的正是要照顾的那批人)。
// ponytail: 时区改了国外、语言仍中文的会误判成国内 —— 上限就是首探多花几秒,用户取消勾选即永久生效。
const CN_TZ = ["Asia/Shanghai", "Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "Asia/Urumqi", "PRC"];
export function isCnMachine(tz, lang) {
  if (CN_TZ.includes(tz)) return true;
  // 语言形如 zh_CN.UTF-8 / zh-Hans / zh。港澳台(zh-TW/zh-HK/zh-Hant)与新加坡不算:
  // 那边直连国际站没问题,且各家国内站未必受理当地账号。
  return /^zh(-cn|-hans)?(\.|$)/.test(String(lang || "").replace(/_/g, "-").toLowerCase());
}
