/**
 * 设置页显式调用的资料包下载器。下载完成并激活 release 后，CorpusStore 才会打开。
 *
 * 下载源按序尝试（默认与产品设计一致）：
 *   1. modelscope —— ModelScope 数据集仓库直拉（不走站点 API）；
 *   2. site       —— PRTS.chat 站点（与浏览器前端同源同法，published/preview 匿名可取）。
 *
 * 任一源发现清单或下载失败即切换下一源；分片校验按各源清单的 sha256 执行，
 * 已存在且校验一致的文件跳过（跨源断点续传天然成立：同一构建的分片哈希相同）。
 * 全部通过后才写 current.json 指针——中途失败不产生“半激活”状态。
 *
 * ModelScope 布局（agent/scripts/publish_modelscope_mirrors.py 发布）：
 *   releases/<release_id>/dataset-manifest.json      ← 本仓全部文件清单（逐文件 size+sha256）
 *   releases/<release_id>/<pack>/{pack-manifest.json, shards/*.jsonl.gz, search-index/*.bin.gz}
 *
 * 站点布局（backend/routers/agent_data.py）：
 *   /api/agent/data/releases/<id>/release-manifest.json
 *   /api/agent/data/releases/<id>/<pack>/pack-manifest.json   ← 逐分片 size+sha256
 *   /api/agent/data/releases/<id>/<pack>/{shards|search-index}/...
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** ModelScope 分仓：两款游戏各自资料 + 跨游戏共享审校资料。 */
export const MODELSCOPE_REPOS = Object.freeze({
  official: 'HTiantian/prts-agent-corpus-arknights-gamedata',
  endfield: 'HTiantian/prts-agent-corpus-endfield',
  community: 'HTiantian/prts-agent-corpus-selfbuilt',
})

/**
 * ModelScope 按资料所有权分仓。只更新终末地时，未变化的明日方舟与共享包
 * 不复制到新 release 目录，而是继续引用其最后一次已发布清单。组合关系
 * 必须显式固定，不能按“各仓最新”猜测，否则并发发布时会拼出未经审核的版本。
 */
export const MODELSCOPE_RELEASE_COMPOSITIONS = Object.freeze({
  'agent-corpus-v2-20260903-xuesong-youmeng-v1': Object.freeze({
    dataVersion: '77df7c534525256af1dd36b68128cdd878ac2f3bc109636c5051fa85dd3dae09',
    releases: Object.freeze({
      official: 'agent-corpus-v1-20260826-timeline-v1',
      endfield: 'agent-corpus-v2-20260903-xuesong-youmeng-v1',
      community: 'agent-corpus-v1-20260826-timeline-v1',
    }),
  }),
})

/** 默认 pin 的 release（站点已发布；ModelScope 未就绪时自动回退站点源）。 */
export const DEFAULT_RELEASE_ID = 'agent-corpus-v2-20260903-xuesong-youmeng-v1'

export const DEFAULT_SITE_BASE_URL = 'https://prts.chat'

/**
 * release id 白名单：必须以字母/数字开头，禁止路径分隔符与纯点号段（"."、
 * ".." 会被直接拒绝），避免 releaseId 拼进 releasesDir 后逃逸到上级目录
 * （ui.js 的 delete 路由会对该目录执行递归删除）。
 */
export const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const PACK_IDS = ['official_game', 'endfield_official_game', 'endfield_reviewed_knowledge',
  'reviewed_wiki', 'terra_journey', 'entities', 'references']
const ASSET_PATH_PATTERN = /^(?:shards\/[A-Za-z0-9._-]+\.jsonl|search-index\/[A-Za-z0-9._-]+\.bin)\.gz$/
const MODELSCOPE_FILE_PATTERN = (releaseId) =>
  new RegExp(`^releases/${releaseId}/(?:${PACK_IDS.join('|')})/(?:pack-manifest\\.json|(?:shards/[A-Za-z0-9._-]+\\.jsonl|search-index/[A-Za-z0-9._-]+\\.bin)\\.gz)$`)

const wait = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds) })

/** 清单类请求的显式超时与响应体大小上限（被劫持源不得用超大清单拖垮内存/磁盘）。 */
const MANIFEST_TIMEOUT_MS = 20_000
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
/** 源未提供 sha256 的文件（站点 pack/release 清单本体）允许的最大体积。 */
const MAX_UNVERIFIED_BYTES = 4 * 1024 * 1024
/**
 * 单文件下载整体超时：慢速滴流的源不应长期占用下载槽位。按体积给足带宽
 * 余量（≥64 KiB/s），下限 60s、上限 15 分钟；体积未知时按 60s 计。
 */
