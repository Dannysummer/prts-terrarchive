/** grep 风格 corpus_search：复用资料包索引，公开结果只使用自然标题与行号。 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { activityMatches, aliasesFor } from './timeline.js'
import { DOCUMENT_ORDERING_VERSION, naturalDocumentTitle } from './store.js'
import { projectSearch } from './search-projection.js'
import { wikiActivityName, wikiCharacterName, wikiDocumentRole,
  wikiSectionAt, wikiSectionRanges } from './wiki.js'

export const SEARCH_CONTRACT_VERSION = 'prts-corpus-tools-v1'

const PAGE_DOCUMENTS = 12
const MAX_PASSAGES_PER_DOCUMENT = 3
const PASSAGE_CLUSTER_GAP = 2
const RANK_POOL_CAP = 500
const SHORT_LITERAL_RANK_POOL_CAP = 128
const SIMPLE_LITERAL_MATCH_CAP_PER_DOCUMENT = 24
const SCAN_DOCUMENTS_PER_PAGE = 256
// 冷缓存下短字面量需要并发解压本地 JSONL 分片；8 秒会把正常检索误判为
// 超时。保留扫描上限和结果池上限，并把协作式时间预算提高到 15 秒。
const SEARCH_TIMEOUT_MS = 15000
const PREVIEW_OPTIONS = Object.freeze({ before_lines: 1, after_lines: 1,
  max_chars_per_line: 2000, max_total_chars: 12000 })
const MATCHING_POLICY_VERSION = 1
const SEARCH_POLICY_FINGERPRINT = createHash('sha256').update(JSON.stringify({
  pageDocuments: PAGE_DOCUMENTS,
  scanDocumentsPerPage: SCAN_DOCUMENTS_PER_PAGE,
  passagesPerDocument: MAX_PASSAGES_PER_DOCUMENT,
  passageClusterGap: PASSAGE_CLUSTER_GAP,
  simpleLiteralMatchCapPerDocument: SIMPLE_LITERAL_MATCH_CAP_PER_DOCUMENT,
  preview: PREVIEW_OPTIONS,
  matchingPolicyVersion: MATCHING_POLICY_VERSION,
})).digest('base64url').slice(0, 16)
const FILTER_LIMIT = 16
/** 过滤单项最长 512 码点：与上述项数上限共同保证压缩游标可被重新解码。 */
const FILTER_ITEM_LIMIT = 512
/**
 * 游标的物理上限：decodeCursor 的长度检查与解压输出上限必须容纳
 * FILTER_LIMIT × FILTER_ITEM_LIMIT 的最坏合法请求（CJK 直存约 3 字节/字符，
 * 再计 JSON 键与转义余量），否则自己签发的游标会翻页失败。
 */
const CURSOR_MAX_LENGTH = 65_536
const CURSOR_MAX_INFLATED = 262_144
const ENTITY_QUERY_MAX_DISTANCE = 256
const PROFILE_CATEGORIES = new Set(['干员档案', '招聘合同', '潜能与信物'])
const FILTER_FIELDS = {
  story_names: 'story_name',
}
const CURSOR_FILTER_KEYS = Object.freeze({
  resource_types: 'r', character_names: 'c', story_names: 's', activity_names: 'a',
  entity_names: 'e', speakers: 'p', wiki_sections: 'w',
})

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function trigramsFor(value) {
  const chars = [...normalizeText(value).toLocaleLowerCase()]
  if (chars.length < 3) return []
  return [...new Set(Array.from({ length: chars.length - 2 }, (_, index) =>
    chars.slice(index, index + 3).join('')))]
}

function resourceMatches(document, requested) {
  if (!requested.length) return true
  const type = String(document.document_type || '')
  const kind = String(document.document_kind || '')
  const category = String(document.document_category || '')
  return requested.some((resource) => {
    if (resource === 'story') return type === 'story' && category !== 'memory' && kind !== 'synopsis'
    if (resource === 'operator_record') return type === 'story' && category === 'memory'
    if (resource === 'character_profile') return type === 'character' && PROFILE_CATEGORIES.has(category)
    if (resource === 'character_module') return type === 'character' && category === '模组文案'
    if (resource === 'character_voice') return type === 'character' && category === '干员语音'
    if (resource === 'character_skin') return type === 'character' && category === '时装文案'
    if (resource === 'character_bundle') return (type === 'character'
      && (PROFILE_CATEGORIES.has(category) || category === '模组文案' || category === '干员语音'))
      || (type === 'story' && category === 'memory')
    if (resource === 'character_wiki') return type === 'knowledge' && kind === 'wiki'
      && Boolean(document.character_name)
    if (resource === 'story_wiki') return type === 'knowledge' && kind === 'wiki'
      && wikiDocumentRole(document) === 'story'
    if (resource === 'character_activity_wiki') return type === 'knowledge' && kind === 'wiki'
      && wikiDocumentRole(document) === 'character_activity'
    if (resource === 'reviewed_wiki') return type === 'knowledge' && kind === 'wiki'
    if (resource === 'terra_journey') return type === 'knowledge' && kind === 'terra_journey'
    if (resource === 'entity_profile') return type === 'entity'
    return resource === 'reference' && type === 'reference'
  })
}

