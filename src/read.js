/**
 * corpus_read 契约实现（corpus_tools_v1.schema.json，prts-corpus-tools-v1）。
 *
 * 与浏览器端 agent/browser/src/corpus-executor.js 语义对齐：
 *   - locator（source_ref / document_id / display_title 三选一）+ selection（around / range / document）
 *   - source_ref 内嵌行号在 around 模式下即中心行；document_id + around 必须显式给 center_line；
 *     display_title + around 的 center_line 可选（执行时缺失则报 LINE_RANGE_INVALID）
 *   - 全文行完整性校验（INDEX_CORRUPT）
 *   - expected_data_version 版本绑定（PACKAGE_VERSION_MISMATCH）
 *   - document 模式 HMAC 游标分页（插件生命周期内有效）
 *   - story 文档只返回请求的原文；剧情总结与时间线必须显式检索
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { computeLinesIntegrity, documentUid, naturalDocumentTitle } from './store.js'
import { WIKI_SECTION_VALUES, wikiSectionRanges } from './wiki.js'

export const CONTRACT_VERSION = 'prts-corpus-tools-v1'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_REF_PATTERN =
  /^(?:official_game:(?:story:[^:]+|character:[^:]+:[^:]+)|client_data:(?:reviewed_wiki|terra_journey|entities|references):[0-9a-f]{24}):L([1-9][0-9]*)$/

/** 游标签名密钥：插件实例生命周期内有效（重启即失效，符合契约的游标不透明语义）。 */
const CURSOR_SECRET = randomBytes(32)

/** 契约错误：映射为 errorResponse（status=error）。 */
export class ContractError extends Error {
  /**
   * @param {string} code toolError.code 枚举值
   * @param {string} message
   * @param {{ retryable?: boolean }} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.code = code
    this.retryable = options.retryable ?? false
  }
}

const estimateTokens = (value) => Math.ceil(
  (typeof value === 'number' ? value : String(value ?? '').length) / 2.5,
)

/** ---- 游标（document 模式分页） ---- */

function encodeCursor(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', CURSOR_SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

function decodeCursor(cursor) {
  const dot = cursor.lastIndexOf('.')
  if (dot <= 0) throw new ContractError('CURSOR_INVALID', 'malformed cursor')
  const [body, sig] = [cursor.slice(0, dot), cursor.slice(dot + 1)]
  // 与 search.js 的游标校验同口径：常数时间比较，长度不等先拒。
  const expected = createHmac('sha256', CURSOR_SECRET).update(body).digest()
  const received = Buffer.from(sig, 'base64url')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ContractError('CURSOR_INVALID', 'cursor signature mismatch')
  }
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw new ContractError('CURSOR_INVALID', 'cursor payload is not JSON')
  }
  if (typeof payload !== 'object' || payload === null || typeof payload.v !== 'number') {
    throw new ContractError('CURSOR_INVALID', 'cursor payload has unknown shape')
  }
  return payload
}

/** 模型只回传 cursor；在工具边界内部恢复文档 locator 与 document 模式。 */
export function readContractFromCursor(cursor) {
  const payload = decodeCursor(String(cursor || ''))
  if (payload.v !== 1 || typeof payload.document_id !== 'string' || !payload.document_id) {
    throw new ContractError('CURSOR_INVALID', 'cursor 不是单篇文档读取游标')
  }
  if (payload.max_lines !== undefined && !Number.isInteger(payload.max_lines)) {
    throw new ContractError('CURSOR_INVALID', 'cursor max_lines 无效')
  }
  if (payload.max_chars !== undefined && !Number.isInteger(payload.max_chars)) {
    throw new ContractError('CURSOR_INVALID', 'cursor max_chars 无效')
  }
  return { locator: { document_id: payload.document_id },
    selection: { mode: 'document', cursor: String(cursor) },
    limits: { ...(payload.max_lines !== undefined ? { max_lines: payload.max_lines } : {}),
      ...(payload.max_chars !== undefined ? { max_chars: payload.max_chars } : {}) } }
}

/** ---- 参数校验（跨字段规则由代码执行；DSL 只保证基础形态） ---- */

function requireInt(value, { min, max, field }) {
  if (!Number.isInteger(value)) throw new ContractError('INVALID_REQUEST', `${field} must be an integer`)
  if (value < min || value > max) {
    throw new ContractError('INVALID_REQUEST', `${field} must be within [${min}, ${max}]`)
  }
  return value
}

function requireIdString(value, field) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ContractError('INVALID_REQUEST', `${field} must match ${ID_PATTERN}`)
  }
  return value
}

