/**
 * CorpusStore：对 prts-browser-corpus-release-v1 资料包的只读访问层。
 *
 * 包结构（复用自 prts.chat/agent 的浏览器资料包，格式不变）：
 *   releases/current.json                          → { release_id, data_version }
 *   releases/<release_id>/<pack>/pack-manifest.json → { pack_id, shards: [...] }
 *   releases/<release_id>/<pack>/shards/NNN.jsonl.gz → 每行一个文档记录
 *     { document: DocumentSummary, lines: LineRecord[], local_integrity, search_index_id }
 *
 * 初始化时全量扫描各包分片，建立 document_id / source_ref_prefix 两张索引；
 * 分片内容按 LRU 缓存，避免重复解压。
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'

const gunzipAsync = promisify(gunzip)

const TRIGRAM_MAGIC = Buffer.from([80, 82, 84, 83, 84, 71, 49, 0])
const TRIGRAM_HEADER_BYTES = TRIGRAM_MAGIC.length + 4
const PACK_ORDER = Object.freeze(['official_game', 'reviewed_wiki', 'terra_journey',
  'entities', 'references'])
export const DOCUMENT_ORDERING_VERSION = 1

function packOrder(left, right) {
  const leftIndex = PACK_ORDER.indexOf(left.name)
  const rightIndex = PACK_ORDER.indexOf(right.name)
  const leftRank = leftIndex < 0 ? PACK_ORDER.length : leftIndex
  const rightRank = rightIndex < 0 ? PACK_ORDER.length : rightIndex
  return leftRank - rightRank || left.name.localeCompare(right.name, 'en')
}

function readVarint(bytes, state, limit) {
  let value = 0
  let shift = 0
  while (state.offset < limit && shift <= 49) {
    const byte = bytes[state.offset++]
    value += (byte & 0x7f) * (2 ** shift)
    if (!(byte & 0x80)) return value
    shift += 7
  }
  throw new Error('CorpusStore: invalid trigram varint')
}

/** 查询浏览器资料包的 PRTSTG1 二进制倒排分片。 */
function lookupTrigramIndex(bytes, target) {
  if (bytes.length < TRIGRAM_HEADER_BYTES || !bytes.subarray(0, 8).equals(TRIGRAM_MAGIC)) {
    throw new Error('CorpusStore: invalid trigram index magic')
  }
  const count = bytes.readUInt32LE(8)
  const payloadStart = TRIGRAM_HEADER_BYTES + (count + 1) * 4
  if (payloadStart > bytes.length) throw new Error('CorpusStore: invalid trigram offset table')
  const offsetAt = (index) => bytes.readUInt32LE(TRIGRAM_HEADER_BYTES + index * 4)
  const recordAt = (index) => {
    const start = payloadStart + offsetAt(index)
    const end = payloadStart + offsetAt(index + 1)
    const state = { offset: start }
    const textLength = readVarint(bytes, state, end)
    const trigram = bytes.subarray(state.offset, state.offset + textLength).toString('utf8')
    state.offset += textLength
    const postingCount = readVarint(bytes, state, end)
    const indexes = []
    let current = 0
    for (let item = 0; item < postingCount; item += 1) {
      current += readVarint(bytes, state, end)
      indexes.push(current)
    }
    if (state.offset !== end) throw new Error('CorpusStore: malformed trigram record')
    return { trigram, indexes }
  }
  let low = 0
  let high = count - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const record = recordAt(middle)
    if (record.trigram === target) return record.indexes
    if (record.trigram < target) low = middle + 1
    else high = middle - 1
  }
  return []
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * 面向模型与 UI 的短篇章标识。它由 canonical document_id 确定性派生，
 * 不携带路径信息；96 bit 摘要在装载时做碰撞检测。
 */
export function documentUid(documentId) {
  const value = String(documentId ?? '')
  if (!value) return ''
  return `doc_${createHash('sha256').update(`prts-document\0${value}`, 'utf8')
    .digest('base64url').slice(0, 16)}`
}

