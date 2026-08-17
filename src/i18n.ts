// 多语言:中文原文当键。
// zh 是默认语言,中文键不建词典 —— i18next 回退到键本身(即原文),零回归;
// 其它语言(en 起步)在 en.json 里以中文为 key、目标语言为值。
// 插值统一用 {{var}}:t("已安装 skill:{{n}}", { n })。
//
// 例外:同形不同义的少数几条用 ID 键(diff.added / ssh.username 这种)。
// 中文当键时它们会被迫共用一条英文 —— "新增"在 diff 图例是状态(Added)、在按钮是动作(Add),
// "账号"在 SSH 表单是 username、在个人资料是 account,一条键塞不下两个意思。
// ID 键在 zh 下回退到键名就露馅了,所以 zh.json 存在,且只放这几条 ID 键的中文。
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enDict from "./i18n/en.json";
import zhDict from "./i18n/zh.json";

const LANG_KEY = "ChatCode-lang";
export type Lang = "zh" | "en";

export function getLang(): Lang {
  return i18n.language === "en" ? "en" : "zh";
}
export function currentLocale(): string {
  return getLang() === "zh" ? "zh-CN" : "en-US";
}
// 首启:没存过就跟随系统(zh 系统给中文,其余英文)。
export function initialLang(): Lang {
  const stored = localStorage.getItem(LANG_KEY);
  if (stored === "zh" || stored === "en") return stored;
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}
// 切语言:落 localStorage + changeLanguage(react-i18next 自动重渲染所有 useTranslation 组件)。
export function setLang(l: Lang) {
  localStorage.setItem(LANG_KEY, l);
  i18n.changeLanguage(l);
}
// 跟随系统:清掉覆盖,重新按 navigator.language 判定。
export function resetLang() {
  localStorage.removeItem(LANG_KEY);
  i18n.changeLanguage(initialLang());
}
// 当前选择:显式存过就显示该语言,否则显示"跟随系统"。
export function selectedLang(): Lang | "auto" {
  const stored = localStorage.getItem(LANG_KEY);
  return stored === "zh" || stored === "en" ? stored : "auto";
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: enDict }, zh: { translation: zhDict } },
  lng: initialLang(),
  fallbackLng: "zh",
  // 中文键里会带 `.`(版本号)、`:`(全角冒号)等,禁掉 i18next 的键/命名空间拆分
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false }, // React 自带防注入
});

export default i18n;