/**
 * 校验并归一化 corpus_read 请求（填默认值，产出 normalized_request）。
 * @throws {ContractError}
 */
export function normalizeReadRequest(raw) {
  if (typeof raw !== 'object' || raw === null) {
    throw new ContractError('INVALID_REQUEST', 'request must be an object')
  }
  const { intent_id: intentId, request_id: requestIdInput, expected_data_version: expectedVersion } = raw

  const intentIdChecked = requireIdString(intentId, 'intent_id')
  const requestId = requestIdInput === undefined
    ? `req-${randomBytes(8).toString('hex')}`
    : requireIdString(requestIdInput, 'request_id')
  if (expectedVersion !== undefined && !SHA256_PATTERN.test(expectedVersion)) {
    throw new ContractError('INVALID_REQUEST', 'expected_data_version must be a lowercase sha256 hex string')
  }

  // locator：source_ref / document_id / display_title 恰好一个
  const locatorRaw = raw.locator
  if (typeof locatorRaw !== 'object' || locatorRaw === null) {
    throw new ContractError('INVALID_REQUEST', 'locator must be an object')
  }
  const hasSourceRef = locatorRaw.source_ref !== undefined
  const hasDocumentId = locatorRaw.document_id !== undefined
  const hasDisplayTitle = locatorRaw.display_title !== undefined
  const hasActivityId = locatorRaw.activity_id !== undefined
  const hasActivityName = locatorRaw.activity_name !== undefined
  const locatorCount = Number(hasSourceRef) + Number(hasDocumentId) + Number(hasDisplayTitle)
    + Number(hasActivityId) + Number(hasActivityName)
  if (locatorCount !== 1) {
    throw new ContractError('INVALID_REQUEST',
      'locator must contain exactly one of source_ref / document_id / display_title / activity_id / activity_name')
  }
  let locator
  let refLine = null
  if (hasSourceRef) {
    const sourceRef = locatorRaw.source_ref
    if (typeof sourceRef !== 'string' || sourceRef.length > 1024) {
      throw new ContractError('SOURCE_REF_INVALID', 'source_ref must be a string of at most 1024 chars')
    }
    const match = SOURCE_REF_PATTERN.exec(sourceRef)
    if (!match) throw new ContractError('SOURCE_REF_INVALID', `source_ref does not match contract pattern: ${sourceRef}`)
    refLine = Number.parseInt(match[1], 10)
    locator = { source_ref: sourceRef }
  } else if (hasDocumentId) {
    const documentId = locatorRaw.document_id
    if (typeof documentId !== 'string' || documentId.length < 1 || documentId.length > 512 || !/\S/.test(documentId)) {
      throw new ContractError('INVALID_REQUEST', 'document_id must be a non-empty identifier')
    }
    locator = { document_id: documentId }
  } else if (hasDisplayTitle) {
    const displayTitle = locatorRaw.display_title
    if (typeof displayTitle !== 'string' || displayTitle.length < 1 || displayTitle.length > 512 || !/\S/.test(displayTitle)) {
      throw new ContractError('INVALID_REQUEST', 'display_title must be a non-empty title of at most 512 chars')
    }
    locator = { display_title: displayTitle }
  } else if (hasActivityId) {
    const activityId = String(locatorRaw.activity_id).trim()
    if (!activityId || activityId.length > 512) {
      throw new ContractError('INVALID_REQUEST', 'activity_id must be a non-empty identifier of at most 512 chars')
    }
    locator = { activity_id: activityId }
  } else {
    const activityName = String(locatorRaw.activity_name).trim()
    if (!activityName || activityName.length > 512) {
      throw new ContractError('INVALID_REQUEST', 'activity_name must be a non-empty title of at most 512 chars')
    }
    locator = { activity_name: activityName }
  }

  // selection：around / range / document / section / activity
  const selectionRaw = raw.selection
  if (typeof selectionRaw !== 'object' || selectionRaw === null) {
    throw new ContractError('INVALID_REQUEST', 'selection must be an object')
  }
  const mode = selectionRaw.mode
  let selection
  if (mode === 'around') {
    if (hasSourceRef) {
      if (selectionRaw.center_line !== undefined) {
        throw new ContractError('INVALID_REQUEST', 'around with source_ref locator must not set center_line')
      }
      selection = {
        mode: 'around',
        before_lines: selectionRaw.before_lines ?? 3,
        after_lines: selectionRaw.after_lines ?? 3,
      }
    } else {
      // document_id：center_line 必填；display_title：center_line 可选（执行时缺失报错）
      if (hasDocumentId && selectionRaw.center_line === undefined) {
        throw new ContractError('INVALID_REQUEST', 'around with document_id locator requires center_line')
      }
      if (selectionRaw.center_line !== undefined) {
        requireInt(selectionRaw.center_line, { min: 1, max: 1e9, field: 'center_line' })
      }
      selection = {
        mode: 'around',
        ...(selectionRaw.center_line !== undefined ? { center_line: selectionRaw.center_line } : {}),
        before_lines: selectionRaw.before_lines ?? 3,
        after_lines: selectionRaw.after_lines ?? 3,
      }
    }
    requireInt(selection.before_lines, { min: 0, max: 100, field: 'before_lines' })
    requireInt(selection.after_lines, { min: 0, max: 100, field: 'after_lines' })
  } else if (mode === 'range') {
    const startLine = requireInt(selectionRaw.start_line, { min: 1, max: 1e9, field: 'start_line' })
    const endLine = requireInt(selectionRaw.end_line, { min: 1, max: 1e9, field: 'end_line' })
    if (endLine < startLine) throw new ContractError('LINE_RANGE_INVALID', 'end_line must be >= start_line')
    selection = { mode: 'range', start_line: startLine, end_line: endLine }
  } else if (mode === 'document') {
    selection = { mode: 'document', cursor: selectionRaw.cursor ?? null }
  } else if (mode === 'section') {
    if (hasActivityId || hasActivityName) {
      throw new ContractError('INVALID_REQUEST', 'section mode requires a document locator')
    }
    const section = String(selectionRaw.section || '').trim()
    if (!WIKI_SECTION_VALUES.includes(section)) {
      throw new ContractError('INVALID_REQUEST', 'section must be a supported Wiki field')
    }
    selection = { mode: 'section', section }
  } else if (mode === 'activity') {
    if (!hasActivityId && !hasActivityName) {
      throw new ContractError('INVALID_REQUEST', 'activity mode requires activity_id or activity_name locator')
    }
    selection = { mode: 'activity', cursor: selectionRaw.cursor ?? null }
  } else {
    throw new ContractError('INVALID_REQUEST', 'selection.mode must be around | range | document | section | activity')
  }

  const format = raw.format === undefined ? 'lines' : raw.format
  if (format !== 'lines' && format !== 'plain_text') {
    throw new ContractError('INVALID_REQUEST', 'format must be lines | plain_text')
  }

  const includeAdjacent = raw.include_adjacent_documents === undefined ? true : raw.include_adjacent_documents
  if (typeof includeAdjacent !== 'boolean') {
    throw new ContractError('INVALID_REQUEST', 'include_adjacent_documents must be a boolean')
  }

  const limitsRaw = raw.limits ?? {}
  if (typeof limitsRaw !== 'object' || limitsRaw === null) {
    throw new ContractError('INVALID_REQUEST', 'limits must be an object')
  }
  const limits = {
    max_lines: limitsRaw.max_lines ?? 100,
    max_chars: limitsRaw.max_chars ?? 12000,
  }
  requireInt(limits.max_lines, { min: 1, max: 500, field: 'limits.max_lines' })
  requireInt(limits.max_chars, { min: 100, max: 100000, field: 'limits.max_chars' })

  const normalized = {
    intent_id: intentIdChecked,
    request_id: requestId,
    locator,
    selection,
    format,
    include_adjacent_documents: includeAdjacent,
    limits,
  }
  if (expectedVersion !== undefined) normalized.expected_data_version = expectedVersion
  return { normalized, refLine }
}

