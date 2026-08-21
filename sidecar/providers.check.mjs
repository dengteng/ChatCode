// provider 解析自检(纯函数,不起服务):
//   node sidecar/providers.check.mjs
//
// 验三件事:
//   1. baseUrl 的优先级 —— 用户手填 > 国内节点开关 > 出厂默认(这条错了,勾了开关也还打国际域名);
//   2. 非 claude 会话注了「关掉非必要外网请求」那组 env(不注则国内每次起会话白等十几秒);
//   3. claude 会话一个 env 都不注(它得照常走 Anthropic 自己那套)。
import assert from "node:assert";
import { envForModel, resolvedProvider, endpointsOf, variantsOf, isCnMachine, PROVIDERS } from "./providers.mjs";

const keys = { providerKeys: { glm: "k", deepseek: "k" } };

// 1. baseUrl 优先级
assert.strictEqual(resolvedProvider("glm", keys).baseUrl, PROVIDERS.glm.baseUrl, "默认该用国际域名");
assert.strictEqual(resolvedProvider("glm", { ...keys, cnEndpoint: true }).baseUrl, PROVIDERS.glm.baseUrlCN, "勾了国内节点该切国内域名");
assert.strictEqual(
  resolvedProvider("glm", { ...keys, cnEndpoint: true, providerConfig: { glm: { baseUrl: "https://my.proxy/anthropic" } } }).baseUrl,
  "https://my.proxy/anthropic", "用户手填的必须压过国内节点开关");
// 没有国内域名的那几家,勾了也不该变
assert.strictEqual(resolvedProvider("deepseek", { ...keys, cnEndpoint: true }).baseUrl, PROVIDERS.deepseek.baseUrl);
// 探测命中压过开关:key 只在国际站有效时,勾了国内节点也得走国际站(否则每次请求都 401)
assert.strictEqual(
  resolvedProvider("glm", { ...keys, cnEndpoint: true, providerEndpoint: { glm: PROVIDERS.glm.baseUrl } }).baseUrl,
  PROVIDERS.glm.baseUrl, "探测命中必须压过国内节点开关");
// 但压不过用户手填
assert.strictEqual(
  resolvedProvider("glm", { ...keys, providerEndpoint: { glm: PROVIDERS.glm.baseUrlCN }, providerConfig: { glm: { baseUrl: "https://my.proxy/anthropic" } } }).baseUrl,
  "https://my.proxy/anthropic", "用户手填必须压过探测结果");
// 出厂域名改版后,旧探测结果(已不在候选里)必须自动作废,别把用户钉在死域名上
assert.strictEqual(
  resolvedProvider("glm", { ...keys, providerEndpoint: { glm: "https://old.dead.domain/anthropic" } }).baseUrl,
  PROVIDERS.glm.baseUrl, "不在候选里的旧探测结果该作废");
console.log("✓ baseUrl 优先级:手填 > 探测命中 > 国内节点 > 默认");

// 4. 候选端点:开关只换顺序,不换集合(两边都通时听开关的,只有一边通时听探测的)
assert.deepStrictEqual(endpointsOf("glm", keys), [PROVIDERS.glm.baseUrl, PROVIDERS.glm.baseUrlCN]);
assert.deepStrictEqual(endpointsOf("glm", { ...keys, cnEndpoint: true }), [PROVIDERS.glm.baseUrlCN, PROVIDERS.glm.baseUrl]);
// 手填了就只有这一个候选 —— probeEndpoint 据此跳过探测,不拿用户指定的地址去试别的
assert.deepStrictEqual(endpointsOf("glm", { ...keys, providerConfig: { glm: { baseUrl: "https://my.proxy/anthropic" } } }), ["https://my.proxy/anthropic"]);
// 没有国内域名的那几家只有一个候选,永远不触发探测
assert.deepStrictEqual(endpointsOf("deepseek", { ...keys, cnEndpoint: true }), [PROVIDERS.deepseek.baseUrl]);
console.log("✓ 候选端点:开关只决定顺序,手填则只剩一个候选");