const downloadTimeoutMs = (size) => (Number.isInteger(size) && size > 0
  ? Math.min(15 * 60_000, Math.max(60_000, 60_000 + Math.ceil(size / 65536) * 1000))
  : 60_000)

const isTimeoutError = (error) => error?.name === 'TimeoutError'
  || (error?.name === 'AbortError' && error?.message?.includes('timeout'))

/**
 * 读取锁文件的 (pid, stat)。文件不可读时返回 null。
 */
async function lockState(path) {
  try {
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    const pid = Number.parseInt(String(content).split('\n')[0] ?? '', 10)
    return { pid, info }
  } catch {
    return null
  }
}

const processGone = (pid) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (probe) {
    return probe?.code === 'ESRCH'
  }
}

/**
 * 回收陈旧锁（崩溃残留）：pid 可读、持锁进程不存在（ESRCH）、且锁文件已
 * 静默超过 10s（避开"刚创建还没写入 pid"的竞态）。删除前二次采样——pid
 * 一致且文件未被替换重建（inode/mtime 相同）才执行 rm，把"误删另一个进程
 * 刚取得的新锁"的窗口压缩到两次采样之间；完全消除需要文件系统原子原语，
 * 此处不做更强保证。
 */
async function reclaimStaleLock(path) {
  const before = await lockState(path)
  if (!before || !Number.isInteger(before.pid) || Date.now() - before.info.mtimeMs < 10_000
      || !processGone(before.pid)) return false
  const after = await lockState(path)
  if (!after || !Number.isInteger(after.pid) || after.pid !== before.pid
      || after.info.ino !== before.info.ino || after.info.mtimeMs !== before.info.mtimeMs) return false
  await rm(path, { force: true }).catch(() => {})
  return true
}

async function acquireDownloadLock(releasesDir, releaseId) {
  await mkdir(releasesDir, { recursive: true })
  const path = join(releasesDir, `.download-${releaseId}.lock`)
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(`${process.pid}\n`)
      } catch (error) {
        await handle.close().catch(() => {})
        await rm(path, { force: true }).catch(() => {})
        throw error
      }
      return async () => {
        await handle.close()
        await rm(path, { force: true })
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await reclaimStaleLock(path)) {
        // 持锁进程已不存在：回收陈旧锁后立即重试，崩溃残留不再堵满 30s。
        continue
      }
      if (Date.now() >= deadline) {
        throw new InstallerFault('DOWNLOAD_BUSY', `资料版本 ${releaseId} 正由另一个进程准备`)
      }
      await wait(100)
    }
  }
}

async function currentReleaseReady(releasesDir, requested, requireRelease) {
  try {
    const pointer = JSON.parse(await readFile(join(releasesDir, 'current.json'), 'utf8'))
    const releaseId = String(pointer.release_id ?? '')
    if (!RELEASE_ID_PATTERN.test(releaseId) || (requireRelease && releaseId !== requested)) return false
    const manifest = JSON.parse(await readFile(join(releasesDir, releaseId, 'release-manifest.json'), 'utf8'))
    if (manifest.release_id !== releaseId || !SHA256_PATTERN.test(String(manifest.data_version ?? ''))
        || !Number.isInteger(manifest.document_count) || manifest.document_count <= 0
        || !Array.isArray(manifest.required_packs) || !manifest.required_packs.length
        || !Array.isArray(manifest.packs)) return false
    const packIds = new Set(manifest.packs.map((pack) => String(pack?.pack_id || '')))
    return manifest.required_packs.every((packId) => packIds.has(packId))
  } catch {
    return false
  }
}

export class InstallerFault extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