/** 模型/界面使用的自然语言篇章定位；剧情补齐活动、章节代码与行动前后。 */
export function naturalDocumentTitle(document = {}) {
  if (document.document_type === 'entity') {
    const title = String(document.display_title || '').trim()
    return title ? `${title} / 实体资料` : ''
  }
  if (document.document_type !== 'story') return String(document.display_title || '')
  const variation = /_variation0*(\d+)(?:\.[^./]+)?$/iu.exec(
    String(document.source_story_id || document.document_id || ''),
  )
  return [document.activity_name, document.story_code, document.story_name, document.part_label,
    ...(variation ? [`分支${Number(variation[1])}`] : [])]
    .map((item) => String(item || '').trim()).filter(Boolean).join(' · ')
    || String(document.display_title || '')
}

/** 行完整性规则：sha256(全部行文本以 \n 连接) === local_integrity.sha256。 */
export function computeLinesIntegrity(lines) {
  return sha256(lines.map((line) => line.text).join('\n'))
}

/**
 * 收集会破坏「原始字节即匹配文本」假设的字符：单个字符经 NFKC + 小写后
 * 发生变化（全角标点、罗马数字、上标、兼容表意文字等）。实测本语料中
 * 此类字符只有数十个（几乎全是全角标点），但出现在约七成以上的行里；
 * 短字面量预筛据此构造无损 needle 集合（见 findDocumentsByShortLiteral）。
 * 展开式口径与 search.js matchesText 的匹配侧一致：NFKC 归一化后小写。
 */
function collectUnstableChars(text, stableChars, unstableChars) {
  if (typeof text !== 'string' || !text) return
  for (let offset = 0; offset < text.length;) {
    const code = text.codePointAt(offset)
    const size = code > 0xffff ? 2 : 1
    const character = text.slice(offset, offset + size)
    offset += size
    if (stableChars.has(character)) continue
    const expansion = character.normalize('NFKC').toLocaleLowerCase()
    if (expansion === character) stableChars.add(character)
    else unstableChars.set(character, expansion)
  }
}

/**
 * 枚举查询的规范等价形式：NFD 全分解，以及把相邻字符逐步规范复合回去的
 * 中间形态（例如谚文音节 ↔ 字母序列）。短字面量预筛把这些形式一并作为
 * 字节 needle，保证语料以分解形态存储时不会漏检。
 */
function canonicalVariants(query, limit = 32) {
  const variants = new Set([query])
  const decomposed = query.normalize('NFD')
  if (decomposed !== query) variants.add(decomposed)
  const agenda = [decomposed]
  while (agenda.length && variants.size < limit) {
    const current = agenda.pop()
    const chars = [...current]
    for (let index = 0; index + 1 < chars.length && variants.size < limit; index += 1) {
      const pair = chars[index] + chars[index + 1]
      const composed = pair.normalize('NFC')
      if (composed.length !== 1 || composed === pair) continue
      const next = chars.slice(0, index).concat([composed], chars.slice(index + 2)).join('')
      if (variants.has(next)) continue
      variants.add(next)
      agenda.push(next)
    }
  }
  return variants
}