/** 受限正则：拒绝高危回溯结构（与浏览器执行器 safeRegex 一致）。 */
function safeRegex(pattern) {
  if (pattern.length > 256 || /\\[1-9]|\(\?[=!<]|\(\?P=/.test(pattern)
      || /\([^()]*(?:\*|\+|\{\d*,?\})[^()]*\)(?:\*|\+|\{)/.test(pattern)) {
    throw Object.assign(new Error('正则表达式包含高风险回溯结构'), { code: 'REGEX_REJECTED' })
  }
  try {
    return new RegExp(pattern, 'u')
  } catch (error) {
    throw Object.assign(new Error(`正则表达式无法编译: ${error.message}`), { code: 'REGEX_REJECTED' })
  }
}

function normalizedRequest(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('搜索参数必须是对象'), { code: 'INVALID_REQUEST' })
  }
  const keys = Object.keys(raw)
  if (raw.cursor != null) {
    if (keys.some((key) => key !== 'cursor')) {
      throw Object.assign(new Error('cursor 必须单独提交，不能同时提供其他搜索参数'), { code: 'INVALID_REQUEST' })
    }
    if (!normalizeText(raw.cursor)) throw Object.assign(new Error('cursor 不能为空'), { code: 'INVALID_REQUEST' })
    return { cursor: String(raw.cursor) }
  }
  const query = normalizeText(raw.query)
  if ([...query].length > 512) throw Object.assign(new Error('literal query 最多 512 个字符'),
    { code: 'INVALID_REQUEST' })
  const filters = {}
  for (const field of ['resource_types', 'character_names', 'story_names', 'activity_names',
    'entity_names', 'speakers', 'wiki_sections']) {
    if (raw[field] !== undefined && (!Array.isArray(raw[field]) || !raw[field].length)) {
      throw Object.assign(new Error(`${field} 必须是非空数组`), { code: 'INVALID_REQUEST' })
    }
    filters[field] = [...new Set((raw[field] || []).map(normalizeText))]
    if (filters[field].some((value) => !value)) {
      throw Object.assign(new Error(`${field} 不能包含空字符串`), { code: 'INVALID_REQUEST' })
    }
    if (filters[field].length > FILTER_LIMIT) {
      throw Object.assign(new Error(`${field} 最多 ${FILTER_LIMIT} 项`), { code: 'INVALID_REQUEST' })
    }
    // 单项长度也设上限：合法请求的压缩游标必须能被 decodeCursor 的
    // 长度/解压上限重新解码，否则首次搜索成功、翻页却 CURSOR_INVALID。
    if (filters[field].some((value) => [...value].length > FILTER_ITEM_LIMIT)) {
      throw Object.assign(new Error(`${field} 单项最长 ${FILTER_ITEM_LIMIT} 个字符`), { code: 'INVALID_REQUEST' })
    }
  }
  if (!query && !Object.values(filters).some((items) => items.length)) {
    throw Object.assign(new Error('请提供 query 或至少一个资料/人物/篇章/说话人过滤条件'), { code: 'INVALID_REQUEST' })
  }
  const matchMode = raw.match_mode ?? 'literal'
  if (!['literal', 'regex'].includes(matchMode)) {
    throw Object.assign(new Error('match_mode 仅支持 literal / regex'), { code: 'INVALID_REQUEST' })
  }
  if (matchMode === 'regex') {
    if (!query) throw Object.assign(new Error('regex 模式必须提供 query'), { code: 'INVALID_REQUEST' })
    safeRegex(query)
  }
  const contextTerms = raw.context_terms === undefined ? [] : raw.context_terms
  if (!Array.isArray(contextTerms) || contextTerms.length > 8 || contextTerms.some((item) => !normalizeText(item))) {
    throw Object.assign(new Error('context_terms 必须是最多 8 项的非空字符串数组'), { code: 'INVALID_REQUEST' })
  }
  if (contextTerms.length && !query && !filters.speakers.length && !filters.entity_names.length) {
    throw Object.assign(new Error('context_terms 需要 query、speakers 或 entity_names 作为主条件'),
      { code: 'INVALID_REQUEST' })
  }
  if (!query && filters.wiki_sections.length > 1) {
    throw Object.assign(new Error('无 query 的完整字段查询一次只能选择一个 wiki_sections 值'),
      { code: 'INVALID_REQUEST' })
  }
  return {
    query, filters, match_mode: matchMode,
    context_terms: [...new Set(contextTerms.map(normalizeText))],
  }
}

function cursorVersionTag(dataVersion) {
  return createHash('sha256').update(String(dataVersion)).digest().subarray(0, 12).toString('base64url')
}

function compactCursorRequest(request) {
  const filters = {}
  for (const [field, key] of Object.entries(CURSOR_FILTER_KEYS)) {
    if (request.filters[field]?.length) filters[key] = request.filters[field]
  }
  return [request.query || '', Object.keys(filters).length ? filters : 0,
    request.match_mode === 'regex' ? 'r' : 0,
    request.context_terms?.length ? request.context_terms : 0]
}

function expandCursorRequest(compact) {
  if (!Array.isArray(compact) || compact.length !== 4) return null
  const [query, encodedFilters, mode, contextTerms] = compact
  if (typeof query !== 'string' || (encodedFilters !== 0
      && (!encodedFilters || typeof encodedFilters !== 'object' || Array.isArray(encodedFilters)))
      || ![0, 'r'].includes(mode) || (contextTerms !== 0 && !Array.isArray(contextTerms))) return null
  const filters = Object.fromEntries(Object.keys(CURSOR_FILTER_KEYS).map((field) => [field, []]))
  if (encodedFilters !== 0) {
    const reverse = Object.fromEntries(Object.entries(CURSOR_FILTER_KEYS).map(([field, key]) => [key, field]))
    for (const [key, values] of Object.entries(encodedFilters)) {
      const field = reverse[key]
      if (!field || !Array.isArray(values)) return null
      filters[field] = values
    }
  }
  return { query, filters, match_mode: mode === 'r' ? 'regex' : 'literal',
    context_terms: contextTerms === 0 ? [] : contextTerms }
}

function validCursorSignature(body, received, secret, bytes = 32) {
  const expected = createHmac('sha256', secret).update(body).digest().subarray(0, bytes)
  const encoded = String(received || '')
  let actual
  try { actual = Buffer.from(encoded, 'base64url') } catch { actual = Buffer.alloc(0) }
  return encoded === actual.toString('base64url')
    && actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function encodeOffsetCursor(store, request, offset) {
  const payload = [3, cursorVersionTag(store.dataVersion), offset, compactCursorRequest(request)]
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(payload)), { level: 9 })
  const encoded = compressed.toString('base64url')
  const body = `s3.${encoded}`
  const secret = await store.getOrCreateCursorSecret()
  const signature = createHmac('sha256', secret).update(body).digest().subarray(0, 16).toString('base64url')
  return `${body}.${signature}`
}

async function encodeScanCursor(store, request, nextDocumentOrdinal, matchedDocumentsSoFar) {
  const payload = [4, cursorVersionTag(store.dataVersion), DOCUMENT_ORDERING_VERSION,
    SEARCH_POLICY_FINGERPRINT, nextDocumentOrdinal, matchedDocumentsSoFar,
    compactCursorRequest(request)]
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(payload)), { level: 9 })
  const encoded = compressed.toString('base64url')
  const body = `s4.${encoded}`
  const secret = await store.getOrCreateCursorSecret()
  const signature = createHmac('sha256', secret).update(body).digest()
    .subarray(0, 16).toString('base64url')
  return `${body}.${signature}`
}