/** ---- 文档摘要投影 ---- */

const SUMMARY_FIELDS = [
  'document_id', 'document_type', 'document_category', 'document_kind', 'display_title',
  'collection_id', 'activity_id', 'activity_name', 'source_story_id', 'story_id', 'story_code',
  'story_name', 'part_type', 'part_label', 'char_id', 'character_name', 'path', 'text_sha256',
  'line_count', 'sequence_index', 'sequence_source', 'sequence_confidence',
  'previous_document_id', 'next_document_id', 'source_ref_prefix', 'entity_id',
]

function toDocumentSummary(documentRecord) {
  const summary = { document_uid: documentUid(documentRecord.document_id) }
  // 与浏览器 executor.summary() 一致：固定摘要字段缺失时输出空字符串，
  // 不能把 undefined 带过 Harness 的 lossless-JSON 工具边界。
  for (const field of SUMMARY_FIELDS) summary[field] = documentRecord[field] ?? ''
  return summary
}

/** 由完整 record 构建文档摘要：实体文档的 entity_id 位于 record.entity 而非 document 上。 */
function recordSummary(record) {
  const summary = toDocumentSummary(record.document)
  if (record.document?.document_type === 'entity' && record.entity?.entity_id) {
    summary.entity_id = String(record.entity.entity_id)
  }
  return summary
}

