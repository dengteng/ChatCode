#!/usr/bin/env node
// 把 product-intro-pic 出的图片和发布文案传进 vault(tt-knowledge 的 dengtengly@gmail.com 空间)，
// 手机端「知识 → 文件」里能直接翻。
//
//   node scripts/publish-pics.mjs                    # 传全部期
//   node scripts/publish-pics.mjs 13-功能特性横版     # 只传这一期
//   node scripts/publish-pics.mjs login <邮箱>        # 换账号才需要(凭据和 publish-apk 共用)
//   node scripts/publish-pics.mjs code <验证码>
import fs from 'node:fs'
import path from 'node:path'
import { login, verify, pushBlob, pushNote, deleteFiles, die } from './vault.mjs'

const OUT = path.join(import.meta.dirname, '../.product-intro/ChatCode/out')
// 就一层 chatcode/,别再往下套 packages/product-intro:客户端文件列表是单行截断的,
// 前缀长一点每一行就全是相同的那截,看不出是哪一期哪张图。
const VAULT_ROOT = 'chatcode'
const HINT = 'node scripts/publish-pics.mjs'
const mb = (n) => (n / 1024 / 1024).toFixed(1)

// 已传过的 hash 记在这里：图片一期十几张、单张 1MB 上下，重跑一次全量传一遍纯属浪费。
// 放 out/ 底下不放仓库根，跟着产物走；被删了大不了重传一次。
const SEEN = path.join(OUT, '.published.json')
const readSeen = () => { try { return JSON.parse(fs.readFileSync(SEEN, 'utf8')) } catch { return {} } }

async function upload(only) {
    if (!fs.existsSync(OUT)) die(`没找到产物目录：${OUT}`)
    const dirs = fs.readdirSync(OUT)
        .filter((d) => fs.statSync(path.join(OUT, d)).isDirectory())
        .filter((d) => !only || d === only)
    if (!dirs.length) die(only ? `没有这一期：${only}` : '产物目录是空的')

    const seen = readSeen()
    let sent = 0, skipped = 0, bytes = 0, quotaLine = ''

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

            if (f.toLowerCase().endsWith('.md')) {
                await pushNote(vaultPath, buf.toString('utf8'))
            } else {
                const { used, quota } = await pushBlob(vaultPath, buf)
                quotaLine = `配额 ${mb(used)} / ${mb(quota)} MB`
            }
            seen[vaultPath] = stamp
            sent++; bytes += buf.length
            console.log(`  ✓ ${vaultPath} (${mb(buf.length)} MB)`)
            // 每传一个就落盘:中途断了下次接着传,不用从头再来
            fs.writeFileSync(SEEN, JSON.stringify(seen, null, 2))
        }
    }
    console.log(`\n上传 ${sent} 个（${mb(bytes)} MB），跳过 ${skipped} 个未改动。${quotaLine}`)
}

/** 标删一批 vault 路径，并把它们从增量表里摘掉，好让下次重传。 */
async function drop(prefix) {
    if (!prefix) die(`用法: ${HINT} drop <vault 路径前缀>`)
    const seen = readSeen()
    const hit = Object.keys(seen).filter((p) => p.startsWith(prefix))
    if (!hit.length) die(`增量表里没有以 ${prefix} 开头的路径`)
    await deleteFiles(hit)
    for (const p of hit) delete seen[p]
    fs.writeFileSync(SEEN, JSON.stringify(seen, null, 2))
    console.log(`已标删 ${hit.length} 个：${prefix}…`)
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'login') await login(arg, HINT)
else if (cmd === 'code') await verify(arg, HINT)
else if (cmd === 'drop') await drop(arg)
else await upload(cmd)