async function decodeCursor(store, cursor) {
  if (String(cursor).length > CURSOR_MAX_LENGTH) {
    throw Object.assign(new Error('cursor 超过长度上限'), { code: 'CURSOR_INVALID' })
  }
  const secret = await store.getOrCreateCursorSecret()
  const parts = String(cursor).split('.')
  if (parts.length === 3 && parts[0] === 's4') {
    const body = `${parts[0]}.${parts[1]}`
    if (!validCursorSignature(body, parts[2], secret, 16)) {
      throw Object.assign(new Error('cursor 签名无效'), { code: 'CURSOR_INVALID' })
    }
    let value
    try {
      value = JSON.parse(inflateRawSync(Buffer.from(parts[1], 'base64url'),
        { maxOutputLength: CURSOR_MAX_INFLATED }).toString('utf8'))
    } catch {
      throw Object.assign(new Error('cursor 无法解析'), { code: 'CURSOR_INVALID' })
    }
    const request = Array.isArray(value) ? expandCursorRequest(value[6]) : null
    if (value?.[0] !== 4 || !request || !Number.isInteger(value[4]) || value[4] < 0
        || !Number.isInteger(value[5]) || value[5] < 0) {
      throw Object.assign(new Error('cursor 内容无效'), { code: 'CURSOR_INVALID' })
    }
    if (value[1] !== cursorVersionTag(store.dataVersion)) {
      throw Object.assign(new Error('cursor 绑定到另一个资料版本'),
        { code: 'CURSOR_VERSION_MISMATCH' })
    }
    if (value[2] !== DOCUMENT_ORDERING_VERSION || value[3] !== SEARCH_POLICY_FINGERPRINT) {
      throw Object.assign(new Error('cursor 绑定的排序或搜索策略已经变化，请重新搜索'),
        { code: 'CURSOR_POLICY_MISMATCH' })
    }
    return { kind: 'scan', request, nextDocumentOrdinal: value[4],
      matchedDocumentsSoFar: value[5] }
  }
  if (parts.length === 3 && parts[0] === 's3') {
    const body = `${parts[0]}.${parts[1]}`
    if (!validCursorSignature(body, parts[2], secret, 16)) {
      throw Object.assign(new Error('cursor 签名无效'), { code: 'CURSOR_INVALID' })
    }
    let value
    try {
      value = JSON.parse(inflateRawSync(Buffer.from(parts[1], 'base64url'),
        { maxOutputLength: CURSOR_MAX_INFLATED }).toString('utf8'))
    } catch {
      throw Object.assign(new Error('cursor 无法解析'), { code: 'CURSOR_INVALID' })
    }
    const request = Array.isArray(value) ? expandCursorRequest(value[3]) : null
    if (value?.[0] !== 3 || value[1] !== cursorVersionTag(store.dataVersion)
        || !Number.isInteger(value[2]) || value[2] < 0 || !request) {
      throw Object.assign(new Error(value?.[1] !== cursorVersionTag(store.dataVersion)
        ? 'cursor 绑定到另一个资料版本' : 'cursor 内容无效'),
      { code: value?.[1] !== cursorVersionTag(store.dataVersion)
        ? 'CURSOR_VERSION_MISMATCH' : 'CURSOR_INVALID' })
    }
    return { kind: 'legacy', request, offset: value[2] }
  }

  // v2 长游标兼容：已发给模型或持久化在旧会话中的 cursor 仍可继续分页。
  const [body, received] = parts
  if (parts.length !== 2 || !validCursorSignature(body || '', received, secret)) {
    throw Object.assign(new Error('cursor 签名无效'), { code: 'CURSOR_INVALID' })
  }
  let value
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch {
    throw Object.assign(new Error('cursor 无法解析'), { code: 'CURSOR_INVALID' })
  }
  if (value.data_version !== store.dataVersion) {
    throw Object.assign(new Error('cursor 绑定到另一个资料版本'), { code: 'CURSOR_VERSION_MISMATCH' })
  }
  if (value.v !== 2 || value.tool !== 'corpus_search' || !value.request
      || !Number.isInteger(value.offset) || value.offset < 0) {
    throw Object.assign(new Error('cursor 内容无效'), { code: 'CURSOR_INVALID' })
  }
  return { kind: 'legacy', request: value.request, offset: value.offset }
}

function documentMatches(document, speakers, filters) {
  if (!resourceMatches(document, filters.resource_types)) return false
  for (const [filter, field] of Object.entries(FILTER_FIELDS)) {
    if (filters[filter].length && !filters[filter].includes(normalizeText(document[field]))) return false
  }
  const wikiRole = wikiDocumentRole(document)
  if (filters.character_names.length && wikiRole !== 'character_activity'
      && !filters.character_names.includes(normalizeText(document.character_name))) return false
  if (filters.activity_names.length) {
    const activity = { ...document, activity_name: wikiActivityName(document)
      || normalizeText(document.activity_name) }
    if (!filters.activity_names.some((name) => activityMatches(activity, name))) return false
  }
  if (filters.wiki_sections.length && !wikiRole) return false
  return !filters.speakers.length || filters.speakers.some((speaker) => speakers.includes(speaker))
}

function hydratedRecordMatches(record, filters) {
  if (filters.character_names.length && wikiDocumentRole(record.document) === 'character_activity'
      && !filters.character_names.includes(normalizeText(wikiCharacterName(record)))) return false
  return true
}

function lineContent(line) {
  const text = normalizeText(line.text)
  const prefix = `${normalizeText(line.speaker_raw)}:`
  return line.line_type === 'dialogue' && prefix !== ':' && text.startsWith(prefix)
    ? text.slice(prefix.length).trimStart() : text
}

function matchesText(text, query, mode, regex) {
  if (!query) return true
  if (mode === 'regex') return regex.test(normalizeText(text))
  const haystack = normalizeText(text).toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  return haystack.includes(needle)
}

function aliasNearQuery(text, alias, queryRange) {
  const haystack = normalizeText(text)
  if (!queryRange) return haystack.includes(alias)
  let offset = haystack.indexOf(alias)
  while (offset >= 0) {
    const end = offset + alias.length
    const distance = end < queryRange.start ? queryRange.start - end
      : offset > queryRange.end ? offset - queryRange.end : 0
    if (distance <= ENTITY_QUERY_MAX_DISTANCE) return true
    offset = haystack.indexOf(alias, offset + 1)
  }
  return false
}

function textAliases(entity) {
  const aliases = [...new Set(entity.aliases.map(normalizeText).filter(Boolean))]
  const longer = aliases.filter((alias) => [...alias].length > 1)
  return longer.length ? longer : aliases
}

function entityOccurrence(record, line, entityGroups, queryPresent, queryRange = null) {
  if (!entityGroups.length) return null
  for (const stored of line.entity_occurrences ?? []) {
    const entity = entityGroups.find((item) => item.canonical === stored.canonical_name
      || item.aliases.includes(stored.raw_name))
    if (!entity) continue
    const rawName = String(stored.raw_name || '')
    if (queryPresent && stored.evidence_kind !== 'speaker'
        && !aliasNearQuery(line.text, rawName, queryRange)) continue
    return {
      entity_id: String(stored.entity_id || ''), canonical_entity: entity.canonical,
      matched_alias: rawName, presence_status: String(stored.presence_status || ''),
      evidence_kind: String(stored.evidence_kind || ''), occurrence_id: String(stored.occurrence_id || ''),
      confidence: Number(stored.confidence || 0),
      ...(stored.ambiguity_candidates?.length
        ? { ambiguity_candidates: stored.ambiguity_candidates.map((item) => String(item)) } : {}),
    }
  }
  for (const entity of entityGroups) {
    const speakerAlias = entity.aliases.find((alias) => line.speaker_raw === alias)
    if (speakerAlias) return { canonical_entity: entity.canonical, matched_alias: speakerAlias,
      presence_status: 'explicit', evidence_kind: 'speaker' }
    const textAlias = textAliases(entity).find((alias) =>
      aliasNearQuery(line.text, alias, queryPresent ? queryRange : null))
    if (textAlias) return { canonical_entity: entity.canonical, matched_alias: textAlias,
      presence_status: 'mentioned', evidence_kind: 'text_mention' }
    if (!queryPresent && entity.aliases.includes(String(record.document.character_name || ''))
        && line.line_number === 1) {
      return { canonical_entity: entity.canonical,
        matched_alias: String(record.document.character_name || entity.canonical),
        presence_status: 'explicit', evidence_kind: 'metadata_link' }
    }
  }
  return null
}

function lineMatch(record, index, request, regex, entityGroups) {
  const line = record.lines[index]
  if (request.filters.speakers.length && !request.filters.speakers.includes(line.speaker_raw)) return null
  const content = lineContent(line)
  if (!matchesText(content, request.query, request.match_mode, regex)) return null
  let start = null
  let end = null
  if (request.query) {
    if (regex) {
      const match = new RegExp(regex.source, regex.flags).exec(normalizeText(content))
      if (match) { start = match.index; end = match.index + match[0].length }
    } else {
      const haystack = normalizeText(content).toLocaleLowerCase()
      const needle = request.query.toLocaleLowerCase()
      start = haystack.indexOf(needle)
      // 区间终点必须用归一化后 needle 的长度：toLocaleLowerCase 可能改变长度
      // （如土耳其语 İ → i̇），用原 query 长度会让实体邻近度判定错位。
      end = start + needle.length
    }
  }
  const occurrence = entityOccurrence(record, line, entityGroups, Boolean(request.query),
    start === null ? null : { start, end })
  if (entityGroups.length && !occurrence) return null
  if (!request.context_terms.length) return { occurrence, start, end }
  const nearby = record.lines.slice(Math.max(0, index - 3), index + 4)
  const constraintLines = []
  for (const term of request.context_terms) {
    const found = nearby.find((item) => normalizeText(item.text).toLocaleLowerCase()
      .includes(term.toLocaleLowerCase()))
    if (!found) return null
    constraintLines.push(found.line_number)
  }
  return { occurrence, start, end, constraint_lines: [...new Set(constraintLines)] }
}

