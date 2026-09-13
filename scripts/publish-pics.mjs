#!/usr/bin/env node
// 把 product-intro-pic 出的图片和发布文案放进 Obsidian 库（chatcode/<期>/…），
// Fast Note Sync 同步到 NAS 和手机，手机 Obsidian 里直接翻。
//
//   node scripts/publish-pics.mjs                    # 传全部期
//   node scripts/publish-pics.mjs 13-功能特性横版     # 只传这一期
//   node scripts/publish-pics.mjs drop chatcode/12-   # 删一批(前缀匹配)
//
// 以前经 public-services 的 /api/vault 上传到 tt center，知识库搬到 Obsidian 后改成复制进库目录。
import fs from 'node:fs'
import path from 'node:path'
import { assertVault, putFile, dropPrefix, die } from './obsidian-vault.mjs'

const OUT = path.join(import.meta.dirname, '../.product-intro/ChatCode/out')
// 就一层 chatcode/,别再往下套 packages/product-intro：文件列表单行截断，前缀长了看不出是哪一期
const VAULT_ROOT = 'chatcode'
const HINT = 'node scripts/publish-pics.mjs'
const mb = (n) => (n / 1024 / 1024).toFixed(1)

// 已传过的记在这里：图片一期十几张、单张 1MB 上下，重跑一次全量复制再触发一遍同步纯属浪费。
// 放 out/ 底下不放仓库根，跟着产物走；被删了大不了重传一次。
const SEEN = path.join(OUT, '.published.json')
const readSeen = () => { try { return JSON.parse(fs.readFileSync(SEEN, 'utf8')) } catch { return {} } }

function upload(only) {
    assertVault()
    if (!fs.existsSync(OUT)) die(`没找到产物目录：${OUT}`)
    const dirs = fs.readdirSync(OUT)
        .filter((d) => fs.statSync(path.join(OUT, d)).isDirectory())
        .filter((d) => !only || d === only)
    if (!dirs.length) die(only ? `没有这一期：${only}` : '产物目录是空的')

    const seen = readSeen()
    let sent = 0, skipped = 0, bytes = 0

    for (const dir of dirs) {
        const files = fs.readdirSync(path.join(OUT, dir))
            .filter((f) => /\.(jpg|jpeg|png|md)$/i.test(f))
            .sort()
        for (const f of files) {
            const abs = path.join(OUT, dir, f)
            const buf = fs.readFileSync(abs)
            const vaultPath = `${VAULT_ROOT}/${dir}/${f}`
            // mtime + size 当指纹:比重算 sha256 便宜,改了图必然两者之一变
            const stamp = `${fs.statSync(abs).mtimeMs}:${buf.length}`
            if (seen[vaultPath] === stamp) { skipped++; continue }
            putFile(vaultPath, buf)
            seen[vaultPath] = stamp
            sent++; bytes += buf.length
            console.log(`  ✓ ${vaultPath} (${mb(buf.length)} MB)`)
            fs.writeFileSync(SEEN, JSON.stringify(seen, null, 2))
        }
    }
    console.log(`\n放进库 ${sent} 个（${mb(bytes)} MB），跳过 ${skipped} 个未改动。Obsidian 开着就会自动同步。`)
}

/** 删一批库内路径，并把它们从增量表里摘掉，好让下次重传。 */
function drop(prefix) {
    if (!prefix) die(`用法: ${HINT} drop <库内路径前缀>`)
    assertVault()
    const hit = dropPrefix(prefix)
    const seen = readSeen()
    for (const p of Object.keys(seen)) if (p.startsWith(prefix)) delete seen[p]
    fs.writeFileSync(SEEN, JSON.stringify(seen, null, 2))
    console.log(`已删 ${hit.length} 个：${prefix}…`)
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'drop') drop(arg)
else if (cmd === 'login' || cmd === 'code') die('不用登录了：现在直接复制进本机 Obsidian 库')
else upload(cmd)