export class CorpusStore {
  /**
   * @param {{ releasesDir: string, cacheShards?: number, ensure?: () => Promise<void>, cursorSecretPath?: string }} options
   * `ensure` 是调用方可选的初始化前置步骤；本插件的 Host 和工具挂载不使用它下载资料。
   */
  constructor({ releasesDir, cacheShards = 8, searchCacheShards = 32, ensure, cursorSecretPath } = {}) {
    if (!releasesDir) throw new Error('CorpusStore: releasesDir is required')
    this.releasesDir = releasesDir
    this.cacheShards = cacheShards
    // 倒排分片缓存独立于正文分片缓存：trigram 查询会在一个请求内轮询
    // 全部 search-index 分片，容量太小会导致同批分片被反复重解压。
    this.searchCacheShards = searchCacheShards
    this.ensure = ensure
    this.cursorSecretPath = cursorSecretPath || join(dirname(releasesDir), 'cursor-secret.bin')
    /** @type {Promise<void> | null} */
    this._ready = null
    this._generation = 0
    this._loaded = false
    this.releaseId = null
    this.dataVersion = null
    /** @type {Map<string, { packId: string, shardPath: string, index: number }>} */
    this.documents = new Map()
    /** @type {string[]} 全局稳定 document_ordinal → document_id。 */
    this.documentOrder = []
    /** @type {Map<string, string>} source_ref_prefix → document_id */
    this.prefixIndex = new Map()
    /** @type {Map<string, string>} 短 document_uid → canonical document_id */
    this.uidIndex = new Map()
    /** @type {Map<string, string[]>} display_title → document_id[]（保留同名歧义） */
    this.titleIndex = new Map()
    /** @type {Map<string, string[]>} 自然语言完整篇章标题 → document_id[] */
    this.naturalTitleIndex = new Map()
    /** @type {Map<string, string>} path → document_id（首个命中优先） */
    this.pathIndex = new Map()
    /** @type {Map<string, string>} source_story_id → document_id（首个命中优先） */
    this.sourceStoryIndex = new Map()
    /** @type {Map<string, object>} packId → pack-manifest */
    this.packs = new Map()
    /** @type {Map<string, string>} packId\0search_index_id -> document_id */
    this.searchIndexDocuments = new Map()
    /** @type {Map<string, object[]>} shardKey → 已解析文档记录数组（LRU） */
    this._shardCache = new Map()
    /** @type {Map<string, Buffer>} search-index 分片 LRU */
    this._searchCache = new Map()
    /** @type {Map<string, string[]>} 1—2 字无损分片预筛结果（LRU） */
    this._shortLiteralCache = new Map()
    /** @type {Promise<Buffer> | null} 持久游标签名密钥。 */
    this._cursorSecret = null
  }

  /** 初始化（幂等）：ensure（可选的资料准备/下载）→ 解析 release → 扫描全部分片建索引。 */
  ready() {
    if (!this._ready) {
      const generation = this._generation
      const operation = (this.ensure ? Promise.resolve(this.ensure()) : Promise.resolve())
        .then(() => this._init(generation))
        .catch((error) => {
          if (generation !== this._generation) return false
          throw error
        })
        .then(async (committed) => {
          if (!committed) await this.ready()
        })
      let tracked
      tracked = operation.catch((error) => {
        if (this._ready === tracked) this._ready = null
        throw error
      })
      this._ready = tracked
    }
    return this._ready
  }

  /** 初始化是否已提交到当前 generation。 */
  get loaded() {
    return this._loaded
  }

  /**
   * 丢弃全部已解析状态（版本切换/重下载后调用）；下次 ready() 按新的
   * current.json 重建索引。进行中的旧 ready() 只构建局部快照，generation
   * 不匹配时不会提交，并会等待当前 generation 的初始化。
   */
  reset() {
    this._generation += 1
    this._ready = null
    this._loaded = false
    this.releaseId = null
    this.dataVersion = null
    this.documents.clear()
    this.documentOrder = []
    this.prefixIndex.clear()
    this.uidIndex.clear()
    this.titleIndex.clear()
    this.naturalTitleIndex.clear()
    this.pathIndex.clear()
    this.sourceStoryIndex.clear()
    this.packs.clear()
    this.searchIndexDocuments.clear()
    this._shardCache.clear()
    this._searchCache.clear()
    this._shortLiteralCache.clear()
    this.unstableChars = null
    this._timelineRows = null
    this._aliasGroups = null
  }

