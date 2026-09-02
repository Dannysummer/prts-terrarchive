/**
 * 设置界面的 Host 半边：通过 Host Connection 的认证 RPC 通道
 * 挂载资料管理能力，供浏览器设置 tab 调用。
 *
 * 纯路由逻辑抽成 buildApi()（方法+路径+体 → {status, json}），
 * Connection 统一处理 Host/Origin/cookie 认证和 RPC 包络，便于无网络单测。
 *
 * 路由一览：
 *   GET  /api/prts-corpus/status    当前版本/文档数/下载进度/生效配置（脱敏）
 *   GET  /api/prts-corpus/releases  本地已装 release 清单（大小/版本/是否激活/需解压）
 *   GET  /api/prts-corpus/check-update  联网检查站点是否有更新版本（本地/远程对比）
 *   POST /api/prts-corpus/download  触发下载 { releaseId? | useSiteCurrent? }
 *   POST /api/prts-corpus/activate  切换激活版本 { releaseId }（热重载 store）
 *   POST /api/prts-corpus/delete    删除非当前版本 { releaseId }
 *   GET  /api/prts-corpus/config    生效配置 + 用户层（脱敏）
 *   PUT  /api/prts-corpus/config    写配置补丁（立即生效，cloud 工具热重建）
 */
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureCorpusRelease, RELEASE_ID_PATTERN, resolveModelScopeCurrentRelease } from './installer.js'
import { redactConfig } from './state.js'
import { executeRead } from './read.js'

const MAX_BODY_BYTES = 1024 * 1024
const ENDFIELD_MAP_ROOT = resolve(fileURLToPath(new URL('../lib/endfield-map/', import.meta.url)))
const ENDFIELD_MAP_MIME = Object.freeze({
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
})

/**
 * 静态回传地图资源。文本类（.js/.json）在包内以 .br/.gz 预压缩副本存放
 * （bin/pack-map-assets.mjs，与 endfield.prts.chat 同一压缩方法）：按请求
 * Accept-Encoding 直接回传对应编码 + Content-Encoding 头，浏览器透明解压，
 * 服务端零解压开销。开发态存在明文原件时自动回退。
 */