/** ---- 执行 ---- */

/**
 * 执行 corpus_read。
 * @param {import('./store.js').CorpusStore} store
 * @param {object} rawArgs 模型原始参数
 * @param {{ signal?: AbortSignal }} runtime
 * @returns {Promise<object>} 契约响应（ok / error）
 */
export async function executeRead(store, rawArgs, runtime) {
  const startedAt = Date.now()
  try {
    await store.ready()
    const { normalized, refLine } = normalizeReadRequest(rawArgs)
    if (runtime.signal?.aborted) throw new ContractError('CANCELLED', 'aborted before execution')

    if (normalized.expected_data_version !== undefined && normalized.expected_data_version !== store.dataVersion) {
      throw new ContractError('PACKAGE_VERSION_MISMATCH',
        `expected data_version ${normalized.expected_data_version} but active release is ${store.dataVersion}`)
    }

    // 活动通读：枚举该活动全部 story 文档，按顺序跨文档读取/分页（不需要先定位单篇）。
    if (normalized.selection.mode === 'activity') {
      return await executeActivityRead(store, normalized, { runtime, startedAt })
    }

    // 定位文档
    let found
    if (normalized.locator.document_id !== undefined) {
      found = await store.getDocument(normalized.locator.document_id)
      if (found === null) throw new ContractError('DOCUMENT_NOT_FOUND', `document not found: ${normalized.locator.document_id}`)
    } else if (normalized.locator.display_title !== undefined) {
      try {
        found = await store.getDocumentByTitle(normalized.locator.display_title)
      } catch (error) {
        if (error?.code === 'DOCUMENT_AMBIGUOUS') {
          throw new ContractError('DOCUMENT_AMBIGUOUS', error.message)
        }
        throw error
      }
      if (found === null) {
        throw new ContractError('DOCUMENT_NOT_FOUND', `本地资料包中找不到展示标题对应的文档: ${normalized.locator.display_title}`)
      }
    } else {
      const sourceRef = normalized.locator.source_ref
      const prefix = sourceRef.slice(0, sourceRef.lastIndexOf(':L'))
      const documentId = store.getDocumentIdByPrefix(prefix)
      if (documentId === null) throw new ContractError('DOCUMENT_NOT_FOUND', `unknown source_ref prefix: ${prefix}`)
      found = await store.getDocument(documentId)
      if (found === null) throw new ContractError('DOCUMENT_NOT_FOUND', `document not found: ${documentId}`)
    }
    // GameData 把 [uc]info/ 一行式简介排在 obt/ 对话正文之前；document 模式
    // 命中简介时优先换成可读全文（与浏览器执行器 readableStoryRecord 一致）。
    let record = found.record
    if (normalized.selection.mode === 'document') {
      const sourceStoryId = String(record.document.source_story_id || '')
      if (record.document.document_kind === 'synopsis' && sourceStoryId.startsWith('[uc]info/')) {
        const fullStory = await store.getDocumentBySourceStoryId(sourceStoryId.slice('[uc]info/'.length))
        if (fullStory?.record?.document?.document_kind === 'story') record = fullStory.record
      }
    }

    const packId = found.packId
    const packManifest = store.packs.get(packId)
    const document = record.document
    const documentId = document.document_id
    const lineCount = document.line_count

    // 行完整性（全文）：行文本 \n 连接后 sha256 与 local_integrity 比对
    const actualIntegrity = computeLinesIntegrity(record.lines)
    const expectedIntegrity = record.local_integrity?.sha256
    const integrityVerified = expectedIntegrity === actualIntegrity
    if (!integrityVerified) {
      throw new ContractError('INDEX_CORRUPT', `integrity mismatch for ${documentId}: expected ${expectedIntegrity}, got ${actualIntegrity}`)
    }

    if (runtime.signal?.aborted) throw new ContractError('CANCELLED', 'aborted after integrity check')

    // 解析选区 → [startLine, endLine]
    const { selection } = normalized
    let startLine
    let endLine
    let cursorNextLine = null
    if (selection.mode === 'around') {
      const center = normalized.locator.source_ref !== undefined ? refLine : selection.center_line
      if (!center || center > lineCount) {
        throw new ContractError('LINE_RANGE_INVALID', `center line ${center ?? '(missing)'} is missing or beyond document length ${lineCount}`)
      }
      startLine = Math.max(1, center - selection.before_lines)
      endLine = Math.min(lineCount, center + selection.after_lines)
    } else if (selection.mode === 'range') {
      if (selection.start_line > lineCount) {
        throw new ContractError('LINE_RANGE_INVALID', `start_line ${selection.start_line} is beyond document length ${lineCount}`)
      }
      startLine = selection.start_line
      endLine = Math.min(lineCount, selection.end_line)
    } else if (selection.mode === 'section') {
      if (document.document_type !== 'knowledge' || document.document_kind !== 'wiki') {
        throw new ContractError('INVALID_REQUEST', 'section mode can only read Wiki documents')
      }
      const ranges = wikiSectionRanges(record, [selection.section])
      if (!ranges.length) {
        throw new ContractError('DOCUMENT_NOT_FOUND', `Wiki 文档“${document.display_title}”没有字段“${selection.section}”`)
      }
      if (ranges.length > 1) {
        throw new ContractError('DOCUMENT_AMBIGUOUS',
          `Wiki 文档“${document.display_title}”包含多个“${selection.section}”字段；请用 corpus_search 获取具体行范围`)
      }
      startLine = ranges[0].start_line
      endLine = ranges[0].end_line
    } else {
      let nextLine = 1
      if (selection.cursor !== null) {
        if (typeof selection.cursor !== 'string' || selection.cursor.length < 1 || selection.cursor.length > 4096) {
          throw new ContractError('CURSOR_INVALID', 'cursor must be a string of 1..4096 chars')
        }
        const payload = decodeCursor(selection.cursor)
        if (payload.v !== 1 || payload.document_id !== documentId || payload.data_version !== store.dataVersion) {
          throw new ContractError('CURSOR_VERSION_MISMATCH', 'cursor is bound to a different document or data_version')
        }
        nextLine = payload.next_line
        if (nextLine < 1 || nextLine > lineCount) {
          throw new ContractError('CURSOR_INVALID', `cursor next_line ${nextLine} is out of range`)
        }
      }
      startLine = nextLine
      endLine = lineCount
    }

    // 应用 limits 截取
    const { max_lines: maxLines, max_chars: maxChars } = normalized.limits
    const spanLines = endLine - startLine + 1
    let truncated = false
    let truncationReason = null
    let selectedEnd = endLine
    if (spanLines > maxLines) {
      selectedEnd = startLine + maxLines - 1
      truncated = true
      truncationReason = 'max_lines'
    }

    const selectedLines = []
    let charCount = 0
    for (let lineNumber = startLine; lineNumber <= selectedEnd; lineNumber += 1) {
      const line = record.lines[lineNumber - 1]
      if (charCount + line.text.length > maxChars) {
        truncated = true
        truncationReason = truncationReason ?? 'max_chars'
        break
      }
      charCount += line.text.length
      selectedLines.push(line)
    }
    // 首行即超过 max_chars 时不能返回“0 行 + 原地游标”的 ok 响应——document
    // 模式的 next_cursor 不会前进，模型分页会死循环。与 activity 模式一致
    // 上报预算不足，让调用方提高 max_chars 后重试。
    if (!selectedLines.length && truncated) {
      throw new ContractError('BUDGET_EXCEEDED',
        `读取范围内首行长度已超过 max_chars=${maxChars}；请提高 max_chars 后重试`)
    }
    const returned = selectedLines.length
    const hasMore = truncated || selectedEnd < endLine
    let nextCursor = null
    if (selection.mode === 'document' && hasMore) {
      cursorNextLine = startLine + returned
      nextCursor = encodeCursor({
        v: 1,
        document_id: documentId,
        data_version: store.dataVersion,
        next_line: cursorNextLine,
        max_lines: maxLines,
        max_chars: maxChars,
      })
    }

    // 内容投影
    let content
    if (normalized.format === 'plain_text') {
      content = { format: 'plain_text', text: selectedLines.map((line) => line.text).join('\n') }
    } else {
      content = {
        format: 'lines',
        lines: selectedLines.map((line) => ({
          line_number: line.line_number,
          line_type: line.line_type ?? '',
          speaker_raw: line.speaker_raw ?? '',
          text: line.text ?? '',
          source_ref: `${document.source_ref_prefix}:L${line.line_number}`,
        })),
      }
    }

    // 相邻文档摘要
    let adjacentDocuments
    if (normalized.include_adjacent_documents) {
      const previousId = document.previous_document_id || null
      const nextId = document.next_document_id || null
      const previous = previousId ? await store.getDocument(previousId) : null
      const next = nextId ? await store.getDocument(nextId) : null
      adjacentDocuments = {
        previous: previous ? toDocumentSummary(previous.record.document) : null,
        next: next ? toDocumentSummary(next.record.document) : null,
      }
    }

    return {
      contract_version: CONTRACT_VERSION,
      status: 'ok',
      request_id: normalized.request_id,
      data_version: store.dataVersion,
      package_schema_version: packManifest.package_schema_version ?? 1,
      index_schema_version: packManifest.index_schema_version ?? 1,
      normalized_request: normalized,
      document: recordSummary(record),
      selection: {
        mode: selection.mode,
        ...(selection.mode === 'section' ? { wiki_section: selection.section } : {}),
        line_start: returned > 0 ? selectedLines[0].line_number : startLine,
        line_end: returned > 0 ? selectedLines[returned - 1].line_number : startLine - 1,
        line_count: returned,
        character_count: charCount,
        truncated,
        ...(truncationReason ? { truncation_reason: truncationReason } : {}),
      },
      content,
      page: {
        limit: maxLines,
        returned,
        has_more: hasMore,
        next_cursor: nextCursor,
        total: selection.mode === 'document' ? lineCount : spanLines,
        total_relation: 'eq',
      },
      ...(adjacentDocuments ? { adjacent_documents: adjacentDocuments } : {}),
      integrity: {
        verified: integrityVerified,
        expected_text_sha256: expectedIntegrity,
        actual_text_sha256: actualIntegrity,
      },
      stats: {
        elapsed_ms: Date.now() - startedAt,
        scanned_documents: 1,
        scanned_lines: lineCount,
        returned_chars: charCount,
        estimated_input_tokens: estimateTokens(charCount),
        truncated,
      },
      warnings: [],
    }
  } catch (error) {
    if (error instanceof ContractError) {
      return {
        contract_version: CONTRACT_VERSION,
        status: 'error',
        request_id: typeof rawArgs?.request_id === 'string' ? rawArgs.request_id : `req-${randomBytes(8).toString('hex')}`,
        data_version: store.dataVersion ?? null,
        error: { code: error.code, message: error.message, retryable: error.retryable },
      }
    }
    if (error?.code === 'ENOENT' || /current\.json|release-manifest/.test(error?.message ?? '')) {
      return {
        contract_version: CONTRACT_VERSION,
        status: 'error',
        request_id: `req-${randomBytes(8).toString('hex')}`,
        data_version: null,
        error: { code: 'PACKAGE_NOT_INSTALLED', message: error.message, retryable: true },
      }
    }
    throw error // 基础设施故障交给宿主 isError
  }
}

