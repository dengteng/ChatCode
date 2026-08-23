#!/usr/bin/env node
// 后台任务进度条的解析自检 —— dockerStat() 在 Chat.tsx 里,是 tsx 没法直接 import,
// 于是这里照抄一份规则,再断言源码里还是同样的正则(漂移了就报错,免得这个检查在测空气)。
// 样本是真跑 `docker compose pull` 抓的原样输出(非 TTY),不是手编的。
//
// 跑法:node scripts/bg-progress.check.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

const SRC = readFileSync("src/components/Chat.tsx", "utf8");
for (const frag of [
  "Pulling fs layer", "Pull complete", "Downloading\\s+([\\d.]+)",
  "Image\\s.*\\sPulling", "Image\\s.*\\sPulled",
]) assert.ok(SRC.includes(frag), `Chat.tsx 与本检查已漂移,缺: ${frag}`);

const BYTE_UNIT = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9 };
function dockerStat(out) {
  const layers = new Set(), done = new Set(), bytes = new Map();
  let imgs = 0, imgsDone = 0;
  for (const ln of out.split("\n")) {
    let m;
    if ((m = ln.match(/^\s*([0-9a-f]{8,}):?\s+Pulling fs layer/))) layers.add(m[1]);
    else if ((m = ln.match(/^\s*([0-9a-f]{8,}):?\s+Pull complete/))) { layers.add(m[1]); done.add(m[1]); }
    else if ((m = ln.match(/^\s*([0-9a-f]{8,}):?\s+Downloading\s+([\d.]+)\s*([kKMG]?B)\b/))) {
      layers.add(m[1]);
      bytes.set(m[1], Math.max(bytes.get(m[1]) ?? 0, parseFloat(m[2]) * (BYTE_UNIT[m[3]] ?? 1)));
    }
    else if (/^\s*Image\s.*\sPulling\s*$/.test(ln)) imgs++;
    else if (/^\s*Image\s.*\sPulled\s*$/.test(ln)) imgsDone++;
  }
  if (!layers.size && !imgs) return null;
  return { layers: layers.size, layersDone: done.size, imgs, imgsDone,
           bytes: [...bytes.values()].reduce((a, b) => a + b, 0) };
}

// --- 样本 1:docker compose pull,两个镜像跑完 -------------------------------
const COMPOSE = ` Image alpine:3.19 Pulling
 Image busybox:1.36 Pulling
 821d9dafb26d Pulling fs layer 0B
 5711127a7748 Pulling fs layer 0B
 ac150686e4d6 Download complete 0B
 821d9dafb26d Downloading 1.049MB
 5711127a7748 Downloading 1.049MB
 5711127a7748 Downloading 2.097MB
 821d9dafb26d Download complete 0B
 821d9dafb26d Pull complete 0B
 Image busybox:1.36 Pulled
 5711127a7748 Download complete 0B
 5711127a7748 Pull complete 0B
 Image alpine:3.19 Pulled`;
const a = dockerStat(COMPOSE);
assert.deepStrictEqual(a, { layers: 2, layersDone: 2, imgs: 2, imgsDone: 2, bytes: 3.146e6 },
  "compose 样本解析不对: " + JSON.stringify(a));
// 只报过 "Download complete" 的层不进分母:它们永远不会有 "Pull complete",
// 算进去的话进度会永远卡在 2/5 到不了头。
assert.ok(!COMPOSE.includes("ac150686e4d6 Pull complete"));

// --- 样本 2:裸 docker pull,没有任何字节数 ---------------------------------
const PLAIN = `latest: Pulling from library/nginx
58dee6a49ef1: Pulling fs layer
58dee6a49ef1: Pull complete
Status: Downloaded newer image for nginx:alpine`;
const b = dockerStat(PLAIN);
assert.deepStrictEqual(b, { layers: 1, layersDone: 1, imgs: 0, imgsDone: 0, bytes: 0 },
  "裸 docker pull 样本解析不对: " + JSON.stringify(b));

// --- 样本 3:不是 docker 的输出,必须回 null(交给"显示最后一行"那条路)-------
assert.strictEqual(dockerStat("npm warn deprecated foo@1.0.0\nadded 412 packages"), null);
assert.strictEqual(dockerStat(""), null);

console.log("后台任务进度解析检查通过");