function relevanceScore(match, request, field) {
  if (field === 'title') return match.exact ? 1 : 0.96
  let score = !request.query ? 0.5 : request.match_mode === 'regex' ? 0.7 : 1
  if (Number(match.start) > 0) score -= Math.min(0.2, Number(match.start) / 200)
  if (match.occurrence?.evidence_kind === 'speaker') score += 0.3
  else if (match.occurrence?.presence_status === 'explicit') score += 0.2
  else if (match.occurrence?.presence_status === 'mentioned') score += 0.05
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000))
}

function queryableEntities(record, maximum = 24) {
  const entities = new Map()
  const remember = (value) => {
    const name = String(value.canonical_name || value.canonical_entity || '').trim()
    const entityId = String(value.entity_id || '').trim()
    if (!name && !entityId) return
    const key = entityId || `name:${name}`
    const existing = entities.get(key) || { entity_id: entityId, name,
      entity_type: String(value.entity_type || ''), presence_statuses: [] }
    const status = String(value.presence_status || '')
    if (status && !existing.presence_statuses.includes(status)) existing.presence_statuses.push(status)
    entities.set(key, existing)
  }
  for (const line of record.lines ?? []) for (const occurrence of line.entity_occurrences ?? []) remember(occurrence)
  if (record.document.character_name) remember({ canonical_name: record.document.character_name,
    entity_id: record.document.char_id || '', entity_type: 'character', presence_status: 'explicit' })
  const all = [...entities.values()]
  return { total: all.length, shown: all.slice(0, maximum), truncated: all.length > maximum }
}

function clusterPassages(candidates, forcedTruncated = false) {
  const clusters = []
  for (const candidate of candidates) {
    const constraintLines = candidate.match?.constraint_lines || []
    const candidateStart = Math.min(candidate.line.line_number, ...constraintLines)
    const candidateEnd = Math.max(candidate.line.line_number, ...constraintLines)
    const previous = clusters.at(-1)
    if (previous && candidateStart - previous.end <= PASSAGE_CLUSTER_GAP) {
      previous.end = Math.max(previous.end, candidateEnd)
      previous.candidates.push(candidate)
      if (candidate.score > previous.best.score) previous.best = candidate
    } else clusters.push({ start: candidateStart, end: candidateEnd, candidates: [candidate], best: candidate })
  }
  const ranked = clusters.sort((left, right) => right.best.score - left.best.score
    || left.start - right.start)
  return ranked.slice(0, MAX_PASSAGES_PER_DOCUMENT).map((cluster) => ({ ...cluster.best,
    passage_start: cluster.start, passage_end: cluster.end,
    passage_match_count: cluster.candidates.length,
    match_lines: [...new Set(cluster.candidates.map((item) => item.line.line_number))],
    constraint_lines: [...new Set(cluster.candidates.flatMap((item) => item.match?.constraint_lines || []))],
    document_passages_truncated: forcedTruncated || ranked.length > MAX_PASSAGES_PER_DOCUMENT }))
}

function searchableTitleText(document) {
  return [document.display_title, document.story_name, document.activity_name,
    document.character_name, document.story_code, document.part_label]
    .map((item) => normalizeText(item)).filter(Boolean).join('\n')
}

function lineAllowed(line, filters) {
  return !filters.speakers.length || filters.speakers.includes(line.speaker_raw)
}

function readableAnchor(record, filters) {
  const eligible = (line) => normalizeText(line.text) && lineAllowed(line, filters)
  return record.lines.find((line) => line.line_type === 'dialogue' && eligible(line))
    || record.lines.find(eligible) || null
}

function documentTitle(document) {
  return naturalDocumentTitle(document)
}

function publicResourceType(document) {
  const type = String(document.document_type || '')
  const kind = String(document.document_kind || '')
  const category = String(document.document_category || '')
  if (type === 'story') return category === 'memory' ? 'operator_record' : 'story'
  if (type === 'character') {
    if (category === '模组文案') return 'character_module'
    if (category === '干员语音') return 'character_voice'
    if (category === '时装文案') return 'character_skin'
    return 'character_profile'
  }
  if (type === 'knowledge' && kind === 'wiki') {
    const role = wikiDocumentRole(document)
    return role === 'story' ? 'story_wiki'
      : role === 'character_activity' ? 'character_activity_wiki' : 'character_wiki'
  }
  if (type === 'knowledge' && kind === 'terra_journey') return 'terra_journey'
  if (type === 'entity') return 'entity_profile'
  return 'reference'
}

function boundedSummaryText(value, maximum) {
  const text = normalizeText(value)
  if (!text || maximum <= 0) return { text: '', truncated: Boolean(text) }
  const characters = [...text]
  return characters.length <= maximum
    ? { text, truncated: false }
    : { text: `${characters.slice(0, Math.max(0, maximum - 1)).join('')}…`, truncated: true }
}

function publicEntitySummary(record, maximum = 2400) {
  const entity = record.entity || {}
  const attributes = entity.attributes || {}
  const canonicalName = normalizeText(entity.canonical_name || record.document.display_title)
  const description = boundedSummaryText(attributes.description || entity.description, Math.min(800, maximum))
  const remaining = Math.max(0, maximum - [...description.text].length)
  const history = boundedSummaryText(attributes.history_summary || entity.history_summary,
    Math.min(1600, remaining))
  return {
    canonical_name: canonicalName,
    ...(description.text ? { description: description.text } : {}),
    ...(history.text && history.text !== description.text ? { history_summary: history.text } : {}),
    truncated: description.truncated || history.truncated,
    citation: `《${naturalDocumentTitle(record.document)}》`,
  }
}

function evidenceKind(document, field, occurrence) {
  const resource = publicResourceType(document)
  if (field === 'catalog' || field === 'title') return 'catalog'
  if (occurrence?.evidence_kind === 'metadata_link') return 'entity_projection'
  if (resource.endsWith('_wiki')) return 'wiki_curated'
  if (resource === 'story' || resource === 'operator_record') return 'official_canonical'
  if (resource.startsWith('character_')) return 'official_structured'
  return 'wiki_curated'
}

function matchKind(item, request) {
  if (item.field === 'title') return 'title'
  if (item.field === 'catalog') return 'catalog'
  if (item.wiki_section) return 'section'
  if (item.match?.occurrence?.evidence_kind === 'speaker') return 'entity_speaker'
  if (item.match?.occurrence?.evidence_kind === 'text_mention') return 'entity_mention'
  if (item.match?.occurrence) return 'entity_projection'
  if (!request.query && request.filters.speakers.length) return 'speaker'
  return request.match_mode === 'regex' ? 'regex' : 'literal'
}