  async _init(generation) {
    const current = JSON.parse(await readFile(join(this.releasesDir, 'current.json'), 'utf8'))
    const releaseId = current.release_id
    const releaseDir = join(this.releasesDir, releaseId)
    const releaseManifest = JSON.parse(await readFile(join(releaseDir, 'release-manifest.json'), 'utf8'))
    const next = {
      releaseId,
      dataVersion: releaseManifest.data_version,
      documents: new Map(),
      documentOrder: [],
      prefixIndex: new Map(),
      uidIndex: new Map(),
      titleIndex: new Map(),
      naturalTitleIndex: new Map(),
      pathIndex: new Map(),
      sourceStoryIndex: new Map(),
      packs: new Map(),
      searchIndexDocuments: new Map(),
      unstableChars: new Map(),
    }
    const stableChars = new Set()

    const entries = (await readdir(releaseDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).sort(packOrder)
    for (const entry of entries) {
      const packDir = join(releaseDir, entry.name)
      let manifest
      try {
        manifest = JSON.parse(await readFile(join(packDir, 'pack-manifest.json'), 'utf8'))
      } catch {
        continue // 无 pack-manifest 的目录跳过
      }
      // v3 起 pack-manifest 不再携带顶层 pack_id，以目录名为准
      const packId = manifest.pack_id ?? entry.name
      manifest.pack_id = packId
      next.packs.set(packId, manifest)
      for (const shard of manifest.shards) {
        const records = this._decodeShard(await this._readPacked(packId, shard.path, releaseId))
        // 分片间让出事件循环：初始化虽在后台，也不应长时间阻塞宿主进程。
        await new Promise((resolve) => { setImmediate(resolve) })
        records.forEach((record, index) => {
          const { document_id: documentId, source_ref_prefix: prefix } = record.document
          const ordinal = next.documentOrder.length
          next.documentOrder.push(documentId)
          next.documents.set(documentId, {
            packId: manifest.pack_id, shardPath: shard.path, index,
            document: record.document, speakers: record.speakers ?? [],
            searchIndexId: record.search_index_id ?? null, ordinal,
          })
          if (prefix) next.prefixIndex.set(prefix, documentId)
          const uid = documentUid(documentId)
          const existingUid = next.uidIndex.get(uid)
          if (existingUid && existingUid !== documentId) {
            throw new Error(`CorpusStore: document_uid collision: ${uid}`)
          }
          next.uidIndex.set(uid, documentId)
          const title = record.document.display_title
          if (title) {
            const ids = next.titleIndex.get(title) ?? []
            ids.push(documentId)
            next.titleIndex.set(title, ids)
          }
          const naturalTitle = naturalDocumentTitle(record.document)
          if (naturalTitle) {
            const ids = next.naturalTitleIndex.get(naturalTitle) ?? []
            ids.push(documentId)
            next.naturalTitleIndex.set(naturalTitle, ids)
          }
          const path = record.document.path
          if (path && !next.pathIndex.has(path)) next.pathIndex.set(path, documentId)
          const sourceStoryId = record.document.source_story_id
          if (sourceStoryId && !next.sourceStoryIndex.has(sourceStoryId)) {
            next.sourceStoryIndex.set(sourceStoryId, documentId)
          }
          if (record.search_index_id) {
            next.searchIndexDocuments.set(`${manifest.pack_id}\0${record.search_index_id}`, documentId)
          }
          for (const line of record.lines ?? []) {
            collectUnstableChars(line?.text, stableChars, next.unstableChars)
          }
        })
      }
    }
    if (next.documents.size === 0) {
      throw new Error(`CorpusStore: no documents found under ${releaseDir}`)
    }
    if (generation !== this._generation) return false
    this.releaseId = next.releaseId
    this.dataVersion = next.dataVersion
    this.documents = next.documents
    this.documentOrder = next.documentOrder
    this.prefixIndex = next.prefixIndex
    this.uidIndex = next.uidIndex
    this.titleIndex = next.titleIndex
    this.naturalTitleIndex = next.naturalTitleIndex
    this.pathIndex = next.pathIndex
    this.sourceStoryIndex = next.sourceStoryIndex
    this.packs = next.packs
    this.searchIndexDocuments = next.searchIndexDocuments
    this.unstableChars = next.unstableChars
    this._shardCache.clear()
    this._searchCache.clear()
    this._shortLiteralCache.clear()
    this._loaded = true
    return true
  }

  /** 解析一个分片（已解压的明文 JSONL；来自解压缓存或 .gz 解压结果）。 */
  _decodeShard(buffer) {
    const text = buffer.toString('utf8')
    const records = []
    for (const line of text.split('\n')) {
      if (line) records.push(JSON.parse(line))
    }
    return records
  }

  /**
   * 读取一个分片：优先读「解压缓存」（分片路径去掉 .gz 的明文文件，开启
   * 解压存储后生成），否则读 .gz 并异步解压。返回明文 Buffer，读取侧无需再解压。
   */
  async _readPacked(packId, shardPath, releaseId = this.releaseId) {
    const baseDir = join(this.releasesDir, releaseId, packId)
    const plainPath = shardPath.endsWith('.gz') ? shardPath.slice(0, -3) : shardPath
    try {
      return await readFile(join(baseDir, plainPath))
    } catch { /* 无解压缓存 → 走 .gz 解压 */ }
    return gunzipAsync(await readFile(join(baseDir, shardPath)))
  }

  /** 读取（并缓存）某包的一个分片，返回文档记录数组。 */
  async _loadShard(packId, shardPath) {
    const key = `${packId}\0${shardPath}`
    const cached = this._shardCache.get(key)
    if (cached) {
      this._shardCache.delete(key)
      this._shardCache.set(key, cached) // 触碰 LRU
      return cached
    }
    const records = this._decodeShard(await this._readPacked(packId, shardPath))
    this._shardCache.set(key, records)
    if (this._shardCache.size > this.cacheShards) {
      const oldest = this._shardCache.keys().next().value
      this._shardCache.delete(oldest)
    }
    return records
  }

  async _loadSearchShard(packId, shardPath) {
    const key = `${packId}\0${shardPath}`
    const cached = this._searchCache.get(key)
    if (cached) {
      this._searchCache.delete(key)
      this._searchCache.set(key, cached)
      return cached
    }
    const bytes = await gunzipAsync(await readFile(join(
      this.releasesDir, this.releaseId, packId, shardPath,
    )))
    this._searchCache.set(key, bytes)
    while (this._searchCache.size > this.searchCacheShards) {
      this._searchCache.delete(this._searchCache.keys().next().value)
    }
    return bytes
  }

  /**
   * 按 document_id 取完整文档记录。
   * @returns {Promise<{ record: object, packId: string } | null>}
   */
  async getDocument(documentId) {
    const location = this.documents.get(documentId)
    if (!location) return null
    const records = await this._loadShard(location.packId, location.shardPath)
    const record = records[location.index]
    if (!record || record.document.document_id !== documentId) return null
    return { record, packId: location.packId }
  }

  /** source_ref_prefix → document_id。 */
  getDocumentIdByPrefix(prefix) {
    return this.prefixIndex.get(prefix) ?? null
  }

  /** 当前不可变资料版本中的稳定全局文档序号（0-based）。 */
  documentOrdinal(documentId) {
    return this.documents.get(String(documentId ?? ''))?.ordinal ?? null
  }

  /** 将候选文档恢复成全局稳定顺序；未知 ID 被忽略。 */
  orderedDocumentIds(documentIds = null) {
    if (documentIds == null) return [...this.documentOrder]
    const requested = new Set(documentIds)
    return this.documentOrder.filter((documentId) => requested.has(documentId))
  }

  /** 短 document_uid → canonical document_id。 */
  getDocumentIdByUid(uid) {
    return this.uidIndex.get(String(uid ?? '').trim()) ?? null
  }

  /** 按短 document_uid 取完整文档记录。 */
  async getDocumentByUid(uid) {
    const documentId = this.getDocumentIdByUid(uid)
    return documentId ? this.getDocument(documentId) : null
  }

  /**
   * 获取跨重启持久的游标签名密钥。密钥位于 releases 的父级配置目录，
   * 不写入不可变发布包；并发首次创建通过 wx 保证只有一个胜者。
   */
  getOrCreateCursorSecret() {
    if (this._cursorSecret) return this._cursorSecret
    const path = this.cursorSecretPath
    this._cursorSecret = (async () => {
      try {
        const existing = await readFile(path)
        if (existing.length === 32) return existing
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const created = randomBytes(32)
      try {
        await writeFile(path, created, { flag: 'wx', mode: 0o600 })
        return created
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const existing = await readFile(path)
        if (existing.length !== 32) throw new Error('CorpusStore: invalid cursor secret')
        return existing
      }
    })().catch((error) => {
      this._cursorSecret = null
      throw error
    })
    return this._cursorSecret
  }

  /** 按自然语言完整篇章标题或 display_title 取文档；短标题同名时要求改用完整标题。 */
  async getDocumentByTitle(title) {
    const normalized = String(title ?? '').trim()
    const naturalIds = this.naturalTitleIndex.get(normalized) ?? []
    const documentIds = naturalIds.length ? naturalIds : this.titleIndex.get(normalized) ?? []
    if (documentIds.length > 1) {
      // 实体来源中可能同时存在通用概念记录与后续补充的同名专页，两者的
      // model title 也完全相同，要求模型“换完整标题”无法消歧。此时稳定选择
      // 行数最多的完整投影；并列时按 document_id 排序保证跨进程一致。
      const locations = documentIds.map((documentId) => this.documents.get(documentId)).filter(Boolean)
      if (locations.length === documentIds.length
          && locations.every((item) => item.document.document_type === 'entity')) {
        const preferred = [...locations].sort((left, right) =>
          Number(right.document.line_count || 0) - Number(left.document.line_count || 0)
          || String(left.document.document_id).localeCompare(String(right.document.document_id)))[0]
        return this.getDocument(preferred.document.document_id)
      }
      throw Object.assign(new Error(
        `标题“${normalized}”对应 ${documentIds.length} 篇资料；请使用 corpus_search 返回的“活动 · 章节代码 · 篇名 · 行动前后”完整标题`,
      ), { code: 'DOCUMENT_AMBIGUOUS' })
    }
    return documentIds.length ? this.getDocument(documentIds[0]) : null
  }

  /** 同名实体投影只让内容最完整的一份进入模型搜索结果。 */
  isPreferredNaturalDocument(documentId) {
    const location = this.documents.get(String(documentId || ''))
    if (!location || location.document.document_type !== 'entity') return true
    const title = naturalDocumentTitle(location.document)
    const ids = this.naturalTitleIndex.get(title) ?? []
    if (ids.length <= 1) return true
    const entityLocations = ids.map((id) => this.documents.get(id)).filter(Boolean)
    if (entityLocations.length !== ids.length
        || entityLocations.some((item) => item.document.document_type !== 'entity')) return true
    entityLocations.sort((left, right) =>
      Number(right.document.line_count || 0) - Number(left.document.line_count || 0)
      || String(left.document.document_id).localeCompare(String(right.document.document_id)))
    return entityLocations[0].document.document_id === location.document.document_id
  }

  /** 按资料内路径（如 activity_timelines.jsonl、char_alias.txt、stories/x.txt）取文档记录。 */
  async getDocumentByPath(path) {
    const documentId = this.pathIndex.get(String(path ?? ''))
    return documentId ? this.getDocument(documentId) : null
  }

  /** 按 GameData 原始 source_story_id 取文档记录（synopsis → 可读全文的桥）。 */
  async getDocumentBySourceStoryId(sourceStoryId) {
    const documentId = this.sourceStoryIndex.get(String(sourceStoryId ?? ''))
    return documentId ? this.getDocument(documentId) : null
  }

  /** 任意 pack 声明了 search-index 分片即视为倒排可用。 */
  get hasTrigramIndex() {
    for (const manifest of this.packs.values()) {
      if (manifest.search_index?.shards?.length) return true
    }
    return false
  }

  /**
   * 使用各 pack 的 trigram 倒排分片求文档交集；查询短于 3 字符时返回 null。
   * 外层按分片迭代：每个分片只解压一次，再对其覆盖范围内的全部 trigram
   * 查询，避免多 trigram 查询反复重解压同一批分片。
   */
  async findDocumentsByTrigrams(trigrams) {
    if (!trigrams.length) return null
    const perTrigram = new Map(trigrams.map((trigram) => [trigram, new Set()]))
    for (const [packId, manifest] of this.packs) {
      for (const descriptor of manifest.search_index?.shards ?? []) {
        const relevant = trigrams.filter((trigram) =>
          descriptor.first_trigram <= trigram && trigram <= descriptor.last_trigram)
        if (!relevant.length) continue
        const bytes = await this._loadSearchShard(packId, descriptor.path)
        for (const trigram of relevant) {
          const candidates = perTrigram.get(trigram)
          for (const index of lookupTrigramIndex(bytes, trigram)) {
            const documentId = this.searchIndexDocuments.get(`${packId}\0${index}`)
            if (documentId) candidates.add(documentId)
          }
        }
      }
    }
    let intersection = null
    for (const trigram of trigrams) {
      const candidates = perTrigram.get(trigram)
      intersection = intersection === null
        ? candidates
        : new Set([...intersection].filter((documentId) => candidates.has(documentId)))
      if (!intersection.size) break
    }
    return [...(intersection ?? [])]
  }

  /**
   * 为 1—2 个无大小写字符的字面量提供 grep 式候选预筛。
   *
   * 现有资料包只带 trigram 倒排，短查询不能使用它。直接逐文档扫描会再次
   * JSON.parse 全库并轻易越过工具时限；这里先在解压后的 JSONL Buffer 上做
   * 原始字节查找，只解析确实可能含命中的少量分片，再返回文档候选。
   *
   * 字节预筛必须是正式匹配（search.js 的 matchesText：NFKC + 空白折叠 +
   * 小写后子串匹配）的“超集”，否则会产生假阴性。本地语料并非 NFKC 纯文本
   * （实测七成以上行含全角标点等兼容字符），因此 needle 集合在查询原文
   * 之外还纳入：
   *   1. 查询的规范等价形式（NFD 分解及其部分重组合，如谚文音节）；
   *   2. 初始化收集的“不稳定字符”中，展开式包含查询、或与查询首/尾字符
   *      相邻接者（两字查询可能横跨两个字符展开的边界）。
   * 不适合无损预筛的查询返回 null，由调用方走通用路径。跨字符边界的
   * 规范复合产物（如 "e"+U+0301 复合为 "é"）属于带大小写的预组合字符，
   * 已被“无大小写”入参门槛排除。预筛候选仍由 search.js 逐行按正式谓词
   * 复核，多余候选只损失少量性能，不会污染结果。
   */
  async findDocumentsByShortLiteral(value) {
    const query = String(value ?? '')
    const characters = [...query]
    if (!characters.length || characters.length > 2
        || query !== query.normalize('NFC') || query !== query.normalize('NFKC')
        || query.toLocaleLowerCase() !== query.toLocaleUpperCase()
        || /[\s"\\\u0000-\u001f]/u.test(query)) return null
    if (!this.unstableChars) return null
    const cached = this._shortLiteralCache.get(query)
    if (cached) {
      this._shortLiteralCache.delete(query)
      this._shortLiteralCache.set(query, cached)
      return [...cached]
    }
    const needles = canonicalVariants(query)
    const first = characters[0]
    const last = characters[characters.length - 1]
    for (const [character, expansion] of this.unstableChars) {
      if (expansion.includes(query) || expansion.endsWith(first) || expansion.startsWith(last)) {
        needles.add(character)
      }
    }
    const needleStrings = [...needles]
    const needleBuffers = needleStrings.map((needle) => Buffer.from(needle, 'utf8'))
    const jobs = []
    for (const [packId, manifest] of this.packs) {
      for (const descriptor of manifest.shards ?? []) {
        jobs.push({ packId, descriptor, order: jobs.length })
      }
    }
    // gzip 解压走 libuv 线程池。每个 worker 一次只持有一个分片的明文，
    // 命中分片当场解析并只保留候选文档 id 与有界的 _shardCache，不会像
    // Promise.all 全量展开那样同时保留整库明文 Buffer。
    const found = []
    let nextJob = 0
    const worker = async () => {
      while (nextJob < jobs.length) {
        const job = jobs[nextJob++]
        const bytes = await this._readPacked(job.packId, job.descriptor.path)
        if (!needleBuffers.some((needle) => bytes.includes(needle))) continue
        // 分片间让出事件循环：JSON.parse 与逐行筛选是同步 CPU 工作。
        await new Promise((resolve) => { setImmediate(resolve) })
        const records = this._decodeShard(bytes)
        const key = `${job.packId}\0${job.descriptor.path}`
        this._shardCache.delete(key)
        this._shardCache.set(key, records)
        while (this._shardCache.size > this.cacheShards) {
          this._shardCache.delete(this._shardCache.keys().next().value)
        }
        for (const record of records) {
          const title = [record.document?.display_title, record.document?.story_name,
            record.document?.activity_name, record.document?.character_name]
            .some((item) => item != null && needleStrings.some((needle) => String(item).includes(needle)))
          const content = (record.lines ?? []).some((line) => {
            const text = typeof line?.text === 'string' ? line.text : ''
            return text !== '' && needleStrings.some((needle) => text.includes(needle))
          })
          if (title || content) found.push(record.document.document_id)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker))
    // worker 完成顺序不定；按全局稳定 ordinal 恢复与全量扫描一致的顺序。
    found.sort((left, right) =>
      (this.documents.get(left)?.ordinal ?? 0) - (this.documents.get(right)?.ordinal ?? 0))
    this._shortLiteralCache.set(query, found)
    while (this._shortLiteralCache.size > 32) {
      this._shortLiteralCache.delete(this._shortLiteralCache.keys().next().value)
    }
    return [...found]
  }

  /** 先按初始化时保留的轻量元数据过滤，再按需解压正文分片。 */
  async *iterateDocuments({ documentIds = null, predicate = null } = {}) {
    const ids = this.orderedDocumentIds(documentIds)
    for (const documentId of ids) {
      const location = this.documents.get(documentId)
      if (!location || (predicate && !predicate(location.document, location.speakers))) continue
      const found = await this.getDocument(documentId)
      if (found) yield found.record
    }
  }

  /**
   * 枚举某个活动下的全部剧情 story 文档（不解压正文分片，仅用初始化保留的
   * 轻量元数据），按 collection_id + sequence_index 排序。
   * @param {{ activityId?: string, activityName?: string }} target
   * @returns {{ document: object, speakers: string[] }[]}
   */
  activityStoryDocuments({ activityId = '', activityName = '' }) {
    const id = String(activityId || '').trim()
    const name = String(activityName || '').trim()
    if (!id && !name) return []
    const matches = []
    for (const location of this.documents.values()) {
      const document = location.document
      if (!document || document.document_type !== 'story' || document.document_kind !== 'story') continue
      const byId = id && (String(document.collection_id || '') === id
        || String(document.activity_id || '') === id)
      const byName = name && String(document.activity_name || '') === name
      if (!byId && !byName) continue
      matches.push({ document, speakers: location.speakers })
    }
    matches.sort((left, right) =>
      String(left.document.collection_id || '').localeCompare(
        String(right.document.collection_id || ''), 'zh-CN', { numeric: true })
      || (Number(left.document.sequence_index || 0) - Number(right.document.sequence_index || 0))
      || String(left.document.document_id || '').localeCompare(String(right.document.document_id || '')))
    return matches
  }
}
