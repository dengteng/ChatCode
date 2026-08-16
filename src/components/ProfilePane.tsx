// 设置里「个人资料」那一页的全部内容。
//
// 单独成文件是为了让 Settings.tsx 在开源版和内部版之间**逐字相同** —— 两个版本这一页装的东西
// 不一样(内部版还挂着账号与跨设备同步),差异全部收在这个文件里,合并时只有它冲突,
// 其余功能开发照常直进。改这里之前先想一下:加的东西是不是两边都要。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAvatar, getUserName, setAvatar, setUserName, fileToAvatar } from "./Avatar";

// 头像 + 昵称,只落本地 localStorage,不上传任何地方。
export function ProfilePane() {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(getAvatar);
  const [name, setName] = useState(getUserName);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const sync = () => { setSrc(getAvatar()); setName(getUserName()); };
    window.addEventListener("chatcode-avatar-change", sync);
    return () => window.removeEventListener("chatcode-avatar-change", sync);
  }, []);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) fileToAvatar(f); };
  return (
    <section className="settings-section">
      <h4>{t("个人资料")}</h4>
      <div className="profile-row">
        <span className="avatar avatar-user profile-avatar" onClick={() => fileRef.current?.click()} title={t("点击更换头像")}>
          {src ? <img src={src} alt={t("我")} /> : <span className="avatar-fallback">{name ? name.slice(0, 1).toUpperCase() : t("我")}</span>}
        </span>
        <div className="profile-avatar-actions">
          <button className="primary" onClick={() => fileRef.current?.click()}>{t("上传头像")}</button>
          {src && <button className="ghost" onClick={() => setAvatar(null)}>{t("移除")}</button>}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
        </div>
      </div>
      <label className="profile-name">{t("昵称")}
        <input value={name} onChange={(e) => { setName(e.target.value); setUserName(e.target.value); }} placeholder={t("我")} maxLength={24} />
      </label>
    </section>
  );
}