function excerpt(record, item, bounds = null) {
  const start = Math.max(bounds?.start_line || 1, item.passage_start - PREVIEW_OPTIONS.before_lines)
  const end = Math.min(bounds?.end_line || record.lines.length,
    item.passage_end + PREVIEW_OPTIONS.after_lines)
  let truncated = false
  const lines = record.lines.slice(start - 1, end).map((line) => {
    const raw = String(lineContent(line) || '')
    const text = [...raw].length > PREVIEW_OPTIONS.max_chars_per_line
      ? `${[...raw].slice(0, PREVIEW_OPTIONS.max_chars_per_line).join('')}…` : raw
    if (text !== raw) truncated = true
    return { line: line.line_number,
      role: item.match_lines?.includes(line.line_number) ? 'match'
        : item.constraint_lines?.includes(line.line_number) ? 'constraint' : 'context',
      line_type: line.line_type ?? '', speaker: line.speaker_raw ?? '', text,
      truncated: text !== raw }
  })
  return { lines, characters: lines.reduce((total, line) => total + line.text.length, 0), truncated }
}

async function executeLegacySearch(store, request, offset, { signal, requestId = null } = {}) {
  const started = Date.now()
  const resolvedRequestId = String(requestId || `req-${createHash('sha256')
    .update(`${started}:${Math.random()}`).digest('hex').slice(0, 16)}`)
  try {
    await store.ready()
    const deadline = Date.now() + SEARCH_TIMEOUT_MS
    const entityAliasGroups = await aliasesFor(store, request.filters.entity_names)
    const catalogMode = !request.query && !request.filters.speakers.length && !entityAliasGroups.length
    // regex 模式的 query 是模式文本而非字面量，跳过 trigram 预过滤（与浏览器一致）。
    // 资料包缺失 search-index 时同样跳过倒排：此时倒排空结果不代表正文零命中，
    // 不能据此把搜索降级成"仅标题兜底"。
    const regex = request.match_mode === 'regex'
      ? new RegExp(safeRegex(request.query).source, 'iu') : null
    const indexAvailable = store.hasTrigramIndex
    const queryTrigrams = trigramsFor(request.query)
    const rankPoolCap = request.query && !regex && !queryTrigrams.length
      ? SHORT_LITERAL_RANK_POOL_CAP : RANK_POOL_CAP
    const indexed = request.query && !regex && indexAvailable
      ? queryTrigrams.length
        ? await store.findDocumentsByTrigrams(queryTrigrams)
        : await store.findDocumentsByShortLiteral?.(request.query) ?? null
      : null
    const hasLineScope = request.filters.speakers.length || request.filters.entity_names.length
      || request.filters.wiki_sections.length || request.context_terms.length
    const titleIds = request.query && !hasLineScope ? [...store.documents.entries()]
      .filter(([, item]) => documentMatches(item.document, [], request.filters)
        && matchesText(searchableTitleText(item.document), request.query, request.match_mode, regex))
      .map(([id]) => id) : []
    // 正文倒排与标题候选取并集；索引不可用时回退全量扫描。
    const documentIds = indexed !== null ? [...new Set([...indexed, ...titleIds])] : null
    const pool = []
    let scannedDocuments = 0
    let scannedLines = 0
    for await (const record of store.iterateDocuments({
      documentIds,
      predicate: (document, speakers) => documentMatches(document, speakers, request.filters),
    })) {
      if (signal?.aborted) throw Object.assign(new Error('搜索已取消'), { code: 'CANCELLED' })
      scannedDocuments += 1
      if (!hydratedRecordMatches(record, request.filters)) continue
      if (store.isPreferredNaturalDocument?.(record.document.document_id) === false) continue
      const sectionRanges = request.filters.wiki_sections.length
        ? wikiSectionRanges(record, request.filters.wiki_sections) : []
      if (request.filters.wiki_sections.length && !sectionRanges.length) continue
      const title = documentTitle(record.document)
      const titleText = searchableTitleText(record.document)
      if (request.query && !hasLineScope
          && matchesText(titleText, request.query, request.match_mode, regex)) {
        const firstSection = sectionRanges[0] || null
        const anchor = firstSection
          ? record.lines.slice(firstSection.start_line - 1, firstSection.end_line)
            .find((line) => normalizeText(line.text))
          : readableAnchor(record, request.filters)
        if (anchor) {
          const exact = normalizeText(record.document.story_name) === request.query
            || normalizeText(record.document.display_title) === request.query
          pool.push({ record, line: anchor, score: relevanceScore({ exact }, request, 'title'),
            field: 'title', passage_start: anchor.line_number, passage_end: anchor.line_number,
            passage_match_count: 1, match: { occurrence: null, start: null, end: null },
            ...(firstSection ? { wiki_section: firstSection } : {}) })
        }
      }
      // 此处曾有一段"倒排可用且零命中即跳过正文扫描"的分支，但其条件
      // （documentIds === null 且倒排可用）在控制流上不可达：倒排可用时
      // documentIds 恒为非空并集。作为死代码删除，不影响行为。
      if (catalogMode) {
        if (sectionRanges.length) {
          for (const section of sectionRanges) {
            const anchor = record.lines.slice(section.start_line - 1, section.end_line)
              .find((line) => normalizeText(line.text))
            if (anchor) pool.push({ record, line: anchor, score: 1, field: 'wiki_section',
              passage_start: section.start_line, passage_end: section.end_line,
              passage_match_count: 1, match: { occurrence: null, start: null, end: null },
              wiki_section: section })
          }
          if (pool.length >= rankPoolCap) break
          continue
        }
        const anchor = readableAnchor(record, request.filters)
        if (anchor) pool.push({ record, line: anchor, score: 1, field: 'catalog',
          passage_start: anchor.line_number, passage_end: anchor.line_number,
          passage_match_count: 1, match: { occurrence: null, start: null, end: null } })
        if (pool.length >= rankPoolCap) break
        continue
      }
      const documentMatches = []
      let documentMatchesTruncated = false
      for (let index = 0; index < record.lines.length; index += 1) {
        if ((index & 255) === 0) {
          if (signal?.aborted) throw Object.assign(new Error('搜索已取消'), { code: 'CANCELLED' })
          if (Date.now() > deadline) throw Object.assign(new Error('本地语料搜索超时'),
            { code: 'TIMEOUT', retryable: true })
        }
        scannedLines += 1
        const wikiSection = sectionRanges.length
          ? wikiSectionAt(sectionRanges, record.lines[index].line_number) : null
        if (sectionRanges.length && !wikiSection) continue
        const match = lineMatch(record, index, request, regex, entityAliasGroups)
        if (!match) continue
        documentMatches.push({ record, line: record.lines[index],
          score: relevanceScore(match, request, 'content'), field: request.query ? 'content'
            : match.occurrence ? 'entity' : 'speaker_raw', match,
          ...(wikiSection ? { wiki_section: wikiSection } : {}) })
        // 裸字面量采用 grep 的首批命中语义：单篇最多保留足够形成 3 个 passage
        // 的原始命中，避免“陈”一类高频字在一部长篇里耗尽整次工具预算。
        if (!hasLineScope && !regex
            && documentMatches.length >= SIMPLE_LITERAL_MATCH_CAP_PER_DOCUMENT) {
          documentMatchesTruncated = true
          break
        }
      }
      pool.push(...clusterPassages(documentMatches, documentMatchesTruncated))
      if (pool.length >= rankPoolCap) break
    }
    pool.sort((left, right) => right.score - left.score
      || String(left.record.document.collection_id || '').localeCompare(
        String(right.record.document.collection_id || ''), 'zh-CN', { numeric: true }))
    const resultKind = request.query ? 'text_matches'
      : request.filters.speakers.length || request.filters.entity_names.length
        ? 'structured_matches' : request.filters.wiki_sections.length
          ? 'complete_sections' : 'documents'
    const grouped = new Map()
    for (const item of pool) {
      const key = item.record.document.document_id
      const group = grouped.get(key) || { record: item.record, score: item.score, items: [] }
      group.score = Math.max(group.score, item.score)
      group.items.push(item)
      grouped.set(key, group)
    }
    const allDocuments = [...grouped.values()].sort((left, right) => right.score - left.score
      || String(left.record.document.collection_id || '').localeCompare(
        String(right.record.document.collection_id || ''), 'zh-CN', { numeric: true }))
    const pageGroups = allDocuments.slice(offset, offset + PAGE_DOCUMENTS)
    const documents = []
    const reasons = new Set()
    let returnedChars = 0
    for (const group of pageGroups) {
      if (documents.length && returnedChars >= PREVIEW_OPTIONS.max_total_chars) {
        reasons.add('output_chars')
        break
      }
      const metadata = group.record.document
      const title = naturalDocumentTitle(metadata)
      const result = {
        title, resource_type: publicResourceType(metadata),
        ...(metadata.activity_name ? { activity_name: metadata.activity_name } : {}),
        ...(metadata.character_name ? { character_name: metadata.character_name } : {}),
        matches: [], matches_truncated: group.items.some((item) => item.document_passages_truncated),
      }
      if (result.matches_truncated) reasons.add('document_passages')
      if (resultKind !== 'documents' && result.resource_type === 'entity_profile') {
        const remaining = Math.max(0, PREVIEW_OPTIONS.max_total_chars - returnedChars)
        result.entity_summary = publicEntitySummary(group.record, Math.min(2400, remaining))
        result.matches_truncated = false
        returnedChars += [...(result.entity_summary.description || '')].length
          + [...(result.entity_summary.history_summary || '')].length
        if (result.entity_summary.truncated) reasons.add('entity_summary')
      } else if (resultKind === 'complete_sections') {
        const section = group.items[0]?.wiki_section
        const lines = section ? group.record.lines.slice(section.start_line - 1, section.end_line)
          .filter((line) => normalizeText(line.text)) : []
        const blocks = []
        for (const line of lines) {
          const text = String(line.text || '')
          // 与 v4 路径一致按码点计数，避免含增补平面字符的行在两条路径下预算不一致
          const width = [...text].length
          if (returnedChars + width > PREVIEW_OPTIONS.max_total_chars) {
            reasons.add('section_content')
            break
          }
          blocks.push({ type: 'text', text })
          returnedChars += width
        }
        result.section_content = { section: section?.name || request.filters.wiki_sections[0],
          completeness: blocks.length === lines.length ? 'complete' : 'partial', blocks,
          citation: `《${title}》Wiki·${section?.name || request.filters.wiki_sections[0]}` }
      } else if (resultKind !== 'documents') {
        for (const item of group.items.slice(0, MAX_PASSAGES_PER_DOCUMENT)) {
          const titleOnly = item.field === 'title'
          const shown = titleOnly ? { lines: [], characters: 0, truncated: false }
            : excerpt(group.record, item, item.wiki_section)
          if (result.matches.length && returnedChars + shown.characters > PREVIEW_OPTIONS.max_total_chars) {
            result.matches_truncated = true
            reasons.add('output_chars')
            reasons.add('document_passages')
            break
          }
          if (shown.truncated) reasons.add('line_chars')
          const lineStart = item.passage_start
          const lineEnd = item.passage_end
          const sectionName = item.wiki_section?.name
          result.matches.push({
            ...(sectionName || titleOnly ? {} : { line_start: lineStart, line_end: lineEnd }),
            match_kind: matchKind(item, request),
            evidence_kind: evidenceKind(metadata, item.field, item.match?.occurrence),
            excerpt: shown.lines,
            citation: titleOnly ? `《${title}》`
              : sectionName ? `《${title}》Wiki·${sectionName}`
              : `《${title}》第 ${lineStart === lineEnd ? lineStart : `${lineStart}-${lineEnd}`} 行`,
          })
          returnedChars += shown.characters
        }
      }
      documents.push(result)
    }
    const hasMore = offset + documents.length < allDocuments.length
    if (hasMore) reasons.add('more_documents')
    if (pool.length >= rankPoolCap) reasons.add('document_passages')
    return {
      result_kind: resultKind, documents,
      page: { returned_documents: documents.length,
        total_relation: 'unknown', has_more: hasMore, exhausted: false,
        next_cursor: hasMore ? await encodeOffsetCursor(store, request, offset + documents.length) : null },
      truncated: true,
      truncation_reasons: [...new Set([...reasons, 'legacy_pool_incomplete'])],
    }
  } catch (error) {
    return { contract_version: SEARCH_CONTRACT_VERSION, status: 'error', request_id: resolvedRequestId,
      data_version: store.dataVersion ?? null,
      error: { code: error.code || 'INTERNAL_ERROR', message: error.message || String(error),
        retryable: error.retryable ?? false } }
  }
}