/**
 * activity 模式：按活动枚举全部剧情 story 文档，按顺序跨文档读取并分页。
 * cursor 载荷统一为 { v, data_version, doc_index, next_line }，用于跨文档续读。
 */
async function executeActivityRead(store, normalized, { runtime, startedAt }) {
  const { selection } = normalized
  const { activity_id: activityId, activity_name: activityName } = normalized.locator
  const docs = store.activityStoryDocuments({ activityId, activityName })
  if (!docs.length) {
    throw new ContractError('DOCUMENT_NOT_FOUND',
      `本地资料包中找不到该活动的剧情原文：${activityName || activityId}`)
  }

  let docIndex = 0
  let startLine = 1
  if (selection.cursor !== null) {
    if (typeof selection.cursor !== 'string' || selection.cursor.length < 1 || selection.cursor.length > 4096) {
      throw new ContractError('CURSOR_INVALID', 'cursor must be a string of 1..4096 chars')
    }
    const payload = decodeCursor(selection.cursor)
    if (payload.v !== 2 || payload.data_version !== store.dataVersion) {
      throw new ContractError('CURSOR_VERSION_MISMATCH', 'cursor is bound to a different data_version')
    }
    if (!Number.isInteger(payload.doc_index) || payload.doc_index < 0 || payload.doc_index >= docs.length
        || !Number.isInteger(payload.next_line) || payload.next_line < 1) {
      throw new ContractError('CURSOR_INVALID', 'activity cursor payload is invalid')
    }
    docIndex = payload.doc_index
    startLine = payload.next_line
  }

  const { max_lines: maxLines, max_chars: maxChars } = normalized.limits
  const selectedLines = []
  const linesByDocument = []
  let charCount = 0
  let truncated = false
  let truncationReason = null
  let lastDocIndex = docIndex
  // 从 (docIndex, startLine) 起，按文档顺序连续收集行，直到达到行数/字符上限。
  for (let index = docIndex; index < docs.length; index += 1) {
    lastDocIndex = index
    if (runtime.signal?.aborted) throw new ContractError('CANCELLED', 'aborted during activity read')
    const found = await store.getDocument(docs[index].document.document_id)
    if (!found) continue
    const record = found.record
    const document = record.document
    // 与单文档路径同构的全文行完整性校验；不满足即资料损坏，不得继续通读。
    const actualIntegrity = computeLinesIntegrity(record.lines)
    if (record.local_integrity?.sha256 !== actualIntegrity) {
      throw new ContractError('INDEX_CORRUPT',
        `integrity mismatch for ${document.document_id}: expected ${record.local_integrity?.sha256}, got ${actualIntegrity}`)
    }
    const start = index === docIndex ? startLine : 1
    for (let number = start; number <= record.lines.length; number += 1) {
      const line = record.lines[number - 1]
      if (selectedLines.length >= maxLines) {
        truncated = true
        truncationReason = truncationReason ?? 'max_lines'
        break
      }
      if (charCount + line.text.length > maxChars) {
        truncated = true
        truncationReason = truncationReason ?? 'max_chars'
        break
      }
      charCount += line.text.length
      selectedLines.push(line)
      linesByDocument.push({ document, packId: found.packId })
    }
    if (truncated) break
  }
  if (!selectedLines.length) {
    throw new ContractError('BUDGET_EXCEEDED', '当前读取范围不能在字符/行数预算内完整返回')
  }

  const firstDocSummary = toDocumentSummary(linesByDocument[0].document)
  const lastDocLine = selectedLines[selectedLines.length - 1]
  const lastDoc = linesByDocument[linesByDocument.length - 1].document
  const totalLines = selectedLines.length
  // truncated 或当前文档内仍有下一页 → 从 (lastDocIndex, lastLine+1) 续读；
  // 否则若无更多文档，游标结束。
  const docHadMore = lastDocLine.line_number < lastDoc.line_count
  const hasMore = truncated || docHadMore || lastDocIndex + 1 < docs.length
  const nextCursor = hasMore
    ? encodeCursor({ v: 2, data_version: store.dataVersion, doc_index: lastDocIndex,
      next_line: lastDocLine.line_number + 1 })
    : null

  const activity = {
    activity_id: String(firstDocSummary.activity_id || firstDocSummary.collection_id || activityId || ''),
    activity_name: String(firstDocSummary.activity_name || activityName || ''),
    story_count: docs.length,
    total_lines: docs.reduce((total, doc) => total + Number(doc.document.line_count || 0), 0),
  }

  const content = normalized.format === 'plain_text'
    ? { format: 'plain_text', text: selectedLines.map((line) => line.text).join('\n') }
    : { format: 'lines', lines: selectedLines.map((line, index) => ({
      line_number: line.line_number,
      line_type: line.line_type ?? '',
      speaker_raw: line.speaker_raw ?? '',
      text: line.text ?? '',
      source_ref: `${linesByDocument[index].document.source_ref_prefix}:L${line.line_number}`,
    })) }

  const firstPackId = linesByDocument[0].packId
  const firstPackManifest = store.packs.get(firstPackId)
  // 各文档已按 local_integrity 逐篇校验（见上方 INDEX_CORRUPT）；此处对实际
  // 返回行文本再计算一次哈希，满足契约 sha256 字段。
  const returnedIntegrity = computeLinesIntegrity(selectedLines)

  return {
    contract_version: CONTRACT_VERSION,
    status: 'ok',
    request_id: normalized.request_id,
    data_version: store.dataVersion,
    package_schema_version: firstPackManifest?.package_schema_version ?? 1,
    index_schema_version: firstPackManifest?.index_schema_version ?? 1,
    normalized_request: normalized,
    document: firstDocSummary,
    selection: {
      mode: selection.mode,
      line_start: selectedLines[0].line_number,
      line_end: lastDocLine.line_number,
      line_count: selectedLines.length,
      character_count: charCount,
      truncated,
      ...(truncationReason ? { truncation_reason: truncationReason } : {}),
    },
    content,
    page: {
      limit: maxLines,
      returned: selectedLines.length,
      has_more: Boolean(nextCursor),
      next_cursor: nextCursor,
      total: docs.reduce((total, doc) => total + Number(doc.document.line_count || 0), 0),
      total_relation: 'eq',
    },
    activity,
    integrity: { verified: true, expected_text_sha256: returnedIntegrity,
      actual_text_sha256: returnedIntegrity },
    stats: {
      elapsed_ms: Date.now() - startedAt,
      scanned_documents: docs.length,
      scanned_lines: totalLines,
      returned_chars: charCount,
      estimated_input_tokens: estimateTokens(selectedLines.map((line) => line.text).join('\n')),
      truncated,
    },
    warnings: [],
  }
}

