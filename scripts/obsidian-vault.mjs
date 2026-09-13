// 往本机 Obsidian 库里放文件。库由 Fast Note Sync 插件同步到 NAS 和所有设备，
// 所以「发布」= 复制进库目录，不再经 public-services 的 /api/vault 上传。
// 前提：Mac 上 Obsidian 开着（插件跑在它里面），没开就等下次打开时同步。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const VAULT = process.env.OBSIDIAN_VAULT_DIR || path.join(os.homedir(), 'Documents/Obsidian Vault')

export const die = (msg) => { console.error(msg); process.exit(1) }

export function assertVault() {
    if (!fs.existsSync(path.join(VAULT, '.obsidian'))) die(`不是 Obsidian 库：${VAULT}（可用 OBSIDIAN_VAULT_DIR 覆盖）`)
}

/** 写一个文件到库内路径（文本、图片、APK 都一样）。目录不存在就建。 */
export function putFile(vaultPath, buf) {
    const abs = path.join(VAULT, vaultPath)
    if (!abs.startsWith(VAULT + path.sep)) die(`路径越出库：${vaultPath}`)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, buf)
    return abs
}

/** 删掉库里以某前缀开头的文件（同步到各端也会删）。返回删掉的库内路径。 */
export function dropPrefix(prefix) {
    const hit = []
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, e.name)
            const rel = path.relative(VAULT, abs)
            if (e.isDirectory()) { if (!rel.startsWith('.')) walk(abs) }
            else if (rel.startsWith(prefix)) { fs.rmSync(abs); hit.push(rel) }
        }
    }
    walk(VAULT)
    return hit
}