function resultKindFor(request) {
  if (request.query) return 'text_matches'
  if (request.filters.speakers.length || request.filters.entity_names.length) {
    return 'structured_matches'
  }
  return request.filters.wiki_sections.length ? 'complete_sections' : 'documents'
}

function lineScopeFor(request) {
  return Boolean(request.filters.speakers.length || request.filters.entity_names.length
    || request.filters.wiki_sections.length || request.context_terms.length)
}

async function candidateDocumentIds(store, request, regex) {
  const hasLineScope = lineScopeFor(request)
  // 结构化过滤只依赖初始化时保留的轻量 metadata，可以先安全缩小范围；
  // hydratedRecordMatches 仍在读取正文后复核 character_activity Wiki 等特殊项。
  const scopedIds = store.orderedDocumentIds().filter((documentId) => {
    const item = store.documents.get(documentId)
    return item && documentMatches(item.document, item.speakers, request.filters)
      && store.isPreferredNaturalDocument?.(documentId) !== false
  })
  const scoped = new Set(scopedIds)
  const titleIds = request.query && !hasLineScope ? scopedIds
    .filter((id) => matchesText(searchableTitleText(store.documents.get(id).document),
      request.query, request.match_mode, regex)) : []
  if (!request.query || regex || !store.hasTrigramIndex) return scopedIds
  const queryTrigrams = trigramsFor(request.query)
  // 1—2 字查询复用资料层的无损分片预筛。预筛不适用时返回 null，并回退
  // 稳定扫描；缓存只影响速度，候选最终始终恢复为全局 ordinal 顺序。
  const indexed = queryTrigrams.length
    ? await store.findDocumentsByTrigrams(queryTrigrams)
    : await store.findDocumentsByShortLiteral?.(request.query) ?? null
  if (indexed === null) return scopedIds
  return store.orderedDocumentIds([...new Set([...indexed.filter((id) => scoped.has(id)), ...titleIds])])
}

