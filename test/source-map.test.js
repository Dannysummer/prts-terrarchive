import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { CorpusStore, documentUid } from '../src/store.js'
import { executeSearch } from '../src/search.js'
import { collectSourceHints, resolveCloudSources, attachLocalSourceMappings } from '../src/source-map.js'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const corpusTest = existsSync(resolve(packageDir, 'data/releases/current.json')) ? test : test.skip
const stateDir = await mkdtemp(resolve(tmpdir(), 'prts-source-map-state-'))
after(() => rm(stateDir, { recursive: true, force: true }))

corpusTest('每篇资料有稳定 document_uid，云端来源可映射到本地标题和官方行号', async () => {
  const store = new CorpusStore({ releasesDir: resolve(packageDir, 'data/releases'),
    cursorSecretPath: resolve(stateDir, 'cursor-secret.bin') })
  const search = await executeSearch(store, { query: '重生', resource_types: ['story'] })
  assert.ok(search.documents.length > 0)
  assert.ok(search.page.next_after?.title)
  assert.equal(search.page.next_cursor, undefined, '模型可见结果不应再暴露内部 cursor')
  const hit = search.documents[0]
  const found = await store.getDocumentByTitle(hit.title)
  const documentId = found.record.document.document_id
  const target = found.record.lines.find((line) => String(line.text || '').trim().length >= 8)
  assert.ok(target)
  assert.match(hit.title, / · /u, '剧情命中应使用活动、章节、篇名、行动前后的自然语言完整标题')

  // 可读标题锚点可以和原搜索条件一起提交，且不会重复首条。
  store._cursorSecret = null
  const nextPage = await executeSearch(store, { query: '重生', resource_types: ['story'],
    after: search.page.next_after })
  assert.notEqual(nextPage.documents[0].title, hit.title)

  // 资料包只有 trigram 倒排；两字查询必须走 JSONL 分片预筛，不能退回全库
  // 逐文档解析并在硬时间预算内报 TIMEOUT。
  const shortLiteral = await executeSearch(store, { query: '九岁' })
  assert.notEqual(shortLiteral.status, 'error')
  assert.ok(shortLiteral.documents.length > 0)
  assert.ok(shortLiteral.documents.some((document) => document.matches.some((match) =>
    match.excerpt.some((line) => line.text.includes('九岁')))))

  // 已经出现在旧会话中的 v2 长 cursor 继续有效，升级不会截断进行中的分页。
  const legacyRequest = { query: '重生', filters: {
    resource_types: ['story'], character_names: [], story_names: [], activity_names: [],
    entity_names: [], speakers: [], wiki_sections: [],
  }, match_mode: 'literal', context_terms: [] }
  const legacyBody = Buffer.from(JSON.stringify({ v: 2, tool: 'corpus_search',
    data_version: store.dataVersion, request: legacyRequest, offset: 12 })).toString('base64url')
  const legacySecret = await store.getOrCreateCursorSecret()
  const legacyCursor = `${legacyBody}.${createHmac('sha256', legacySecret)
    .update(legacyBody).digest('base64url')}`
  const legacyPage = await executeSearch(store, { cursor: legacyCursor })
  assert.ok(legacyPage.documents.length > 0)

  const cloud = { code: 200, data: { selected_sources: [{ evidence_id: 'evi_test',
    document_id: documentId, title: hit.title, content_preview: target.text,
    source_type: 'vector_original' }] } }
  const hints = collectSourceHints(cloud.data)
  assert.equal(hints.length, 1)
  const mappings = await resolveCloudSources(store, hints)
  assert.equal(mappings.length, 1)
  assert.equal(mappings[0].document_uid, documentUid(documentId))
  assert.equal(mappings[0].title, hit.title)
  assert.equal(mappings[0].line, target.line_number)
  assert.equal(mappings[0].line_method, 'excerpt_match')
  assert.deepEqual(mappings[0].recommended_read, {
    title: hit.title, line: target.line_number, before: 4, after: 8,
  })

  const attached = await attachLocalSourceMappings(store, cloud)
  assert.equal(attached.local_source_mappings[0].line, target.line_number)
  const visit = (value, path = '$') => {
    assert.notEqual(value, undefined, `${path} 不得为 undefined`)
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`))
    else Object.entries(value).forEach(([key, item]) => visit(item, `${path}.${key}`))
  }
  visit(attached)
})

corpusTest('主项目短文件名与同关卡多篇剧情可确定性映射', async () => {
  const store = new CorpusStore({ releasesDir: resolve(packageDir, 'data/releases'),
    cursorSecretPath: resolve(stateDir, 'cursor-secret.bin') })
  await store.ready()

  const wiki = await resolveCloudSources(store, [{
    evidence_id: 'wiki-kaltsit', source_type: 'vector_wiki',
    source_file: 'prompt_char_003_kalts.txt', title: '凯尔希在离解复合剧情高光',
    excerpt: '凯尔希',
  }])
  assert.equal(wiki.length, 1)
  assert.equal(wiki[0].mapping_method, 'source_file_basename')
  assert.match(wiki[0].title, /^恶兆湍流 \/ 角色活动 Wiki · 第 \d+ 篇$/u)

  const beforeId = 'story:obt/main/level_main_15-15_beg'
  const before = await store.getDocument(beforeId)
  const excerptLine = before.record.lines.find((line) => String(line.text || '').trim().length >= 12)
  assert.ok(excerptLine)
  const story = await resolveCloudSources(store, [{
    evidence_id: 'scene-15-17-before', source_type: 'vector_scene', story_code: '15-17',
    source_file: '15-17 “她” 行动前', title: '离解复合 - 15-17 “她” 行动前',
    start_line: excerptLine.line_number, excerpt: excerptLine.text,
  }])
  assert.equal(story.length, 1)
  assert.equal(story[0].document_id, beforeId)
  assert.equal(story[0].mapping_method, 'story_code')
  assert.equal(story[0].line, excerptLine.line_number)
})
