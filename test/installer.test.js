/**
 * installer.js 单元测试：双源（ModelScope / 站点）按序回退。
 * 用注入的 fetchImpl 同时伪造两个源，覆盖下载/校验/回退/续传/指针写入，
 * 并用真实 CorpusStore 打开下载结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCorpusRelease, InstallerFault, resolveModelScopeCurrentRelease } from '../src/installer.js'
import { CorpusStore, computeLinesIntegrity } from '../src/store.js'

const RELEASE_ID = 'test-rel-1'
const DATA_VERSION = 'a'.repeat(64)
const SITE = 'https://prts.chat'
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** 构造一个合法的最小文档分片（gzip JSONL，行完整性按 store 规则计算）。 */
function buildShard(documentId, prefix, title, text) {
  const lines = [{ line_number: 1, line_type: 'narration', speaker_raw: '', text }]
  const record = {
    document: { document_id: documentId, source_ref_prefix: prefix, display_title: title,
      document_type: 'reference', document_kind: 'reference', line_count: 1 },
    lines, speakers: [], local_integrity: { algorithm: 'sha256:joined-lines-v1',
      sha256: computeLinesIntegrity(lines) },
  }
  return gzipSync(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))
}

/**
 * 组装双源假服务。
 * 场景开关：modelscope404（ModelScope 无此 release）、corruptModelscope /
 * corruptSite（对应源的分片字节损坏）。
 */