async function serveEndfieldMapAsset(req, res, routePrefix) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.invalid').pathname)
  } catch {
    // WHATWG URL 会原样保留非法百分号序列（如 %E4%A6），decodeURIComponent
    // 对其抛 URIError；这是畸形请求而非服务器故障，按 400 结束。
    res.writeHead(400)
    res.end()
    return
  }
  const relative = pathname.slice(routePrefix.length).replace(/^\/+/, '')
  const target = resolve(normalize(join(ENDFIELD_MAP_ROOT, relative)))
  if (target !== ENDFIELD_MAP_ROOT && !target.startsWith(ENDFIELD_MAP_ROOT + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  const accept = String(req.headers?.['accept-encoding'] ?? '')
  const textAsset = /\.(js|json)$/.test(target)
  const variant = textAsset && accept.includes('br') ? '.br'
    : textAsset && accept.includes('gzip') ? '.gz' : ''
  const servePath = variant ? `${target}${variant}` : target
  try {
    const body = await readFile(servePath)
    res.writeHead(200, {
      'content-type': ENDFIELD_MAP_MIME[extname(textAsset ? target : servePath)] ?? 'application/octet-stream',
      ...(variant ? { 'content-encoding': variant === '.br' ? 'br' : 'gzip' } : {}),
      'cache-control': target.endsWith('map.js') ? 'no-cache' : 'public, max-age=31536000, immutable',
      vary: 'accept-encoding',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch (error) {
    if (error?.code === 'ENOENT' && variant) {
      // 压缩副本缺失（未跑 pack 脚本的开发目录）→ 回退明文原件。
      try {
        const body = await readFile(target)
        res.writeHead(200, {
          'content-type': ENDFIELD_MAP_MIME[extname(target)] ?? 'application/octet-stream',
          'cache-control': target.endsWith('map.js') ? 'no-cache' : 'public, max-age=31536000, immutable',
        })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      } catch (fallbackError) {
        error = fallbackError
      }
    }
    if (error?.code !== 'ENOENT' && error?.code !== 'EISDIR' && error?.code !== 'ENOTDIR') throw error
    res.writeHead(404)
    res.end()
  }
}

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const releaseDirSize = async (dir) => {
  let total = 0
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) total += (await stat(child)).size
    }
  }
  await walk(dir)
  return total
}

async function readLocalReleases(shared, sizeCache = new Map()) {
  const releases = []
  let activeId = null
  try {
    activeId = JSON.parse(await readFile(join(shared.releasesDir, 'current.json'), 'utf8')).release_id
  } catch { /* 尚无激活版本 */ }
  let entries = []
  try {
    entries = await readdir(shared.releasesDir, { withFileTypes: true })
  } catch { return { activeId, releases } }
  for (const entry of entries) {
    if (!entry.isDirectory() || !RELEASE_ID_PATTERN.test(entry.name)) continue
    const dir = join(shared.releasesDir, entry.name)
    let manifest = null
    try {
      manifest = JSON.parse(await readFile(join(dir, 'release-manifest.json'), 'utf8'))
    } catch { /* 半成品/外来目录：仍列出，标记不完整 */ }
    let sizeBytes = sizeCache.get(entry.name)
    if (sizeBytes === undefined) {
      sizeBytes = await releaseDirSize(dir).catch(() => 0)
      if (manifest) sizeCache.set(entry.name, sizeBytes)
    }
    releases.push({
      releaseId: entry.name,
      active: entry.name === activeId,
      complete: Boolean(manifest),
      dataVersion: manifest?.data_version ?? null,
      documentCount: manifest?.document_count ?? null,
      compressedSize: manifest?.compressed_size ?? null,
      createdAt: manifest?.created_at ?? null,
      sizeBytes,
      needsExtract: true, // 本地分片以 .jsonl.gz 存储，打开时需解压
    })
  }
  releases.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
  return { activeId, releases }
}

/**
 * 检查是否有更新版本。首选 ModelScope（files API + dataset-manifest），
 * 本站仅在 ModelScope 不可达时作回退——站不可达不视为错误，返回可读说明。
 * @param {ReturnType<import('./state.js').createSharedState>} shared
 * @param {{ fetchImpl?: typeof fetch }} [env]
 */
async function checkForUpdate(shared, env = {}, sizeCache) {
  const fetchImpl = env.fetchImpl ?? fetch
  const base = shared.effective().downloadSiteBaseUrl.replace(/\/+$/, '')
  const local = await readLocalReleases(shared, sizeCache)
  const localRelease = local.releases.find((release) => release.active)
  const localInfo = {
    releaseId: local.activeId ?? null,
    dataVersion: localRelease?.dataVersion ?? null,
    documentCount: localRelease?.documentCount ?? null,
    sizeBytes: localRelease?.sizeBytes ?? null,
  }
  try {
    const resolved = await resolveModelScopeCurrentRelease({ fetchImpl,
      signal: AbortSignal.timeout(20_000) })
    if (resolved) {
      return { source: 'modelscope', local: localInfo,
        remote: { releaseId: resolved.releaseId, dataVersion: resolved.dataVersion,
          documentCount: null, compressedSize: null, createdAt: null },
        updateAvailable: local.activeId !== resolved.releaseId }
    }
  } catch { /* ModelScope 不可达 → 回退站点 */ }
  try {
    const response = await fetchImpl(`${base}/api/agent/data/releases/current`,
      { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) {
      return { source: null, local: localInfo, remote: null, updateAvailable: false,
        error: `站点 current 查询失败 HTTP ${response.status}` }
    }
    const payload = await response.json()
    const remoteId = String(payload?.data?.release_id ?? '')
    if (!remoteId) {
      return { source: null, local: localInfo, remote: null, updateAvailable: false,
        error: '站点没有返回当前版本' }
    }
    const manifestRes = await fetchImpl(
      `${base}/api/agent/data/releases/${encodeURIComponent(remoteId)}/release-manifest.json`,
      { signal: AbortSignal.timeout(20_000) })
    const manifest = manifestRes.ok ? await manifestRes.json().catch(() => null) : null
    const remote = {
      releaseId: remoteId,
      dataVersion: manifest?.data_version ?? null,
      documentCount: manifest?.document_count ?? null,
      compressedSize: manifest?.compressed_size ?? null,
      createdAt: manifest?.created_at ?? null,
    }
    const updateAvailable = local.activeId !== remoteId
    return { source: 'site', local: localInfo, remote, updateAvailable }
  } catch (error) {
    return { source: null, local: localInfo, remote: null, updateAvailable: false,
      error: `检查更新失败：${error?.message ?? error}` }
  }
}

/**
 * 构建纯 API 核心。
 * @param {ReturnType<import('./state.js').createSharedState>} shared
 * @param {{ logger?: object }} [env]
 */
export function buildApi(shared, env = {}) {
  const sizeCache = new Map()
  const fetchImpl = env.fetchImpl ?? fetch
  const startDownload = async ({ releaseId, useSiteCurrent }) => {
    const progress = shared.download
    if (progress.active) throw new ApiError(409, '已有下载任务在进行中')
    // 目标解析包含最长数十秒的网络请求；下载槽位必须在首个 await 之前同步
    // 占用，否则两次并发 POST /download 都能通过 409 检查并发起双任务。
    progress.active = true
    progress.phase = 'listing'
    progress.source = null
    progress.releaseId = null
    progress.filesDone = 0
    progress.filesTotal = null
    progress.bytesDone = 0
    progress.error = null
    progress.finishedAt = null
    shared.notifyRuntime()
    const releaseSlot = () => {
      progress.active = false
      progress.phase = 'idle'
      progress.finishedAt = new Date().toISOString()
      shared.notifyRuntime()
    }
    let target
    try {
      target = releaseId ? String(releaseId) : null
      // 默认下载最新：优先经 ModelScope 解析当前 release，本站仅在 ModelScope
      // 不可用时回退；useSiteCurrent 为显式强制站点。
      if (!target && !useSiteCurrent) {
        try {
          const resolved = await resolveModelScopeCurrentRelease({ fetchImpl,
            signal: AbortSignal.timeout(20_000) })
          if (resolved) target = resolved.releaseId
        } catch { /* ModelScope 不可达 → 回退站点 current */ }
      }
      if (!target) {
        const base = shared.effective().downloadSiteBaseUrl.replace(/\/+$/, '')
        const response = await fetchImpl(`${base}/api/agent/data/releases/current`, { signal: AbortSignal.timeout(15_000) })
        if (!response.ok) throw new ApiError(502, `站点 current 查询失败 HTTP ${response.status}`)
        const payload = await response.json()
        target = String(payload?.data?.release_id ?? '')
      }
      if (!target) target = shared.effective().downloadReleaseId
      if (!RELEASE_ID_PATTERN.test(target)) throw new ApiError(400, 'releaseId 非法')
    } catch (error) {
      releaseSlot()
      throw error
    }
    progress.releaseId = target
    shared.notifyRuntime()

    // 后台执行；结果写回 shared.download，界面轮询 status 跟踪
    void (async () => {
      try {
        const config = shared.effective()
        const result = await ensureCorpusRelease({
          releasesDir: shared.releasesDir,
          releaseId: target,
          order: config.downloadOrder,
          siteBaseUrl: config.downloadSiteBaseUrl,
          requireRelease: true,
          fetchImpl,
          logger: env.logger,
          onProgress: (update) => {
            progress.phase = update.phase
            progress.source = update.source
            progress.filesDone = update.filesDone
            progress.filesTotal = update.filesTotal
            progress.bytesDone = update.bytesDone
          },
        })
        progress.phase = result.status === 'present' ? 'present' : 'done'
        sizeCache.delete(target)
        // 新版本就绪 → 热重载 store（若当前激活版本变了）
        if (shared.store) {
          try {
            const pointer = JSON.parse(await readFile(join(shared.releasesDir, 'current.json'), 'utf8'))
            if (pointer.release_id !== shared.store.releaseId) {
              shared.store.reset()
            }
          } catch { /* current.json 异常时保持现状 */ }
        }
      } catch (error) {
        progress.phase = 'error'
        progress.error = `${error?.code ?? 'ERROR'}: ${error?.message ?? error}`
        env.logger?.warn?.(`prts-corpus: 下载失败 ${progress.error}`)
      } finally {
        progress.active = false
        progress.finishedAt = new Date().toISOString()
        shared.notifyRuntime()
      }
    })()
    return { started: true, releaseId: target }
  }

  /** 原始路由分发：ApiError/配置校验错误转为响应，其余向上抛给 HTTP 层。 */
  const routeCall = async (method, pathname, body) => {
    const route = pathname.replace(/^\/api\/prts-corpus\/?/, '').split('?')[0]
    // 「点开证据卡 → 读全文」：用与工具一致的 executeRead 拉取目标原文/实体资料。
    // 仅接受 source_ref / document_id 定位，复用同一套契约与数据版本校验。
    if (method === 'POST' && route === 'read') {
      const store = shared.store
      if (!store?.loaded) throw new ApiError(409, '本地资料尚未就绪')
      const locator = body?.locator
      const selection = body?.selection ?? { mode: 'document' }
      if (!locator || typeof locator !== 'object') throw new ApiError(400, '缺少定位器')
      const hasReadLocator = Boolean(locator.source_ref || locator.document_id)
      const hasActivityLocator = Boolean(locator.activity_id || locator.activity_name)
      if (selection.mode === 'activity' ? !hasActivityLocator : !hasReadLocator) {
        throw new ApiError(400, selection.mode === 'activity'
          ? 'activity 定位需提供 activity_id / activity_name'
          : '定位器需提供 source_ref / document_id')
      }
      // 限制值夹到契约允许的范围，避免客户端传入超限值导致 executeRead 直接报错。
      const clampInt = (value, min, max, fallback) => {
        const n = Number(value)
        if (!Number.isFinite(n)) return fallback
        return Math.min(max, Math.max(min, Math.round(n)))
      }
      const expected = {
        intent_id: `evidence-${Date.now().toString(36)}`,
        ...(body?.data_version ? { expected_data_version: String(body.data_version) } : {}),
        locator,
        selection,
        limits: {
          max_lines: clampInt(body?.max_lines, 1, 500, 500),
          max_chars: clampInt(body?.max_chars, 100, 100000, 100000),
        },
      }
      const result = await executeRead(store, expected, { logger: env.logger })
      if (result.status !== 'ok') {
        return { status: 200, json: { ok: false, error: result.error } }
      }
      return { status: 200, json: { ok: true, response: result } }
    }
    if (method === 'GET' && route === 'status') {
      const store = shared.store
      const ready = Boolean(store?.loaded)
      const config = shared.effective()
      let installed = false
      let installationIssue = null
      try {
        const pointer = JSON.parse(await readFile(join(shared.releasesDir, 'current.json'), 'utf8'))
        const releaseId = String(pointer.release_id || '')
        const manifest = JSON.parse(await readFile(
          join(shared.releasesDir, releaseId, 'release-manifest.json'), 'utf8'))
        installed = Boolean(releaseId && manifest.release_id === releaseId
          && /^[0-9a-f]{64}$/u.test(String(manifest.data_version || '')))
        if (!installed) installationIssue = 'current.json 或 release-manifest.json 内容无效'
      } catch (error) {
        installationIssue = error?.code === 'ENOENT'
          ? '未找到本地语料；请下载资料或检查资料目录配置'
          : `无法读取本地语料配置：${error?.message ?? error}`
      }
      let storeInfo = { loaded: ready, installed, installationIssue,
        releaseId: null, dataVersion: null, documentCount: null, packCount: null }
      if (store && ready && store.releaseId) {
        storeInfo = { ...storeInfo, loaded: true, installed: true, installationIssue: null,
          releaseId: store.releaseId, dataVersion: store.dataVersion,
          documentCount: store.documents.size, packCount: store.packs.size }
      }
      return { status: 200, json: { store: storeInfo, download: { ...shared.download }, config: redactConfig(config) } }
    }
    if (method === 'GET' && route === 'releases') {
      const { activeId, releases } = await readLocalReleases(shared, sizeCache)
      return { status: 200, json: { activeId, releases } }
    }
    if (method === 'GET' && route === 'check-update') {
      return { status: 200, json: await checkForUpdate(shared, env, sizeCache) }
    }
    if (method === 'GET' && route === 'config') {
      return { status: 200, json: { config: redactConfig(shared.effective(), shared.userLayer()), defaultsPresent: true } }
    }
    if (method === 'PUT' && route === 'config') {
      const effective = await shared.saveConfig(body?.patch ?? body)
      return { status: 200, json: { config: redactConfig(effective, shared.userLayer()) } }
    }
    if (method === 'POST' && route === 'download') {
      return { status: 202, json: await startDownload(body ?? {}) }
    }
    if (method === 'POST' && route === 'activate') {
      const releaseId = String(body?.releaseId ?? '')
      if (!RELEASE_ID_PATTERN.test(releaseId)) throw new ApiError(400, 'releaseId 非法')
      const dir = join(shared.releasesDir, releaseId)
      const manifest = JSON.parse(await readFile(join(dir, 'release-manifest.json'), 'utf8'))
      if (manifest.release_id !== releaseId || !/^[0-9a-f]{64}$/.test(String(manifest.data_version ?? ''))) {
        throw new ApiError(400, '版本清单与 releaseId/data_version 不匹配')
      }
      const pointerTemp = join(shared.releasesDir, `current.json.${randomBytes(6).toString('hex')}.tmp`)
      await writeFile(pointerTemp, JSON.stringify({
        release_id: releaseId, data_version: manifest.data_version,
        channel: 'manual', public_download: true, schema_version: 1,
        activated_at: new Date().toISOString(),
      }))
      await rename(pointerTemp, join(shared.releasesDir, 'current.json'))
      shared.store?.reset()
      shared.notifyRuntime()
      env.logger?.info?.(`prts-corpus: 激活版本切换为 ${releaseId}`)
      return { status: 200, json: { activated: releaseId } }
    }
    if (method === 'POST' && route === 'delete') {
      const releaseId = String(body?.releaseId ?? '')
      if (!RELEASE_ID_PATTERN.test(releaseId)) throw new ApiError(400, 'releaseId 非法')
      let activeId = null
      try {
        activeId = JSON.parse(await readFile(join(shared.releasesDir, 'current.json'), 'utf8')).release_id
      } catch { /* 无激活 */ }
      if (releaseId === activeId) throw new ApiError(409, '不能删除当前激活版本')
      if (shared.download.active && shared.download.releaseId === releaseId) {
        throw new ApiError(409, '该版本正在下载')
      }
      await rm(join(shared.releasesDir, releaseId), { recursive: true, force: true })
      sizeCache.delete(releaseId)
      return { status: 200, json: { deleted: releaseId } }
    }
    throw new ApiError(404, `未知路由 ${method} ${pathname}`)
  }

  return {
    async call(method, pathname, body) {
      try {
        return await routeCall(method, pathname, body)
      } catch (error) {
        if (error instanceof ApiError) return { status: error.status, json: { error: error.message } }
        if (error?.code === 'INVALID_CONFIG') return { status: 400, json: { error: error.message } }
        throw error
      }
    },
  }
}

/**
 * 通过 Host Connection 的认证 RPC 通道挂 UI API。Connection 统一执行
 * Host/Origin 信任检查和浏览器 cookie 认证，插件不再绕过 /api 安全边界。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<import('./state.js').createSharedState>} shared
 */
export function applyUi(ctx, shared) {
  const connection = ctx.get?.('connection') ?? ctx.connection
  if (!connection) return false
  const api = buildApi(shared, { logger: ctx.logger })
  const endpoints = Object.freeze({
    status: ['GET', '/api/prts-corpus/status'],
    releases: ['GET', '/api/prts-corpus/releases'],
    'check-update': ['GET', '/api/prts-corpus/check-update'],
    'config.get': ['GET', '/api/prts-corpus/config'],
    'config.update': ['PUT', '/api/prts-corpus/config'],
    download: ['POST', '/api/prts-corpus/download'],
    activate: ['POST', '/api/prts-corpus/activate'],
    delete: ['POST', '/api/prts-corpus/delete'],
    read: ['POST', '/api/prts-corpus/read'],
  })
  // 第三参在 rc.2 宿主上是必填（register 直接读取 options.authority，缺失即
  // TypeError 且整个 applyUi 中断）；更新的宿主忽略该参数，两版都安全。
  connection.rpc.handle('/prts-corpus', async (endpoint, payload) => {
    const route = endpoints[endpoint]
    if (!route) {
      return { ok: false, error: { code: 'not-found', message: `未知 PRTS RPC 端点 ${endpoint}`, details: {} } }
    }
    if (Buffer.byteLength(JSON.stringify(payload ?? {})) > MAX_BODY_BYTES) {
      return { ok: false, error: { code: 'bad-request', message: '请求体过大', details: {} } }
    }
    try {
      const result = await api.call(route[0], route[1], payload ?? {})
      if (result.status >= 400) {
        return { ok: false, error: { code: result.status === 409 ? 'conflict' : 'bad-request',
          message: result.json.error ?? `PRTS API ${result.status}`, details: { status: result.status } } }
      }
      return { ok: true, value: result.json }
    } catch (error) {
      // 不把原始 error.message 回传浏览器（ENOENT 等会携带宿主绝对路径）；
      // 细节写宿主日志即可。
      ctx.logger?.warn?.(`prts-corpus RPC ${endpoint} 失败：${error?.stack ?? error}`)
      return { ok: false, error: { code: 'internal-error',
        message: 'PRTS 内部错误，详情见宿主日志', details: {} } }
    }
  }, { authority: 'loopback' })
  const webServer = ctx.get?.('webServer') ?? ctx.webServer
  if (webServer) {
    ctx.effect(() => {
      const disposeSkin = webServer.register({
        kind: 'exact', path: '/prts-corpus/ui-skin.json',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405); res.end(); return
          }
          const body = Buffer.from(JSON.stringify({ uiSkin: shared.effective().uiSkin }))
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(req.method === 'HEAD' ? undefined : body)
        },
      })
      const disposeBundle = webServer.register({
        kind: 'prefix', path: '/prts-corpus/endfield-map',
        handler: (req, res) => serveEndfieldMapAsset(req, res, '/prts-corpus/endfield-map'),
      })
      const disposeResources = webServer.register({
        kind: 'prefix', path: '/webmap3d/resources',
        handler: (req, res) => serveEndfieldMapAsset(req, res, '/webmap3d'),
      })
      return () => { disposeResources(); disposeBundle(); disposeSkin() }
    }, 'prts-corpus: Endfield map assets')
  }
  ctx.logger?.info?.('prts-corpus: authenticated settings RPC mounted on /prts-corpus')
  return true
}
