import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeSearch } from '../src/search.js'
import { naturalDocumentTitle } from '../src/store.js'

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

function endfieldStory(index, text) {
  return {
    document: {
      game: 'endfield', document_id: `endfield:story:dlg-test-${index}`,
      document_type: 'story', document_kind: 'story', document_category: 'endfield_original',
      resource_type: 'original_story', content_type: 'dialogue',
      collection_name: '测试任务', mission_title: '测试任务',
      story_key: `dlg-test-${index}`, display_title: `测试任务 · 对话 ${index}`,
    },
    speakers: ['管理员'],
    lines: [{ line_number: 1, line_type: 'dialogue', speaker_raw: '管理员', text }],
  }
}

test('全部公开资料类型都有可读且带类型的自然标题', () => {
  const titles = [
    naturalDocumentTitle({ document_type: 'story', document_category: 'main',
      activity_name: '孤星', story_code: 'CW-ST-4', story_name: '孤星', part_label: '行动后' }),
    naturalDocumentTitle({ document_type: 'story', document_category: 'memory',
      character_name: '凯尔希', activity_name: '未尽之愿', story_name: '未尽之愿', part_label: '正文' }),
    naturalDocumentTitle({ document_type: 'story', document_category: 'rogue',
      collection_id: 'rogue:month_chat', sequence_index: 7, part_label: '正文' }),
    naturalDocumentTitle({ document_type: 'character', display_title: '凯尔希 / 干员档案' }),
    naturalDocumentTitle({ document_type: 'knowledge', document_kind: 'wiki',
      display_title: '孤星', path: 'stories/lone_trail.txt' }),
    naturalDocumentTitle({ document_type: 'knowledge', document_kind: 'wiki',
      display_title: '恶兆湍流', path: 'char_v3/prompt_char_003.txt', sequence_index: 17 }),
    naturalDocumentTitle({ document_type: 'knowledge', document_kind: 'terra_journey',
      display_title: '移动城市的建造模式' }),
    naturalDocumentTitle({ document_type: 'entity', display_title: '乌萨斯' }),
    naturalDocumentTitle({ document_type: 'reference', display_title: 'terra_timeline' }),
  ]
  assert.deepEqual(titles, [
    '孤星 · CW-ST-4 · 行动后',
    '凯尔希 · 干员密录 · 未尽之愿 · 正文',
    '集成战略文本 · month_chat · 第 7 篇 · 正文',
    '凯尔希 / 干员档案', '孤星 / 活动 Wiki', '恶兆湍流 / 角色活动 Wiki · 第 17 篇',
    '移动城市的建造模式 / 大地巡旅', '乌萨斯 / 实体资料', '泰拉年表',
  ])
  assert.ok(titles.every((title) => title && title !== '正文'))
})

test('联合搜索默认同时返回两款游戏，并用同一参数按游戏、集合和内容类型过滤', async () => {
  const store = fakeStore([
    story(0, '共同检索词出现在泰拉'),
    endfieldStory(0, '共同检索词出现在塔卫二'),
  ])
  const both = await executeSearch(store, { query: '共同检索词', resource_types: ['original_story'] })
  assert.equal(both.error, undefined)
  assert.deepEqual(new Set(both.documents.map((item) => item.game)), new Set(['arknights', 'endfield']))
  assert.match(both.documents.find((item) => item.game === 'endfield').title, /^终末地 · /)
  assert.equal(both.documents.find((item) => item.game === 'endfield').matches[0].evidence_kind,
    'official_canonical')

  const scoped = await executeSearch(store, {
    query: '共同检索词', games: ['endfield'], resource_types: ['original_story'],
    content_types: ['dialogue'], collection_names: ['测试任务'],
  })
  assert.equal(scoped.error, undefined)
  assert.deepEqual(scoped.documents.map((item) => item.game), ['endfield'])
})

test('v2 窄资料类型仍参与 character_bundle 与 reviewed_wiki 合集过滤', async () => {
  const records = [
    { document: { ...endfieldStory(0, '角色档案正文').document,
      document_id: 'endfield:character:test:profiles', document_type: 'character',
      document_category: '角色档案', document_kind: 'profiles',
      resource_type: 'character_profile', character_name: '提弗洛斯' },
      speakers: [], lines: [{ line_number: 1, speaker_raw: '', text: '角色档案正文' }] },
    { document: { ...endfieldStory(1, '审校资料正文').document,
      document_id: 'endfield:knowledge:test', document_type: 'knowledge',
      document_category: '角色 Wiki', document_kind: 'wiki',
      resource_type: 'knowledge' }, speakers: [],
      lines: [{ line_number: 1, speaker_raw: '', text: '审校资料正文' }] },
  ]
  const store = fakeStore(records)
  const bundle = await executeSearch(store, { query: '角色档案正文',
    resource_types: ['character_bundle'] })
  assert.equal(bundle.documents.length, 1)
  const reviewed = await executeSearch(store, { query: '审校资料正文',
    resource_types: ['reviewed_wiki'] })
  assert.equal(reviewed.documents.length, 1)
})

test('查询与正式档案标题完全相同时官方档案优先于正文提及', async () => {
  const ordinary = endfieldStory(0, '很多人都曾经提到世代摇篮')
  const archive = { document: {
    game: 'endfield', document_id: 'endfield:archive:generation-cradle',
    document_type: 'knowledge', document_kind: 'official_archive',
    document_category: '中枢档案', resource_type: 'archive', content_type: 'archive',
    display_title: '世代摇篮', collection_name: '中枢档案',
  }, speakers: [], lines: [{ line_number: 1, speaker_raw: '', text: '世代摇篮是正式档案。' }] }
  const result = await executeSearch(fakeStore([ordinary, archive]), { query: '世代摇篮' })
  assert.equal(result.documents[0].resource_type, 'archive')
  assert.equal(result.documents[0].title, '终末地 · 世代摇篮')
})

