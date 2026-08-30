// vault 同步的最小客户端：登录、鉴权、推笔记/附件。
// 这份是从 fortune-signal-app/scripts/vault.mjs 原样搬过来的 —— 两个项目各自独立，
// 跨仓库 import 的相对路径迟早断。改动前先看那边是不是也要跟着改。
// 凭据文件 ~/.chatcode-publish.json 两边共用（同一台机器、同一个设备登记）。
//
// 凭据是这台机器单独登的一个设备，跟手机端/桌面端互不影响：那两端的 refresh token
// 是轮换式的，借用一次就把它们顶下线了。
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const BASE = 'https://api.dengteng.xyz'
// 曾用名 'ChatCode'（跟本仓库同名纯属巧合，它指的是那一行 Project，不是这个项目）。
// fortune-signal-app/scripts/vault.mjs 是同一份，改名两处都要改。
export const PROJECT_ID = 'tt-center'
// 放 home 不放仓库：这是长期凭据，别让它跟着 git 走
const STORE = path.join(os.homedir(), '.chatcode-publish.json')

const readStore = () => {
    try { return JSON.parse(fs.readFileSync(STORE, 'utf8')) } catch { return null }
}
const writeStore = (s) => fs.writeFileSync(STORE, JSON.stringify(s, null, 2), { mode: 0o600 })

export const die = (msg) => { console.error(msg); process.exit(1) }

const post = (p, body) =>
    fetch(BASE + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Project-Id': PROJECT_ID },
        body: JSON.stringify(body),
    })

export async function login(email, hint) {
    if (!email) die(`用法: ${hint} login <邮箱>`)
    const r = await post('/api/auth/request-code', { email, projectId: PROJECT_ID })
    if (!r.ok) die(`发码失败: ${r.status} ${await r.text()}`)
    writeStore({ ...(readStore() ?? {}), email })
    console.log(`验证码已发到 ${email}，收到后跑: ${hint} code <验证码>`)
}

export async function verify(code, hint) {
    const s = readStore()
    if (!s?.email) die(`先跑 ${hint} login <邮箱>`)
    if (!code) die(`用法: ${hint} code <验证码>`)
    // deviceId 存下来复用：重登不会在账号的设备列表里堆出一排同名设备
    const deviceId = s.deviceId ?? crypto.randomUUID()
    const r = await post('/api/auth/verify-code', {
        email: s.email,
        code,
        projectId: PROJECT_ID,
        clientDeviceId: deviceId,
        platform: 'macos',
        deviceName: 'Mac 脚本',
    })
    if (!r.ok) die(`验证失败: ${r.status} ${await r.text()}`)
    const j = await r.json()
    writeStore({ ...s, deviceId, access: j.accessToken, refresh: j.refreshToken })
    console.log('登录成功')
}

/** 带鉴权请求；401 就用 refresh 换一对新的存回去(轮换式，换完必须落盘，否则下次就废了)。 */
export async function auth(p, init = {}, retry = true) {
    const s = readStore()
    if (!s?.access) die('还没登录：node scripts/publish-apk.mjs login <邮箱>')
    const res = await fetch(BASE + p, {
        ...init,
        headers: { Authorization: `Bearer ${s.access}`, 'X-Project-Id': PROJECT_ID, ...(init.headers ?? {}) },
    })
    if (res.status !== 401 || !retry) return res
    const r = await post('/api/auth/refresh', { refreshToken: s.refresh })
    if (!r.ok) die(`token 过期且刷新失败(${r.status})，重新登录: node scripts/publish-apk.mjs login <邮箱>`)
    const j = await r.json()
    writeStore({ ...s, access: j.accessToken, refresh: j.refreshToken })
    return auth(p, init, false)
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** 推一批文件元数据。字节要先传完 —— 反过来元数据会指向一个下载不到的 blob。 */
export async function pushFiles(files) {
    const r = await auth('/api/vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
    })
    if (!r.ok) die(`推元数据失败: ${r.status} ${await r.text()}`)
    const j = await r.json()
    if (j.conflicts?.length) die(`有冲突，没写进去: ${JSON.stringify(j.conflicts)}`)
    return j
}

/** 推一篇笔记(文本走 content 字段，不经 blob)。size 是 UTF-8 字节数，跟服务端一致。 */
export const pushNote = (vaultPath, text, sourceUrl = null) =>
    pushFiles([{
        path: vaultPath,
        content: text,
        binary: false,
        hash: sha256(text),
        size: Buffer.byteLength(text, 'utf8'),
        deleted: false,
        sourceUrl,
        clientUpdatedAt: Date.now(),
    }])

/**
 * 上传字节。走 curl 不走 fetch：node 26 的 fetch 默认协商 HTTP/2，几十 MB 的 body 在这条
 * 链路上必被远端半闭掉（`HTTP/2: stream half-closed`，连试多少次都一样），curl 钉死
 * HTTP/1.1 一次就过。小请求(元数据、刷 token)照旧用 fetch，它们没这个毛病。
 */
async function putBytes(hash, buf) {
    await auth('/api/auth/me') // 先把 token 刷到最新 —— curl 用不上 auth() 里那套 401 重试
    const { access } = readStore()
    const tmp = path.join(os.tmpdir(), `vault-${hash}.bin`)
    fs.writeFileSync(tmp, buf)
    try {
        const out = execFileSync('curl', [
            '-sS', '--http1.1', '-X', 'POST', `${BASE}/api/vault/blob`,
            '-H', `Authorization: Bearer ${access}`,
            '-H', `X-Project-Id: ${PROJECT_ID}`,
            '-H', `X-Vault-Hash: ${hash}`,
            '-H', 'Content-Type: application/octet-stream',
            '--data-binary', `@${tmp}`,
            '-w', '\n%{http_code}',
        ], { encoding: 'utf8' })
        const nl = out.lastIndexOf('\n')
        const [body, code] = [out.slice(0, nl), out.slice(nl + 1)]
        if (code !== '200') die(`上传字节失败: ${code} ${body}`)
        return JSON.parse(body)
    } finally {
        fs.rmSync(tmp, { force: true })
    }
}

/** 标删一批路径。vault 是软删 —— 推 deleted:true，各端下次同步就把本地那份清掉。 */
export const deleteFiles = (paths) =>
    pushFiles(paths.map((p) => ({
        path: p, content: null, binary: true,
        hash: '', size: 0, deleted: true, clientUpdatedAt: Date.now(),
    })))

/** 传附件字节再推元数据。返回配额信息。 */
export async function pushBlob(vaultPath, buf) {
    const hash = sha256(buf)
    const { used, quota } = await putBytes(hash, buf)
    await pushFiles([{
        path: vaultPath, content: null, binary: true,
        hash, size: buf.length, deleted: false, clientUpdatedAt: Date.now(),
    }])
    return { used, quota }
}