/** ---- 模型可见文本渲染 ---- */

/**
 * 模型可见的单行渲染格式（renderRead 使用）。evidence-state.js 的读取去重
 * 依赖在模型 surface 中检索同一格式的行标记，两处必须共用本函数，否则
 * 去重判定会与模型实际可见文本脱节。
 */
export function readableRenderedLine(line, marker = 'L') {
  const speaker = String(line.speaker_raw || '').trim()
  let text = String(line.text || '')
  if (speaker) {
    const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    text = text.replace(new RegExp(`^${escaped}\\s*[：:]\\s*`, 'u'), '')
  }
  return `${marker}${line.line_number} ${line.line_type || ''} ${speaker ? `${speaker}: ` : ''}${text}`
    .replace(/\s+$/u, '')
}

function publicLine(line) {
  const speaker = String(line.speaker_raw || '').trim()
  let text = String(line.text || '')
  if (speaker) {
    const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    text = text.replace(new RegExp(`^${escaped}\\s*[：:]\\s*`, 'u'), '')
  }
  return { line: line.line_number, line_type: line.line_type || '',
    speaker, text }
}

/** 执行层富响应 → 模型/程序共用的自然定位 public result。 */
export function projectReadPublic(value) {
  if (value?.status === 'error') return value
  if (value?.primary) return value
  const title = naturalDocumentTitle(value.document || {})
  const lines = value.content?.format === 'lines' ? (value.content.lines || []).map(publicLine) : []
  const kind = value.document?.document_type === 'story' ? 'official_story'
    : value.document?.document_type === 'knowledge' && value.document?.document_kind === 'wiki'
      ? 'wiki_curated' : 'local_document'
  return {
    primary: { title,
      kind,
      selection: { mode: value.selection?.mode, line_start: value.selection?.line_start,
        line_end: value.selection?.line_end,
        ...(value.selection?.wiki_section ? { section: value.selection.wiki_section } : {}),
        truncated: Boolean(value.selection?.truncated) },
      lines,
      ...(value.content?.format === 'plain_text' ? { text: value.content.text || '' } : {}),
      citation: value.selection?.wiki_section ? `《${title}》Wiki·${value.selection.wiki_section}`
        : `《${title}》第 ${value.selection?.line_start === value.selection?.line_end
          ? value.selection?.line_start : `${value.selection?.line_start}-${value.selection?.line_end}`} 行` },
    page: { returned_lines: Number(value.page?.returned || lines.length),
      has_more: Boolean(value.page?.has_more), next_cursor: value.page?.next_cursor || null },
  }
}