function collectDocumentGroup(record, request, regex, entityAliasGroups, deadline, signal = null) {
  if (!hydratedRecordMatches(record, request.filters)) return null
  const metadata = record.document
  const sectionRanges = request.filters.wiki_sections.length
    ? wikiSectionRanges(record, request.filters.wiki_sections) : []
  if (request.filters.wiki_sections.length && !sectionRanges.length) return null
  const hasLineScope = lineScopeFor(request)
  const catalogMode = !request.query && !request.filters.speakers.length && !entityAliasGroups.length
  const items = []
  const titleText = searchableTitleText(metadata)
  if (request.query && !hasLineScope
      && matchesText(titleText, request.query, request.match_mode, regex)) {
    const firstSection = sectionRanges[0] || null
    const anchor = firstSection
      ? record.lines.slice(firstSection.start_line - 1, firstSection.end_line)
        .find((line) => normalizeText(line.text))
      : readableAnchor(record, request.filters)
    if (anchor) {
      const exact = normalizeText(metadata.story_name) === request.query
        || normalizeText(metadata.display_title) === request.query
      items.push({ record, line: anchor, score: relevanceScore({ exact }, request, 'title'),
        field: 'title', passage_start: anchor.line_number, passage_end: anchor.line_number,
        passage_match_count: 1, match: { occurrence: null, start: null, end: null },
        ...(firstSection ? { wiki_section: firstSection } : {}) })
    }
  }
  if (catalogMode) {
    if (sectionRanges.length) {
      for (const section of sectionRanges) {
        const anchor = record.lines.slice(section.start_line - 1, section.end_line)
          .find((line) => normalizeText(line.text))
        if (anchor) items.push({ record, line: anchor, score: 1, field: 'wiki_section',
          passage_start: section.start_line, passage_end: section.end_line,
          passage_match_count: 1, match: { occurrence: null, start: null, end: null },
          wiki_section: section })
      }
    } else {
      const anchor = readableAnchor(record, request.filters)
      if (anchor) items.push({ record, line: anchor, score: 1, field: 'catalog',
        passage_start: anchor.line_number, passage_end: anchor.line_number,
        passage_match_count: 1, match: { occurrence: null, start: null, end: null } })
    }
  } else {
    const documentMatches = []
    let documentMatchesTruncated = false
    for (let index = 0; index < record.lines.length; index += 1) {
      if ((index & 255) === 0) {
        // 与 legacy 路径对齐：逐行扫描既响应外部取消，也受时间预算约束。
        if (signal?.aborted) throw Object.assign(new Error('搜索已取消'), { code: 'CANCELLED' })
        if (Date.now() > deadline) {
          throw Object.assign(new Error('本地语料搜索超时'), { code: 'TIMEOUT', retryable: true })
        }
      }
      const wikiSection = sectionRanges.length
        ? wikiSectionAt(sectionRanges, record.lines[index].line_number) : null
      if (sectionRanges.length && !wikiSection) continue
      const match = lineMatch(record, index, request, regex, entityAliasGroups)
      if (!match) continue
      documentMatches.push({ record, line: record.lines[index],
        score: relevanceScore(match, request, 'content'), field: request.query ? 'content'
          : match.occurrence ? 'entity' : 'speaker_raw', match,
        ...(wikiSection ? { wiki_section: wikiSection } : {}) })
      if (!hasLineScope && !regex
          && documentMatches.length >= SIMPLE_LITERAL_MATCH_CAP_PER_DOCUMENT) {
        documentMatchesTruncated = true
        break
      }
    }
    items.push(...clusterPassages(documentMatches, documentMatchesTruncated))
  }
  if (!items.length) return null
  items.sort((left, right) => (left.field === 'title') - (right.field === 'title')
    || right.score - left.score || left.passage_start - right.passage_start)
  return { record, score: Math.max(...items.map((item) => item.score)), items }
}

function previewLinesCost(lines) {
  return lines.reduce((total, line) => total + [...String(line.text || '')].length, 0)
}

/**
 * measureDocument 与 buildPublicDocument 共用同一份命中预览：此前两条路径
 * 各自构建 excerpt（切片 + NFKC 归一化 + 逐行截断），对同一候选文档做双倍
 * 字符串处理；首次计算后缓存在 item/group 上，构建阶段直接复用。
 */
function previewExcerpt(group, item) {
  if (!item.preview) item.preview = excerpt(group.record, item, item.wiki_section)
  return item.preview
}

/** complete_sections 的字段行列表；measure 与 build 共用，避免重复 slice+filter。 */
function sectionPreviewLines(group) {
  if (!group.sectionLines) {
    const section = group.items[0]?.wiki_section
    group.sectionLines = section ? group.record.lines.slice(section.start_line - 1, section.end_line)
      .filter((line) => normalizeText(line.text)) : []
  }
  return group.sectionLines
}

function fitLinesToBudget(lines, budget) {
  const fitted = lines.map((line) => ({ ...line }))
  while (previewLinesCost(fitted) > budget && fitted.some((line) => line.role === 'context')) {
    const lastContext = fitted.findLastIndex((line) => line.role === 'context')
    fitted.splice(lastContext, 1)
  }
  if (previewLinesCost(fitted) <= budget) return fitted
  const target = fitted.find((line) => line.role === 'match') || fitted[0]
  if (!target) return []
  const otherCost = previewLinesCost(fitted) - [...String(target.text || '')].length
  const allowed = Math.max(80, budget - otherCost)
  if ([...String(target.text || '')].length > allowed) {
    target.text = `${[...String(target.text || '')].slice(0, Math.max(1, allowed - 1)).join('')}…`
    target.truncated = true
  }
  return fitted
}

function measureDocument(group, resultKind, request) {
  if (resultKind !== 'documents' && publicResourceType(group.record.document) === 'entity_profile') {
    group.entitySummary ??= publicEntitySummary(group.record, 2400)
    return [...String(group.entitySummary.description || '')].length
      + [...String(group.entitySummary.history_summary || '')].length
  }
  if (resultKind === 'complete_sections') {
    return sectionPreviewLines(group)
      .reduce((total, line) => total + [...String(line.text || '')].length, 0)
  }
  if (resultKind === 'documents') return 0
  return group.items.slice(0, MAX_PASSAGES_PER_DOCUMENT).reduce((total, item) => {
    if (item.field === 'title') return total
    // 与 buildPublicDocument 的 previewLinesCost 同口径（码点计数），
    // 避免 UTF-16 估宽导致预算判定与实际构建不一致。
    return total + previewLinesCost(previewExcerpt(group, item).lines)
  }, 0)
}