// 5. Kimi 的两套账号体系:探到哪个变体,计费形态和模型表就整套跟着换
const kimiKeys = { providerKeys: { kimi: "k" } };
const CODING = "https://api.kimi.com/coding";
const PLATFORM = "https://api.moonshot.cn/anthropic";
const sub = resolvedProvider("kimi", { ...kimiKeys, providerEndpoint: { kimi: CODING } });
const pay = resolvedProvider("kimi", { ...kimiKeys, providerEndpoint: { kimi: PLATFORM } });
assert.strictEqual(sub.subscriptionUsage, true, "订阅端点该显示额度窗口");
assert.strictEqual(sub.kimiUsageApi, true, "订阅端点才有 /v1/usages");
assert.ok(!sub.balanceApi, "订阅制没有账户余额");
assert.strictEqual(pay.subscriptionUsage, false, "平台端点该显示余额+花费,不是额度窗口");
assert.ok(!pay.kimiUsageApi, "平台端点没有额度窗口接口,别去打");
assert.strictEqual(pay.balanceApi.path, "/v1/users/me/balance");
// 两套模型表不能串:选错端点的模型 id 直接 404
assert.ok(sub.models.every((m) => !m.price), "订阅制模型不该带单价(用户按额度扣,不按 token 付钱)");
assert.ok(pay.models.every((m) => m.price?.currency === "¥"), "平台模型必须带人民币单价");
assert.ok(!sub.models.some((m) => pay.models.some((p) => p.model === m.model)), "两套模型 id 不该重叠");
// 探测器要能把两边端点都试到(含开放平台的国内/国际两个域名)
assert.deepStrictEqual(endpointsOf("kimi", kimiKeys), [CODING, PLATFORM, "https://api.moonshot.ai/anthropic"]);
// 勾了国内优先:带 cn 标记的排到前面,订阅端点(无 cn 标记)顺延
assert.strictEqual(variantsOf("kimi", { ...kimiKeys, cnEndpoint: true })[0].baseUrl, PLATFORM);
// 手填 baseUrl 只换地址,不该把候选自带的 smallFast / 模型表 / 计费形态一并抹掉
const manual = resolvedProvider("kimi", { ...kimiKeys, providerConfig: { kimi: { baseUrl: CODING } } });
assert.strictEqual(manual.smallFast, "kimi-for-coding-highspeed", "手填地址不该弄丢 smallFast(背景小任务会改用贵模型跑)");
assert.ok(manual.models?.length, "手填地址不该弄丢模型表(/model 菜单里这家会整个消失)");
assert.strictEqual(manual.subscriptionUsage, true, "手填地址不该弄丢计费形态");
// 自建代理(地址对不上任何候选)退回头一个候选的属性,而不是一片空
const viaProxy = resolvedProvider("kimi", { ...kimiKeys, providerConfig: { kimi: { baseUrl: "https://my.proxy/anthropic" } } });
assert.strictEqual(viaProxy.baseUrl, "https://my.proxy/anthropic");
assert.ok(viaProxy.smallFast && viaProxy.models?.length, "自建代理也得有可用的 smallFast 和模型表");
console.log("✓ 手填 baseUrl 只换地址,模型表/单价/计费形态照旧继承");

// 余额取值:按实测响应形状解析,单位元
assert.strictEqual(pay.balanceApi.pick({ code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 } }).balance, 49.58894);
assert.strictEqual(PROVIDERS.deepseek.balanceApi.pick({ balance_infos: [{ currency: "CNY", total_balance: "110.00" }] }).balance, 110);
console.log("✓ Kimi 两套账号体系:订阅走额度窗口、平台走余额+单价,模型表不串");

// 2. 非 claude 会话:endpoint 三件套 + 关掉非必要外网请求
const ds = envForModel("deepseek/deepseek-v4-pro", keys);
assert.strictEqual(ds.ANTHROPIC_BASE_URL, PROVIDERS.deepseek.baseUrl);
assert.strictEqual(ds.ANTHROPIC_MODEL, "deepseek-v4-pro", "传给 CLI 的必须是去掉前缀的真实模型 id");
for (const k of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_AUTOUPDATER"])
  assert.strictEqual(ds[k], "1", `${k} 没关`);
console.log("✓ 第三方会话已关掉遥测/统计/自动更新");

// 3. claude 会话:什么都不注
assert.deepStrictEqual(envForModel("default", keys), {});
assert.deepStrictEqual(envForModel("claude-opus-5", keys), {});
console.log("✓ Claude 会话 env 不受影响");

// 4. 能不能发图的声明(前端 canSendImage 据此拦图片)
assert.strictEqual(PROVIDERS.deepseek.vision, false);
assert.strictEqual(PROVIDERS.gemini.vision, undefined, "没声明 = 放行,别误拦");
// 模型级 vision 盖 provider 级:DeepSeek 只有 vision-exp 收图,provider 那级仍是 false。
// 丢了这个 true,输入框会把图片拦在外面(canSendImage 先读模型级);而 provider 那级若被改成 true,
// 另外两个模型收到图片会静默丢弃、照样编答案(实测不回 400) —— 两边都得钉住。
const dsVision = PROVIDERS.deepseek.models.filter((m) => m.vision === true).map((m) => m.model);
assert.deepStrictEqual(dsVision, ["deepseek-v4-flash-vision-exp"], "DeepSeek 收图的模型只该有这一个");
console.log("✓ vision 声明就位");

// 5. 「优先国内节点」的出厂默认:按机器时区/语言判国内
assert.strictEqual(isCnMachine("Asia/Shanghai", "en_US.UTF-8"), true, "时区在国内就算国内,语言不管");
assert.strictEqual(isCnMachine("Asia/Urumqi", ""), true);
assert.strictEqual(isCnMachine("America/Los_Angeles", "zh_CN.UTF-8"), true, "中文语言也算(海外华人常用国内站)");
assert.strictEqual(isCnMachine("America/Los_Angeles", "zh-Hans"), true);
assert.strictEqual(isCnMachine("America/Los_Angeles", "en_US.UTF-8"), false);
// GUI 启动拿不到 LANG 时退回界面语言(settings.lang 只有 "zh" / "en" 两个值)
assert.strictEqual(isCnMachine("", "zh"), true, "中文界面该算国内");
assert.strictEqual(isCnMachine("", "en"), false);
assert.strictEqual(isCnMachine("Asia/Taipei", "zh_TW.UTF-8"), false, "港澳台直连国际站没问题,别改判");
assert.strictEqual(isCnMachine("Asia/Hong_Kong", "zh-Hant"), false);
assert.strictEqual(isCnMachine("", ""), false, "探不到时区/语言就按国际站,不瞎猜");
console.log("✓ 国内环境判定就位");

console.log("all ok");