async function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function fetchJson(url, { fetchImpl, signal }) {
  // 显式超时 + 响应体大小上限：慢速/恶意的清单源不能无限占用下载流程，
  // 也不能借超大清单把进程内存或磁盘当缓冲区。
  const timeoutSignal = AbortSignal.timeout(MANIFEST_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  let response
  try {
    response = await fetchImpl(url, { redirect: 'follow', signal: requestSignal })
  } catch (error) {
    if (signal?.aborted) throw new InstallerFault('CANCELLED', '资料下载已取消')
    if (isTimeoutError(error)) {
      throw new InstallerFault('DOWNLOAD_FAILED', `连接 ${new URL(url).host} 超时（${MANIFEST_TIMEOUT_MS / 1000}s）`)
    }
    throw new InstallerFault('DOWNLOAD_FAILED', `无法连接 ${new URL(url).host}（${error?.message ?? error}）`)
  }
  if (!response.ok) {
    const code = response.status === 404 ? 'RELEASE_NOT_FOUND'
      : response.status === 403 ? 'ACCESS_DENIED' : 'DOWNLOAD_FAILED'
    throw new InstallerFault(code, `请求失败 HTTP ${response.status}: ${url}`)
  }
  const declared = Number(response.headers?.get?.('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
    throw new InstallerFault('INVALID_MANIFEST', `清单超过大小上限（${MAX_MANIFEST_BYTES} 字节）: ${url}`)
  }
  let text
  try {
    const bytes = await readBounded(response, MAX_MANIFEST_BYTES, url)
    text = bytes.toString('utf8')
  } catch (error) {
    if (signal?.aborted) throw new InstallerFault('CANCELLED', '资料下载已取消')
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new InstallerFault('INVALID_MANIFEST', `返回的不是有效 JSON: ${url}`)
  }
}

/** 读取响应体到大小上限为止；超出即中止接收并报错。返回 Buffer（可直接按 utf8 解码）。 */
async function readBounded(response, maxBytes, url) {
  const reader = response.body?.getReader?.()
  if (!reader) {
    // 无流式 body 的实现（测试桩 / 旧运行时）：优先 text()，其次 arrayBuffer()。
    const bytes = typeof response.text === 'function'
      ? Buffer.from(await response.text(), 'utf8')
      : Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) {
      throw new InstallerFault('INVALID_MANIFEST', `响应超过大小上限（${maxBytes} 字节）: ${url}`)
    }
    return bytes
  }
  const chunks = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new InstallerFault('INVALID_MANIFEST', `响应超过大小上限（${maxBytes} 字节）: ${url}`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, received)
}

/**
 * 下载一个文件到临时路径，按清单校验（sha256 为空表示该源未提供哈希，仅落盘），
 * 校验通过后原子改名。网络错误（含超时）重试一次。
 * 正文流式落盘：先按 Content-Length 预检大小，超限立即中止接收；哈希在
 * 数据流经时增量计算，任何时刻都不在内存里缓存整个文件。
 * 清单未提供 size 的文件（站点 pack/release 清单本体）以 MAX_UNVERIFIED_BYTES
 * 为字节上限——无哈希锚点的下载不能无限写盘。
 */
async function downloadVerified(url, targetPath, expected, env) {
  const attempt = async (retry) => {
    const tempPath = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    const timeoutMs = downloadTimeoutMs(expected.size ?? null)
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const requestSignal = env.signal
      ? AbortSignal.any([env.signal, timeoutSignal]) : timeoutSignal
    const sizeLimit = expected.size ?? MAX_UNVERIFIED_BYTES
    let handle = null
    try {
      const response = await env.fetchImpl(url, { redirect: 'follow', signal: requestSignal })
      if (!response.ok) {
        throw new InstallerFault('DOWNLOAD_FAILED', `下载失败 HTTP ${response.status}: ${url}`)
      }
      const declared = Number(response.headers?.get?.('content-length') ?? NaN)
      if (expected.size != null && Number.isFinite(declared) && declared !== expected.size) {
        throw new InstallerFault('CHECKSUM_MISMATCH',
          `${url} 大小不符（期望 ${expected.size}，Content-Length ${declared}）`)
      }
      if (expected.size == null && Number.isFinite(declared) && declared > sizeLimit) {
        throw new InstallerFault('DOWNLOAD_FAILED',
          `${url} 超过未校验文件大小上限（${sizeLimit} 字节）`)
      }
      await mkdir(dirname(targetPath), { recursive: true })
      handle = await open(tempPath, 'wx', 0o600)
      const hash = expected.sha256 ? createHash('sha256') : null
      let received = 0
      const overLimit = () => expected.size != null
        ? new InstallerFault('CHECKSUM_MISMATCH',
          `${url} 大小不符（期望 ${expected.size}，已接收 ${received}）`)
        : new InstallerFault('DOWNLOAD_FAILED',
          `${url} 超过未校验文件大小上限（${sizeLimit} 字节，已接收 ${received}）`)
      const reader = response.body?.getReader?.()
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > sizeLimit) {
            await reader.cancel().catch(() => {})
            throw overLimit()
          }
          await handle.write(value)
          hash?.update(value)
        }
      } else {
        // 无流式 body 的实现（测试桩 / 旧运行时）：退回整段缓冲。
        const bytes = new Uint8Array(await response.arrayBuffer())
        received = bytes.byteLength
        if (expected.size != null && received !== expected.size) {
          throw new InstallerFault('CHECKSUM_MISMATCH',
            `${url} 大小不符（期望 ${expected.size}，得到 ${received}）`)
        }
        if (expected.size == null && received > sizeLimit) throw overLimit()
        await handle.write(bytes)
        hash?.update(bytes)
      }
      if (expected.size != null && received !== expected.size) {
        throw new InstallerFault('CHECKSUM_MISMATCH',
          `${url} 大小不符（期望 ${expected.size}，得到 ${received}）`)
      }
      if (hash && hash.digest('hex') !== expected.sha256) {
        throw new InstallerFault('CHECKSUM_MISMATCH', `${url} sha256 不符`)
      }
      await handle.close()
      handle = null
      await rename(tempPath, targetPath)
      return received
    } catch (error) {
      if (handle) await handle.close().catch(() => {})
      await rm(tempPath, { force: true })
      if (env.signal?.aborted) throw error
      if (error instanceof InstallerFault) throw error
      // 网络错误（含显式超时）重试一次；最终失败时把超时转成可读错误。
      if (!retry) {
        throw isTimeoutError(error)
          ? new InstallerFault('DOWNLOAD_FAILED',
            `下载超时（${Math.round(timeoutMs / 1000)}s）: ${url}`)
          : error
      }
      return attempt(retry - 1)
    }
  }
  return attempt(1)
}

