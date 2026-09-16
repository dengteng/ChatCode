#!/usr/bin/env node
// 把本项目的记忆（~/.claude/projects/<编码>/memory/*.md + MEMORY.md）镜像进 Obsidian 库。
// Fast Note Sync 同步到 NAS 和手机，手机上直接翻 —— 记忆文件本来就是带 frontmatter 的 md，
// 里面的 [[xxx]] 正好是 Obsidian 的双链，不用转换，放进去就能点。
//
//   node scripts/publish-memory.mjs              # 当前项目
//   node scripts/publish-memory.mjs ~/code/foo   # 指定项目目录
//   node scripts/publish-memory.mjs --dry        # 只看会动哪些文件
//
// 镜像语义：本地删掉的记忆，库里也删。记忆被删通常是因为它「错了」，
// 留在手机上继续被当真比不同步更糟。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { assertVault, putFile, VAULT, die } from './obsidian-vault.mjs'

// 编码规则和 Claude Code 一致（src/memory.ts 的 memoryDirFor 同款）：
// 所有非字母数字都换成 -，否则 dt_projects 这种带下划线的路径会指到别的目录。
const memoryDirFor = (cwd) => path.join(os.homedir(), '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'memory')

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const proj = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd())

const src = memoryDirFor(proj)
if (!fs.existsSync(src)) die(`这个项目还没有记忆目录：${src}`)
assertVault()

const name = path.basename(proj)
const vaultDir = `memory/${name}`
const absVaultDir = path.join(VAULT, vaultDir)

const mine = fs.readdirSync(src).filter((f) => f.endsWith('.md')).sort()
const theirs = fs.existsSync(absVaultDir) ? fs.readdirSync(absVaultDir).filter((f) => f.endsWith('.md')) : []

let put = 0, same = 0, gone = 0
for (const f of mine) {
    const buf = fs.readFileSync(path.join(src, f))
    const dst = path.join(absVaultDir, f)
    // 内容一样就别写：记忆文件才几 KB，但每写一次 Fast Note Sync 就推一轮，手机上白跳通知
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(buf)) { same++; continue }
    if (!dry) putFile(`${vaultDir}/${f}`, buf)
    put++
    console.log(`  ✓ ${vaultDir}/${f}`)
}
for (const f of theirs) {
    if (mine.includes(f)) continue
    if (!dry) fs.rmSync(path.join(absVaultDir, f))
    gone++
    console.log(`  ✗ ${vaultDir}/${f}（本地已删）`)
}

console.log(`\n${dry ? '[试运行] ' : ''}${name}：更新 ${put}，未变 ${same}，删除 ${gone}。库：${absVaultDir}`)
if (!dry && (put || gone)) console.log('Obsidian 开着就会自动同步。')