test('联合搜索按游戏交错候选，连续页面不会被一个游戏的高频资料占满', async () => {
  const records = [
    ...Array.from({ length: 20 }, (_, index) => story(index, `共同高频词 ${index}`)),
    ...Array.from({ length: 20 }, (_, index) => endfieldStory(index, `共同高频词 ${index}`)),
  ]
  const store = fakeStore(records)
  const first = await executeSearch(store, { query: '共同高频词' })
  assert.deepEqual(new Set(first.documents.map((item) => item.game)), new Set(['arknights', 'endfield']))
  assert.ok(first.page.next_after)

  const second = await executeSearch(store, {
    query: '共同高频词', after: first.page.next_after,
  })
  assert.deepEqual(new Set(second.documents.map((item) => item.game)), new Set(['arknights', 'endfield']))
  assert.equal(new Set([...first.documents, ...second.documents]
    .map((item) => `${item.game}\0${item.title}`)).size,
    first.documents.length + second.documents.length)
})

test('标题锚点按同一 Unicode 规则比较，全角标点不会让下一页失效', async () => {
  const records = Array.from({ length: 20 }, (_, index) => story(index, `标点翻页词 ${index}`))
  records[11].document.story_name = '走吧，走吧'
  records[11].document.display_title = '走吧，走吧'
  const store = fakeStore(records)
  const first = await executeSearch(store, { query: '标点翻页词' })
  assert.match(first.page.next_after.title, /，/u)
  const second = await executeSearch(store, {
    query: '标点翻页词', after: first.page.next_after,
  })
  assert.equal(second.error, undefined)
  assert.equal(second.documents.length, 8)
})

async function exhaust(store, request) {
  const pages = []
  let value = await executeSearch(store, request)
  for (let calls = 0; ; calls += 1) {
    assert.ok(calls < 100, 'title continuation chain did not exhaust')
    assert.equal(value.error, undefined)
    pages.push(value)
    if (value.page.exhausted) return pages
    assert.ok(value.page.next_after?.title)
    value = await executeSearch(store, { ...request, after: value.page.next_after })
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
  assert.deepEqual(first.page.next_after,
    { resource_type: 'story', title: '测试活动 · T-255 · 测试篇章 255', position: 255 })
  assert.equal(first.page.next_cursor, undefined)

  const replay = await executeSearch(store, { query: '针尖' })
  assert.deepEqual(replay, first)

  const final = await executeSearch(store, { query: '针尖', after: first.page.next_after })
  assert.equal(final.page.exhausted, true)
  assert.equal(final.page.has_more, false)
  assert.equal(final.page.next_after, null)
  assert.equal(final.page.total_relation, 'unknown')
  assert.equal(final.page.total_documents, undefined)
  assert.deepEqual(final.documents.map((item) => item.title),
    ['测试活动 · T-299 · 测试篇章 299'])
})

test('v4 多页结果按文档稳定归并，全链不重不漏', async () => {
  const store = fakeStore(Array.from({ length: 30 }, (_, index) => story(index, `命中 ${index}`)))
  const pages = await exhaust(store, { query: '命中' })
  assert.deepEqual(pages.map((page) => page.documents.length), [12, 12, 6])
  const titles = pages.flatMap((page) => page.documents.map((document) => document.title))
  assert.equal(new Set(titles).size, 30)
  assert.equal(pages.at(-1).page.total_relation, 'unknown')
  assert.ok(pages.slice(0, -1).every((page) => page.page.exhausted === false
    && page.truncation_reasons.includes('scan_incomplete')))
})

test('v4 使用资料类型与自然标题续页，且可与所有搜索条件一起提交', async () => {
  const store = fakeStore(Array.from({ length: 20 }, (_, index) => story(index, '命中')))
  const first = await executeSearch(store, { query: '命中' })
  assert.deepEqual(first.page.next_after,
    { resource_type: 'story', title: '测试活动 · T-11 · 测试篇章 11', position: 11 })
  const second = await executeSearch(store, {
    query: '命中', resource_types: ['story'], activity_names: ['测试活动'],
    after: first.page.next_after,
  })
  assert.equal(second.error, undefined)
  assert.deepEqual(second.documents.map((item) => item.title),
    Array.from({ length: 8 }, (_, index) => `测试活动 · T-${index + 12} · 测试篇章 ${index + 12}`))

  const invalid = await executeSearch(store, { query: '命中', after: { title: '缺少类型' } })
  assert.equal(invalid.error.code, 'INVALID_REQUEST')
  const missing = await executeSearch(store, { query: '命中',
    after: { resource_type: 'story', title: '不存在的资料', position: 999 } })
  assert.equal(missing.error.code, 'PAGE_ANCHOR_NOT_FOUND')
})

test('极端合法过滤可随标题锚点重复提交，单项超长被拒绝', async () => {
  const store = fakeStore(Array.from({ length: 40 }, (_, index) => story(index, `命中 ${index}`)))
  const request = {
    query: '命中',
    activity_names: ['测试活动',
      ...Array.from({ length: 15 }, (_, index) => `填充${index}` + '雪'.repeat(500))],
  }
  const first = await executeSearch(store, request)
  assert.equal(first.error, undefined, JSON.stringify(first.error))
  assert.ok(first.documents.length > 0, '真实活动名应保留全部候选')
  assert.ok(first.page.next_after?.title)
  const second = await executeSearch(store, { ...request, after: first.page.next_after })
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