function buildSources({ modelscope404 = false, corruptModelscope = false, corruptSite = false } = {}) {
  const communityShard = buildShard('client:references:abc', 'client_data:references:' + '0'.repeat(24),
    '测试时间线', '黑暗时代·上 1096年12月23日')
  const officialShard = buildShard('official_game:story:t1', 'official_game:story:t1', '测试剧情', '博士走进了房间')
  const corrupted = (bytes) => Buffer.concat([bytes, Buffer.from('x')])

  const packManifests = {
    official_game: {
      pack_id: 'official_game', data_version: 'b'.repeat(64),
      shards: [{ path: 'shards/00000.jsonl.gz', sha256: sha256(officialShard), compressed_size: officialShard.length }],
      search_index: { shards: [] },
    },
    references: {
      pack_id: 'references', data_version: 'c'.repeat(64),
      shards: [{ path: 'shards/00000.jsonl.gz', sha256: sha256(communityShard), compressed_size: communityShard.length }],
      search_index: { shards: [] },
    },
  }
  const packShards = {
    official_game: { 'shards/00000.jsonl.gz': officialShard },
    references: { 'shards/00000.jsonl.gz': communityShard },
  }
  const releaseManifest = {
    release_id: RELEASE_ID, data_version: DATA_VERSION, schema_version: 1,
    packs: [
      { pack_id: 'official_game', manifest_path: 'official_game/pack-manifest.json' },
      { pack_id: 'references', manifest_path: 'references/pack-manifest.json' },
    ],
  }

  const counters = { modelscope: 0, site: 0 }

  const fetchImpl = async (url) => {
    const target = String(url)
    // ---- ModelScope 源 ----
    const modelscopeMatch = /modelscope\.cn\/datasets\/([^/]+\/[^/]+)\/resolve\/master\/(.+)$/.exec(target)
    if (modelscopeMatch) {
      counters.modelscope += 1
      if (modelscope404) return new Response('not found', { status: 404 })
      const [, repo, key] = modelscopeMatch
      const isOfficial = repo.includes('arknights-gamedata')
      if (key.endsWith('dataset-manifest.json')) {
        const packId = isOfficial ? 'official_game' : 'references'
        const files = {
          [`releases/${RELEASE_ID}/${packId}/pack-manifest.json`]:
            { size: Buffer.byteLength(JSON.stringify(packManifests[packId])), sha256: sha256(Buffer.from(JSON.stringify(packManifests[packId]))) },
          [`releases/${RELEASE_ID}/${packId}/shards/00000.jsonl.gz`]:
            { size: communityShard.length && packShards[packId]['shards/00000.jsonl.gz'].length,
              sha256: sha256(packShards[packId]['shards/00000.jsonl.gz']) },
        }
        return new Response(JSON.stringify({
          schema_version: 1, kind: 'prts-agent-modelscope-dataset-mirror',
          group: packId, release_id: RELEASE_ID, data_version: DATA_VERSION,
          pack_ids: [packId], file_count: 2, files,
        }), { status: 200 })
      }
      const asset = /^releases\/[^/]+\/(official_game|references)\/(.+)$/.exec(key)
      if (asset) {
        const [, packId, path] = asset
        if (path === 'pack-manifest.json') {
          return new Response(JSON.stringify(packManifests[packId]), { status: 200 })
        }
        const bytes = corruptModelscope ? corrupted(packShards[packId][path]) : packShards[packId][path]
        return new Response(new Uint8Array(bytes), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }
    // ---- 站点源 ----
    if (target.startsWith(`${SITE}/api/agent/data/releases/`)) {
      counters.site += 1
      const rest = target.slice(`${SITE}/api/agent/data/releases/`.length)
      if (rest === `${RELEASE_ID}/release-manifest.json`) {
        return new Response(JSON.stringify(releaseManifest), { status: 200 })
      }
      const asset = new RegExp(`^${RELEASE_ID}/(official_game|references)/(.+)$`).exec(rest)
      if (asset) {
        const [, packId, path] = asset
        if (path === 'pack-manifest.json') {
          return new Response(JSON.stringify(packManifests[packId]), { status: 200 })
        }
        const bytes = corruptSite ? corrupted(packShards[packId][path]) : packShards[packId][path]
        return new Response(new Uint8Array(bytes), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, counters }
}

test('resolveModelScopeCurrentRelease：tree API 列举 + dataset-manifest 解析最新版本', async () => {
  // 两个镜像仓都列同一批目录 → 取字典序最大 id；README（blob）等非目录项被忽略。
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/repo/tree')) {
      return new Response(JSON.stringify({ Code: 200, Data: { Files: [
        { Type: 'tree', Path: `releases/${RELEASE_ID}` },
        { Type: 'tree', Path: 'releases/old-rel-20260101' },
        { Type: 'blob', Path: 'releases/README.md' },
      ] } }), { status: 200 })
    }
    if (target.endsWith('dataset-manifest.json')) {
      return new Response(JSON.stringify({ release_id: RELEASE_ID, data_version: DATA_VERSION }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  const resolved = await resolveModelScopeCurrentRelease({ fetchImpl })
  assert.equal(resolved.releaseId, RELEASE_ID)
  assert.equal(resolved.dataVersion, DATA_VERSION)

  // 清单 data_version 缺失 → releaseId 仍可用，dataVersion 为 null
  const noVersion = await resolveModelScopeCurrentRelease({
    fetchImpl: async (url) => {
      const target = String(url)
      if (target.includes('/repo/tree')) {
        return new Response(JSON.stringify({ Data: { Files: [
          { Type: 'tree', Path: `releases/${RELEASE_ID}/shards` }] } }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    },
  })
  assert.equal(noVersion.releaseId, RELEASE_ID)
  assert.equal(noVersion.dataVersion, null)

  // 全 404 → null（调用方回退站点源）
  const none = await resolveModelScopeCurrentRelease({
    fetchImpl: async () => new Response('not found', { status: 404 }),
  })
  assert.equal(none, null)
})

test('ModelScope 命中：优先源成功，完全不碰站点', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl, counters } = buildSources()
    const result = await ensureCorpusRelease({
      releasesDir: dir, releaseId: RELEASE_ID, fetchImpl,
      logger: { warn: (m) => console.error('[warn]', m), info: () => {} },
    })
    assert.equal(result.status, 'downloaded')
    assert.equal(result.source, 'modelscope')
    assert.equal(counters.site, 0)
    const store = new CorpusStore({ releasesDir: dir })
    await store.ready()
    assert.equal(store.documents.size, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ModelScope 无此 release（404）→ 自动回退站点源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl, counters } = buildSources({ modelscope404: true })
    const warnings = []
    const result = await ensureCorpusRelease({
      releasesDir: dir, releaseId: RELEASE_ID, fetchImpl,
      logger: { warn: (m) => warnings.push(m), info: () => {} },
    })
    assert.equal(result.status, 'downloaded')
    assert.equal(result.source, 'site')
    assert.ok(counters.site > 0)
    assert.ok(warnings.some((m) => m.includes('modelscope 源失败')), '应记录源回退')

    // 站点源产物同样能被 store 打开；current.json 指针记录来源
    const store = new CorpusStore({ releasesDir: dir })
    await store.ready()
    assert.equal(store.dataVersion, DATA_VERSION)
    const pointer = JSON.parse(await readFile(join(dir, 'current.json'), 'utf8'))
    assert.equal(pointer.channel, 'site')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('order: ["site"] 时直接走站点（不访问 ModelScope）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl, counters } = buildSources()
    const result = await ensureCorpusRelease({
      releasesDir: dir, releaseId: RELEASE_ID, fetchImpl, order: ['site'],
    })
    assert.equal(result.source, 'site')
    assert.equal(counters.modelscope, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('两个源都损坏 → CHECKSUM_MISMATCH 且不写 current.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl } = buildSources({ corruptModelscope: true, corruptSite: true })
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl }),
      (error) => error instanceof InstallerFault && error.code === 'CHECKSUM_MISMATCH',
    )
    await assert.rejects(() => readFile(join(dir, 'current.json'), 'utf8'), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ModelScope 损坏但站点完好 → 回退后成功（跨源续传复用已验分片）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl } = buildSources({ corruptModelscope: true })
    const result = await ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl })
    assert.equal(result.source, 'site')
    const store = new CorpusStore({ releasesDir: dir })
    await store.ready()
    assert.equal(store.documents.size, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('断点续传：已就绪分片跳过（只重新拉清单）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl, counters } = buildSources()
    await ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl, order: ['site'] })
    await rm(join(dir, 'current.json'))
    await rm(join(dir, RELEASE_ID, 'release-manifest.json'), { force: true })
    const before = counters.site
    const second = await ensureCorpusRelease({
      releasesDir: dir, releaseId: RELEASE_ID, fetchImpl, order: ['site'],
    })
    assert.equal(second.status, 'downloaded')
    assert.equal(second.files, 0, '分片已校验存在，无需重下')
    assert.ok(counters.site <= before + 3, '只重新拉了清单（release-manifest + 2 个 pack-manifest）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('本地已就绪：二次调用零网络', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl, counters } = buildSources()
    await ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl })
    const before = counters.modelscope + counters.site
    const again = await ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl })
    assert.equal(again.status, 'present')
    assert.equal(counters.modelscope + counters.site, before)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('requireRelease：手动指定版本不被其他当前版本短路', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-required-'))
  try {
    const other = 'other-rel'
    await mkdir(join(dir, other), { recursive: true })
    await writeFile(join(dir, other, 'release-manifest.json'), JSON.stringify({
      release_id: other, data_version: 'f'.repeat(64),
    }))
    await writeFile(join(dir, 'current.json'), JSON.stringify({ release_id: other }))
    const { fetchImpl, counters } = buildSources()

    const ordinary = await ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl })
    assert.equal(ordinary.status, 'present')
    assert.equal(counters.modelscope + counters.site, 0)

    const required = await ensureCorpusRelease({
      releasesDir: dir, releaseId: RELEASE_ID, fetchImpl, requireRelease: true,
    })
    assert.equal(required.status, 'downloaded')
    assert.equal(JSON.parse(await readFile(join(dir, 'current.json'), 'utf8')).release_id, RELEASE_ID)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('并发准备同一 release：跨调用锁避免重复下载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-lock-'))
  try {
    const { fetchImpl } = buildSources()
    const results = await Promise.all([
      ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl }),
      ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl }),
    ])
    assert.deepEqual(results.map((item) => item.status).sort(), ['downloaded', 'present'])
    const store = new CorpusStore({ releasesDir: dir })
    await store.ready()
    assert.equal(store.documents.size, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('清单防御：非法路径 / 404 无可用源 / release 不匹配', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    // ModelScope 清单带路径穿越（隔离 order 只用 modelscope；official 仓给合法清单）
    const traversal = async (url) => {
      if (String(url).endsWith('dataset-manifest.json')) {
        if (String(url).includes('arknights-gamedata')) {
          return new Response(JSON.stringify({
            schema_version: 1, kind: 'prts-agent-modelscope-dataset-mirror',
            release_id: RELEASE_ID, data_version: DATA_VERSION,
            files: { [`releases/${RELEASE_ID}/official_game/pack-manifest.json`]:
              { size: 2, sha256: '0'.repeat(64) } },
          }), { status: 200 })
        }
        return new Response(JSON.stringify({
          schema_version: 1, kind: 'prts-agent-modelscope-dataset-mirror',
          release_id: RELEASE_ID, data_version: DATA_VERSION, files: {
            [`releases/${RELEASE_ID}/references/../../escape.gz`]: { size: 1, sha256: '0'.repeat(64) },
          },
        }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl: traversal, order: ['modelscope'] }),
      (error) => error.code === 'INVALID_MANIFEST',
    )
    // 全源 404 → RELEASE_NOT_FOUND
    const notFound = async () => new Response('not found', { status: 404 })
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl: notFound }),
      (error) => error.code === 'RELEASE_NOT_FOUND',
    )
    // release_id 不匹配（隔离 order，避免回退站点覆盖错误）
    const mismatch = async (url) => {
      if (String(url).endsWith('dataset-manifest.json')) {
        return new Response(JSON.stringify({ schema_version: 1, kind: 'prts-agent-modelscope-dataset-mirror',
          release_id: 'other-rel', data_version: DATA_VERSION, files: {} }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl: mismatch, order: ['modelscope'] }),
      (error) => error.code === 'INVALID_MANIFEST',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
