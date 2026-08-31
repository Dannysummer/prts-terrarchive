import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeSearch } from '../src/search.js'

function fakeStore(records, { dataVersion = 'test-v1' } = {}) {
  const documents = new Map()
  const documentOrder = []
  records.forEach((record, ordinal) => {
    const id = record.document.document_id
    documentOrder.push(id)
    documents.set(id, { document: record.document, speakers: record.speakers || [], ordinal })
  })
  const secret = Buffer.alloc(32, 7)
  return {
    dataVersion,
    documents,
    documentOrder,
    hasTrigramIndex: false,
    async ready() {},
    orderedDocumentIds(ids = null) {
      if (ids == null) return [...documentOrder]
      const selected = new Set(ids)
      return documentOrder.filter((id) => selected.has(id))
    },
    documentOrdinal(id) { return documents.get(id)?.ordinal ?? null },
    isPreferredNaturalDocument() { return true },
    async getDocument(id) {
      const record = records[documents.get(id)?.ordinal]
      return record ? { record, packId: 'official_game' } : null
    },
    async getOrCreateCursorSecret() { return secret },
  }
}

function story(index, text) {
  return {
    document: {
      document_id: `story-${index}`, document_type: 'story', document_kind: 'story',
      document_category: 'main', activity_name: '测试活动', story_code: `T-${index}`,
      story_name: `测试篇章 ${index}`, display_title: `测试篇章 ${index}`,
    },
    speakers: [],
    lines: [{ line_number: 1, line_type: 'narration', speaker_raw: '', text }],
  }
}

async function exhaust(store, request) {
  const pages = []
  let value = await executeSearch(store, request)
  for (let calls = 0; ; calls += 1) {
    assert.ok(calls < 100, 'cursor chain did not exhaust')
    assert.equal(value.error, undefined)
    pages.push(value)
    if (value.page.exhausted) return pages
    assert.match(value.page.next_cursor, /^s4\./u)
    value = await executeSearch(store, { cursor: value.page.next_cursor })
  }
}

test('v4 可返回空进度页，并从下一未消费 ordinal 继续到精确穷尽', async () => {
  const records = Array.from({ length: 300 }, (_, index) =>
    story(index, index === 299 ? '最后一篇含有针尖' : '普通内容'))
  const store = fakeStore(records)
  const first = await executeSearch(store, { query: '针尖' })
  assert.deepEqual(first.documents, [])
  assert.equal(first.page.exhausted, false)
  assert.equal(first.page.total_relation, 'unknown')
  assert.equal(first.page.total_documents, undefined)
  assert.match(first.page.next_cursor, /^s4\./u)

  const replay = await executeSearch(store, { query: '针尖' })
  assert.deepEqual(replay, first)

  const final = await executeSearch(store, { cursor: first.page.next_cursor })
  assert.equal(final.page.exhausted, true)
  assert.equal(final.page.has_more, false)
  assert.equal(final.page.next_cursor, null)
  assert.equal(final.page.total_relation, 'eq')
  assert.equal(final.page.total_documents, 1)
  assert.deepEqual(final.documents.map((item) => item.title),
    ['测试活动 · T-299 · 测试篇章 299'])
})

test('v4 多页结果按文档稳定归并，全链不重不漏', async () => {
  const store = fakeStore(Array.from({ length: 30 }, (_, index) => story(index, `命中 ${index}`)))
  const pages = await exhaust(store, { query: '命中' })
  assert.deepEqual(pages.map((page) => page.documents.length), [12, 12, 6])
  const titles = pages.flatMap((page) => page.documents.map((document) => document.title))
  assert.equal(new Set(titles).size, 30)
  assert.equal(pages.at(-1).page.total_documents, 30)
  assert.equal(pages.at(-1).page.total_relation, 'eq')
  assert.ok(pages.slice(0, -1).every((page) => page.page.exhausted === false
    && page.truncation_reasons.includes('scan_incomplete')))
})

test('v4 cursor 只能单独提交，篡改或切换资料版本会明确失败', async () => {
  const store = fakeStore(Array.from({ length: 20 }, (_, index) => story(index, '命中')))
  const first = await executeSearch(store, { query: '命中' })
  const mixed = await executeSearch(store, { cursor: first.page.next_cursor, query: '别的词' })
  assert.equal(mixed.error.code, 'INVALID_REQUEST')

  const tamperedCursor = `${first.page.next_cursor.slice(0, -1)}x`
  const tampered = await executeSearch(store, { cursor: tamperedCursor })
  assert.equal(tampered.error.code, 'CURSOR_INVALID')

  store.dataVersion = 'test-v2'
  const stale = await executeSearch(store, { cursor: first.page.next_cursor })
  assert.equal(stale.error.code, 'CURSOR_VERSION_MISMATCH')
})

test('极端合法过滤下的游标仍可往返解码，单项超长被拒绝', async () => {
  // activity_names 是数组内 OR：放一个真实活动名 + 15 个 512 字填充项，
  // 既不过滤掉任何文档，又把游标解压后体积推到约 24KB——超过旧的 16KB
  // 解压上限，此前会首次搜索成功、翻页却 CURSOR_INVALID。
  const store = fakeStore(Array.from({ length: 40 }, (_, index) => story(index, `命中 ${index}`)))
  const request = {
    query: '命中',
    activity_names: ['测试活动',
      ...Array.from({ length: 15 }, (_, index) => `填充${index}` + '雪'.repeat(500))],
  }
  const first = await executeSearch(store, request)
  assert.equal(first.error, undefined, JSON.stringify(first.error))
  assert.ok(first.documents.length > 0, '真实活动名应保留全部候选')
  assert.ok(first.page.next_cursor.length > 0)
  assert.ok(first.page.next_cursor.length < 65_536)
  const second = await executeSearch(store, { cursor: first.page.next_cursor })
  assert.equal(second.error, undefined, JSON.stringify(second.error))

  const oversized = await executeSearch(store, {
    query: '命中', activity_names: ['测试活动', '雪'.repeat(513)],
  })
  assert.equal(oversized.error.code, 'INVALID_REQUEST')
  assert.match(oversized.error.message, /单项最长 512/)
})

test('搜索参数不是对象时走 INVALID_REQUEST 而非内部错误', async () => {
  const store = fakeStore([story(0, '命中')])
  for (const bad of [undefined, 'query', 42, ['query']]) {
    const result = await executeSearch(store, bad)
    assert.equal(result.error.code, 'INVALID_REQUEST', `args=${JSON.stringify(bad)}`)
  }
})