function buildPublicDocument(group, resultKind, request, budget = Infinity) {
  const metadata = group.record.document
  const title = naturalDocumentTitle(metadata)
  const result = {
    title, resource_type: publicResourceType(metadata),
    ...(metadata.activity_name ? { activity_name: metadata.activity_name } : {}),
    ...(metadata.character_name ? { character_name: metadata.character_name } : {}),
    matches: [], matches_truncated: group.items.some((item) => item.document_passages_truncated),
  }
  const reasons = new Set()
  let characters = 0
  if (result.matches_truncated) reasons.add('document_passages')
  if (resultKind !== 'documents' && result.resource_type === 'entity_profile') {
    const cap = Math.min(2400, budget)
    result.entity_summary = cap === 2400 && group.entitySummary
      ? group.entitySummary : publicEntitySummary(group.record, cap)
    result.matches_truncated = false
    characters = [...String(result.entity_summary.description || '')].length
      + [...String(result.entity_summary.history_summary || '')].length
    if (result.entity_summary.truncated) reasons.add('entity_summary')
  } else if (resultKind === 'complete_sections') {
    const lines = sectionPreviewLines(group)
    const blocks = []
    for (const line of lines) {
      const text = String(line.text || '')
      if (characters + [...text].length > budget) {
        if (!blocks.length && budget > 0) {
          blocks.push({ type: 'text', text: `${[...text].slice(0, Math.max(1, budget - 1)).join('')}…` })
          characters = Math.min([...text].length, budget)
        }
        reasons.add('section_content')
        break
      }
      blocks.push({ type: 'text', text })
      characters += [...text].length
    }
    const sectionName = group.items[0]?.wiki_section?.name || request.filters.wiki_sections[0]
    result.section_content = { section: sectionName,
      completeness: blocks.length === lines.length ? 'complete' : 'partial', blocks,
      citation: `《${title}》Wiki·${sectionName}` }
  } else if (resultKind !== 'documents') {
    for (const item of group.items.slice(0, MAX_PASSAGES_PER_DOCUMENT)) {
      const titleOnly = item.field === 'title'
      const shown = titleOnly ? { lines: [], characters: 0, truncated: false }
        : previewExcerpt(group, item)
      if (result.matches.length && characters + shown.characters > budget) {
        result.matches_truncated = true
        reasons.add('output_chars')
        reasons.add('document_passages')
        break
      }
      const available = Math.max(0, budget - characters)
      const shownLines = shown.characters > available
        ? fitLinesToBudget(shown.lines, available) : shown.lines
      const shownCharacters = previewLinesCost(shownLines)
      if (shown.truncated || shownCharacters < shown.characters) reasons.add('line_chars')
      const lineStart = item.passage_start
      const lineEnd = item.passage_end
      const sectionName = item.wiki_section?.name
      result.matches.push({
        ...(sectionName || titleOnly ? {} : { line_start: lineStart, line_end: lineEnd }),
        match_kind: matchKind(item, request),
        evidence_kind: evidenceKind(metadata, item.field, item.match?.occurrence),
        excerpt: shownLines,
        citation: titleOnly ? `《${title}》`
          : sectionName ? `《${title}》Wiki·${sectionName}`
          : `《${title}》第 ${lineStart === lineEnd ? lineStart : `${lineStart}-${lineEnd}`} 行`,
      })
      characters += shownCharacters
    }
  }
  return { document: result, characters, reasons }
}

async function executeScanSearch(store, request, checkpoint, { signal, requestId = null } = {}) {
  const started = Date.now()
  const resolvedRequestId = String(requestId || `req-${createHash('sha256')
    .update(`${started}:${Math.random()}`).digest('hex').slice(0, 16)}`)
  try {
    const deadline = Date.now() + SEARCH_TIMEOUT_MS
    const regex = request.match_mode === 'regex'
      ? new RegExp(safeRegex(request.query).source, 'iu') : null
    const entityAliasGroups = await aliasesFor(store, request.filters.entity_names)
    const candidateIds = await candidateDocumentIds(store, request, regex)
    if (Date.now() > deadline) {
      throw Object.assign(new Error('本地语料搜索初始化超时'), { code: 'TIMEOUT', retryable: true })
    }
    const resultKind = resultKindFor(request)
    const documents = []
    const reasons = new Set()
    let characters = 0
    let scanned = 0
    let matchedDocuments = checkpoint.matchedDocumentsSoFar
    let nextDocumentOrdinal = checkpoint.nextDocumentOrdinal
    let stopped = false
    for (const documentId of candidateIds) {
      const ordinal = store.documentOrdinal(documentId)
      if (ordinal == null || ordinal < checkpoint.nextDocumentOrdinal) continue
      if (documents.length >= PAGE_DOCUMENTS || scanned >= SCAN_DOCUMENTS_PER_PAGE) {
        nextDocumentOrdinal = ordinal
        stopped = true
        break
      }
      if (signal?.aborted) throw Object.assign(new Error('搜索已取消'), { code: 'CANCELLED' })
      const location = store.documents.get(documentId)
      scanned += 1
      if (!location || !documentMatches(location.document, location.speakers, request.filters)
          || store.isPreferredNaturalDocument?.(documentId) === false) {
        nextDocumentOrdinal = ordinal + 1
        continue
      }
      const found = await store.getDocument(documentId)
      if (!found) {
        nextDocumentOrdinal = ordinal + 1
        continue
      }
      const group = collectDocumentGroup(found.record, request, regex, entityAliasGroups, deadline, signal)
      if (!group) {
        nextDocumentOrdinal = ordinal + 1
        continue
      }
      const remaining = Math.max(0, PREVIEW_OPTIONS.max_total_chars - characters)
      const measured = measureDocument(group, resultKind, request)
      if (documents.length && measured > remaining) {
        nextDocumentOrdinal = ordinal
        reasons.add('output_chars')
        stopped = true
        break
      }
      const built = buildPublicDocument(group, resultKind, request,
        documents.length ? remaining : PREVIEW_OPTIONS.max_total_chars)
      documents.push(built.document)
      characters += built.characters
      for (const reason of built.reasons) reasons.add(reason)
      matchedDocuments += 1
      nextDocumentOrdinal = ordinal + 1
    }
    const exhausted = !stopped
    if (!exhausted) reasons.add('scan_incomplete')
    const nextCursor = exhausted ? null
      : await encodeScanCursor(store, request, nextDocumentOrdinal, matchedDocuments)
    return {
      result_kind: resultKind,
      documents,
      page: {
        returned_documents: documents.length,
        ...(exhausted ? { total_documents: matchedDocuments } : {}),
        total_relation: exhausted ? 'eq' : 'unknown',
        has_more: !exhausted,
        exhausted,
        next_cursor: nextCursor,
      },
      truncated: reasons.size > 0,
      truncation_reasons: [...reasons],
    }
  } catch (error) {
    return { contract_version: SEARCH_CONTRACT_VERSION, status: 'error', request_id: resolvedRequestId,
      data_version: store.dataVersion ?? null,
      error: { code: error.code || 'INTERNAL_ERROR', message: error.message || String(error),
        retryable: error.retryable ?? false } }
  }
}

export async function executeSearch(store, raw, { signal, requestId = null } = {}) {
  try {
    await store.ready()
    const normalized = normalizedRequest(raw)
    if (normalized.cursor) {
      const decoded = await decodeCursor(store, normalized.cursor)
      if (decoded.kind === 'legacy') {
        return executeLegacySearch(store, decoded.request, decoded.offset, { signal, requestId })
      }
      return executeScanSearch(store, decoded.request, {
        nextDocumentOrdinal: decoded.nextDocumentOrdinal,
        matchedDocumentsSoFar: decoded.matchedDocumentsSoFar,
      }, { signal, requestId })
    }
    return executeScanSearch(store, normalized,
      { nextDocumentOrdinal: 0, matchedDocumentsSoFar: 0 }, { signal, requestId })
  } catch (error) {
    return { contract_version: SEARCH_CONTRACT_VERSION, status: 'error',
      request_id: String(requestId || ''), data_version: store.dataVersion ?? null,
      error: { code: error.code || 'INTERNAL_ERROR', message: error.message || String(error),
        retryable: error.retryable ?? false } }
  }
}

export function renderSearch(args, value) {
  if (value?.error) return [{ type: 'text', text: `[corpus_search:error] ${value.error.code}: ${value.error.message}` }]
  return [{ type: 'text', text: projectSearch(value, {
    query: normalizeText(args?.query),
  }) }]
}