const requirePackId = (packId) => {
  if (!PACK_IDS.includes(packId)) throw new InstallerFault('INVALID_MANIFEST', `pack_id 非法: ${packId}`)
  return packId
}

/** ---- 源 1：ModelScope dataset-manifest ---- */

/**
 * 从 ModelScope 解析当前最新 release：tree API 列举 releases/ 目录取字典序
 * 最大 id，再读该 id 的 dataset-manifest 拿 data_version。让「检查更新 /
 * 下载最新」完全不必访问本站。ModelScope 不可用或响应异常时返回 null，
 * 由调用方回退站点源。
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [env]
 * @returns {Promise<{ releaseId: string, dataVersion: string | null } | null>}
 */
export async function resolveModelScopeCurrentRelease(env = {}) {
  const { fetchImpl = fetch, signal } = env
  const ids = new Set()
  for (const repo of Object.values(MODELSCOPE_REPOS)) {
    try {
      const listing = await fetchJson(
        `https://modelscope.cn/api/v1/datasets/${repo}/repo/tree?Revision=master&Root=releases`,
        { fetchImpl, signal })
      for (const entry of listing?.Data?.Files ?? []) {
        // 只认目录项（Type 'tree'；缺省时按目录对待），releases/ 根下的
        // README 等文件不会被误认成 release id。
        if (entry?.Type && entry.Type !== 'tree') continue
        const match = /^releases\/([A-Za-z0-9._-]+)(?:\/|$)/.exec(String(entry?.Path ?? ''))
        if (match && RELEASE_ID_PATTERN.test(match[1])) ids.add(match[1])
      }
    } catch { /* 单仓不可用跳过；全部失败时下方返回 null 由调用方回退站点 */ }
  }
  const latest = [...ids].sort().at(-1)
  if (!latest) return null
  const composition = MODELSCOPE_RELEASE_COMPOSITIONS[latest]
  if (composition) return { releaseId: latest, dataVersion: composition.dataVersion }
  let dataVersion = null
  try {
    const manifest = await fetchJson(
      `https://modelscope.cn/datasets/${MODELSCOPE_REPOS.official}/resolve/master/releases/${latest}/dataset-manifest.json`,
      { fetchImpl, signal })
    const version = String(manifest?.data_version ?? '')
    if (SHA256_PATTERN.test(version)) dataVersion = version
  } catch { /* data_version 缺失不致命：仅无法比对版本号 */ }
  return { releaseId: latest, dataVersion }
}