/**
 * 将契约响应渲染为模型可见文本（output.render 用）。
 * @param {object} _args
 * @param {object} value executeRead 的返回值
 */
export function renderRead(_args, value) {
  if (value?.status === 'error') {
    return [{
      type: 'text',
      text: `[corpus_read:error] code=${value.error.code} retryable=${value.error.retryable}\n${value.error.message}`,
    }]
  }
  const projected = projectReadPublic(value)
  const parts = []
  if (projected.primary) {
    const primary = projected.primary
    parts.push(`# ${primary.title}`)
    if (primary.kind === 'wiki_curated') {
      parts.push('引文状态：Wiki 为整理性资料；其中引号内容未核验为当前资料包官方原文，逐字引用前请回查原文。')
    }
    if (primary.selection?.section) parts.push(`字段：${primary.selection.section}`)
    else parts.push(`范围：第 ${primary.selection.line_start}-${primary.selection.line_end} 行`)
    for (const line of primary.lines || []) {
      parts.push(readableRenderedLine({ line_number: line.line, line_type: line.line_type,
        speaker_raw: line.speaker, text: line.text }))
    }
    if (primary.text) parts.push(primary.text)
    parts.push(`引用：${primary.citation}`)
    if (projected.page.has_more && projected.page.next_cursor) {
      parts.push(`下一页：corpus_read({cursor:"${projected.page.next_cursor}"})`)
    } else if (projected.page.has_more) {
      // around/range/section 模式被 max_lines/max_chars 截断时不产生游标，
      // 必须指明可执行的续读方式，否则模型会拿到 cursor:"null" 的无效指令。
      const title = String(primary.title || '').replace(/"/gu, '\\"')
      parts.push(`本次读取被 max_lines/max_chars 截断。继续读取：`
        + `corpus_read({title:"${title}", line:${primary.selection.line_end + 1}, before:0, after:100})`)
    }
    return [{ type: 'text', text: parts.join('\n') }]
  }
  return [{ type: 'text', text: '[corpus_read:error] 无法投影读取结果' }]
}