async function listFromModelScope(releaseId, env) {
  const plans = []
  const composition = MODELSCOPE_RELEASE_COMPOSITIONS[releaseId]
  let dataVersion = composition?.dataVersion ?? null
  for (const group of ['official', 'endfield', 'community']) {
    const repo = MODELSCOPE_REPOS[group]
    const sourceReleaseId = composition?.releases?.[group] ?? releaseId
    let manifest
    try {
      manifest = await fetchJson(
        `https://modelscope.cn/datasets/${repo}/resolve/master/releases/${sourceReleaseId}/dataset-manifest.json`, env)
    } catch (error) {
      // 新增终末地分仓前发布的历史 release 只有两个镜像；继续允许安装。
      if (group === 'endfield' && error?.code === 'RELEASE_NOT_FOUND') continue
      throw error
    }
    if (manifest?.kind !== 'prts-agent-modelscope-dataset-mirror' || manifest?.schema_version !== 1
      || String(manifest?.release_id ?? '') !== sourceReleaseId) {
      throw new InstallerFault('INVALID_MANIFEST', `${repo} 的 dataset-manifest 与 release 不匹配`)
    }
    const version = String(manifest?.data_version ?? '')
    if (!SHA256_PATTERN.test(version)) {
      throw new InstallerFault('INVALID_MANIFEST', `${repo} 的 dataset-manifest data_version 非法`)
    }
    if (dataVersion === null) dataVersion = version
    else if (!composition && dataVersion !== version) {
      throw new InstallerFault('INVALID_MANIFEST', 'ModelScope 分仓的 dataset-manifest data_version 不一致')
    }
    const files = manifest?.files
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      throw new InstallerFault('INVALID_MANIFEST', `${repo} 的 dataset-manifest 缺少 files`)
    }
    const keyPattern = MODELSCOPE_FILE_PATTERN(sourceReleaseId)
    const sourcePrefix = `releases/${sourceReleaseId}/`
    for (const [key, descriptor] of Object.entries(files)) {
      if (!keyPattern.test(key)) {
        throw new InstallerFault('INVALID_MANIFEST', `文件清单包含非法路径: ${key}`)
      }
      const sha256 = String(descriptor?.sha256 ?? '')
      const size = Number(descriptor?.size ?? NaN)
      if (!SHA256_PATTERN.test(sha256) || !Number.isInteger(size) || size < 0 || size > 2 ** 31) {
        throw new InstallerFault('INVALID_MANIFEST', `文件描述非法: ${key}`)
      }
      plans.push({
        relativePath: key.slice(sourcePrefix.length),
        sha256, size,
        url: `https://modelscope.cn/datasets/${repo}/resolve/master/${key}`,
      })
    }
  }
  if (!plans.length) throw new InstallerFault('INVALID_MANIFEST', 'ModelScope 文件清单为空')
  return { dataVersion, entries: plans }
}

/** ---- 源 2：PRTS.chat 站点（与浏览器前端同源） ---- */

async function listFromSite(releaseId, env, siteBaseUrl) {
  const base = siteBaseUrl.replace(/\/+$/, '')
  const url = (path) => `${base}/api/agent/data/releases/${releaseId}/${path}`
  const releaseManifest = await fetchJson(url('release-manifest.json'), env)
  const dataVersion = String(releaseManifest?.data_version ?? '')
  if (!SHA256_PATTERN.test(dataVersion) || String(releaseManifest?.release_id ?? '') !== releaseId) {
    throw new InstallerFault('INVALID_MANIFEST', '站点 release-manifest 与请求的 release 不匹配')
  }
  const packs = releaseManifest?.packs
  if (!Array.isArray(packs) || !packs.length) {
    throw new InstallerFault('INVALID_MANIFEST', '站点 release-manifest packs 为空')
  }
  const entries = []
  for (const pack of packs) {
    const packId = requirePackId(String(pack?.pack_id ?? ''))
    const manifestPath = String(pack?.manifest_path ?? '')
    if (manifestPath !== `${packId}/pack-manifest.json`) {
      throw new InstallerFault('INVALID_MANIFEST', `pack manifest_path 非法: ${manifestPath}`)
    }
    const packManifest = await fetchJson(url(manifestPath), env)
    if (String(packManifest?.pack_id ?? packId) !== packId) {
      throw new InstallerFault('INVALID_MANIFEST', `站点 pack-manifest pack_id 不符: ${packId}`)
    }
    // pack-manifest 本体：源未提供哈希（sha256 置空，仅落盘），分片按清单哈希校验
    entries.push({ relativePath: manifestPath, sha256: null, size: null, url: url(manifestPath) })
    const shards = [
      ...(Array.isArray(packManifest.shards) ? packManifest.shards : []),
      ...(Array.isArray(packManifest.search_index?.shards) ? packManifest.search_index.shards : []),
    ]
    for (const shard of shards) {
      const path = String(shard?.path ?? '')
      const sha256 = String(shard?.sha256 ?? '')
      const size = Number(shard?.compressed_size ?? NaN)
      if (!ASSET_PATH_PATTERN.test(path) || !SHA256_PATTERN.test(sha256)
        || !Number.isInteger(size) || size < 0 || size > 2 ** 31) {
        throw new InstallerFault('INVALID_MANIFEST', `分片描述非法: ${packId}/${path}`)
      }
      entries.push({ relativePath: `${packId}/${path}`, sha256, size, url: url(`${packId}/${path}`) })
    }
  }
  if (!entries.length) throw new InstallerFault('INVALID_MANIFEST', '站点文件清单为空')
  return { dataVersion, entries }
}

/** ---- 主流程 ---- */

/**
 * 确保本地资料就绪：current.json 已存在则直接返回；否则按 order 顺序从各源下载。
 * @param {{ releasesDir: string, releaseId?: string, order?: ('modelscope'|'site')[],
 *           siteBaseUrl?: string, fetchImpl?: typeof fetch, signal?: AbortSignal,
 *           logger?: { info?: Function, warn?: Function }, requireRelease?: boolean,
 *           onProgress?: (state: { phase: 'listing'|'downloading'|'done', source: string,
 *             releaseId: string, filesDone: number, filesTotal: number|null, bytesDone: number }) => void }} options
 * @returns {Promise<{ status: 'present' | 'downloaded', releaseId?: string, source?: string, files?: number, bytes?: number }>}
 */
export async function ensureCorpusRelease(options) {
  const { releasesDir, signal, logger } = options
  const onProgress = options.onProgress
  const releaseId = options.releaseId ?? DEFAULT_RELEASE_ID
  if (!RELEASE_ID_PATTERN.test(releaseId)) throw new InstallerFault('INVALID_REQUEST', 'releaseId 非法')
  const fetchImpl = options.fetchImpl ?? fetch
  const env = { fetchImpl, signal }
  const siteBaseUrl = options.siteBaseUrl ?? DEFAULT_SITE_BASE_URL
  const order = options.order ?? ['modelscope', 'site']
  if (!Array.isArray(order) || order.length === 0 || new Set(order).size !== order.length
    || order.some((source) => source !== 'modelscope' && source !== 'site')) {
    throw new InstallerFault('INVALID_REQUEST', 'download order 非法')
  }

  // 1) 本地已就绪：不碰网络
  if (await currentReleaseReady(releasesDir, releaseId, options.requireRelease === true)) {
    return { status: 'present' }
  }

  const releaseLock = await acquireDownloadLock(releasesDir, releaseId)
  try {
    if (await currentReleaseReady(releasesDir, releaseId, options.requireRelease === true)) {
      return { status: 'present' }
    }

    const releaseDir = join(releasesDir, releaseId)
    let lastError = null
    for (const source of order) {
      if (signal?.aborted) throw new InstallerFault('CANCELLED', '资料下载已取消')
      try {
      const listing = source === 'site'
        ? await listFromSite(releaseId, env, siteBaseUrl)
        : await listFromModelScope(releaseId, env)

      // 2) 跳过已校验文件，其余小并发下载
      const pending = []
      for (const entry of listing.entries) {
        const targetPath = join(releaseDir, entry.relativePath)
        try {
          const existing = await stat(targetPath)
          if (entry.sha256) {
            // 哈希与大小都一致 → 已就绪跳过；否则重新下载覆盖
            if (existing.size === entry.size && await sha256File(targetPath) === entry.sha256) continue
          } else if (existing.size > 0) {
            continue // 源未提供哈希的清单文件：已存在即跳过
          }
        } catch { /* 不存在 → 下载 */ }
        pending.push(entry)
      }
      if (pending.length) {
        logger?.info?.(`prts-corpus: 从 ${source === 'site' ? siteBaseUrl : 'ModelScope'} 下载 ${releaseId}`
          + `（${pending.length}/${listing.entries.length} 个文件待取，data_version=${listing.dataVersion.slice(0, 12)}…）`)
      }
      const queue = [...pending]
      let files = 0
      let bytes = 0
      // 任一 worker 失败后置位：其余 worker 完成手头文件即停止取新任务，
      // 不再产生与回退源并发写盘的孤儿下载。
      let failure = null
      onProgress?.({ phase: 'downloading', source, releaseId,
        filesDone: 0, filesTotal: pending.length, bytesDone: 0 })
      const worker = async () => {
        for (;;) {
          if (failure || signal?.aborted) return
          const entry = queue.shift()
          if (!entry) return
          try {
            bytes += await downloadVerified(entry.url, join(releaseDir, entry.relativePath),
              { sha256: entry.sha256, size: entry.size }, env)
          } catch (error) {
            failure = error
            return
          }
          files += 1
          onProgress?.({ phase: 'downloading', source, releaseId,
            filesDone: files, filesTotal: pending.length, bytesDone: bytes })
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker))
      if (failure) throw failure
      if (signal?.aborted) throw new InstallerFault('CANCELLED', '资料下载已取消')
      onProgress?.({ phase: 'done', source, releaseId, filesDone: files,
        filesTotal: pending.length, bytesDone: bytes })

      // 3) release-manifest.json（缺失则按清单 data_version 生成）与 current.json 指针
      const packs = [...new Set(listing.entries.map((entry) => entry.relativePath.split('/')[0]))]
        .filter((packId) => PACK_IDS.includes(packId))
        .map((packId) => ({ pack_id: packId, manifest_path: `${packId}/pack-manifest.json` }))
      const packManifests = await Promise.all(packs.map(async (pack) => JSON.parse(await readFile(
        join(releaseDir, pack.manifest_path), 'utf8'))))
      const sumIntegerField = (field) => packManifests.reduce((sum, pack) =>
        sum + (Number.isInteger(pack[field]) ? pack[field] : 0), 0)
      await mkdir(releaseDir, { recursive: true })
      const releaseManifestPath = join(releaseDir, 'release-manifest.json')
      let releaseManifestValid = false
      try {
        const existingManifest = JSON.parse(await readFile(releaseManifestPath, 'utf8'))
        releaseManifestValid = existingManifest.release_id === releaseId
          && existingManifest.data_version === listing.dataVersion
          && Number.isInteger(existingManifest.document_count) && existingManifest.document_count > 0
          && Array.isArray(existingManifest.required_packs) && existingManifest.required_packs.length > 0
      } catch { /* 缺失或旧版清单：下方原子替换 */ }
      if (!releaseManifestValid) {
        const manifestTemp = `${releaseManifestPath}.${randomBytes(6).toString('hex')}.tmp`
        await writeFile(manifestTemp, JSON.stringify({
          algorithm: 'prts-browser-corpus-release-v1',
          release_id: releaseId, data_version: listing.dataVersion,
          schema_version: 1, source, packs,
          required_packs: packs.map((pack) => pack.pack_id),
          document_count: sumIntegerField('document_count'),
          line_count: sumIntegerField('line_count'),
          compressed_size: sumIntegerField('compressed_size'),
        }, null, 2))
        await rename(manifestTemp, releaseManifestPath)
      }
      const pointerTemp = join(releasesDir, `current.json.${randomBytes(6).toString('hex')}.tmp`)
      await writeFile(pointerTemp, JSON.stringify({
        release_id: releaseId, data_version: listing.dataVersion,
        channel: source, public_download: true, schema_version: 1,
        downloaded_at: new Date().toISOString(),
      }))
      await rename(pointerTemp, join(releasesDir, 'current.json'))
      logger?.info?.(`prts-corpus: 资料包就绪 ${releaseId}（源=${source}，新下载 ${files} 个文件，${Math.round(bytes / 1048576)} MiB）`)
      return { status: 'downloaded', releaseId, source, files, bytes }
      } catch (error) {
        lastError = error
        logger?.warn?.(`prts-corpus: ${source} 源失败（${error?.code ?? 'ERROR'}: ${error?.message ?? error}）`)
      }
    }
    throw lastError ?? new InstallerFault('DOWNLOAD_FAILED', '没有可用的下载源')
  } finally {
    await releaseLock()
  }
}
