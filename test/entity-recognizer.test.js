import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EntityAliasAutomaton, applyEntityRecognition, isEntityRecognitionReady,
  prepareEntityRecognition } from '../src/entity-recognizer.js'

const GROUPS = [
  { canonical: '凯尔希', aliases: ['凯尔希', "Kal'tsit"] },
  { canonical: '左乐', aliases: ['左乐', '乐乐'] },
  { canonical: '烛骑士', aliases: ['烛骑士', '小烛台'] },
  { canonical: '陈', aliases: ['陈'] },
]

test('AC 自动机：别名规范化、长词优先与单字防误报', () => {
  const automaton = new EntityAliasAutomaton(GROUPS)
  assert.deepEqual(automaton.match("请梳理 KAL'TSIT 和乐乐的经历")
    .map(({ canonical, alias }) => ({ canonical, alias })), [
    { canonical: '凯尔希', alias: "Kal'tsit" },
    { canonical: '左乐', alias: '乐乐' },
  ])
  assert.deepEqual(automaton.match('这段剧情中陈述了什么'), [])
  assert.equal(automaton.match('陈')[0].canonical, '陈')
  assert.equal(automaton.match('小烛台的师傅是谁')[0].canonical, '烛骑士')
})

test('模式准入预热：同一 dataVersion 只构建一次并可供 pre-step 复用', async () => {
  let iterations = 0
  const store = {
    loaded: true,
    dataVersion: 'v-prepared',
    async ready() {},
    async *iterateDocuments() {
      iterations += 1
      yield { document: { document_type: 'entity', display_title: '左乐' },
        entity: { canonical_name: '左乐', aliases: ['乐乐'] } }
    },
    async getDocumentByPath() { return null },
  }
  assert.equal(isEntityRecognitionReady(store), false)
  const first = await prepareEntityRecognition(store)
  const second = await prepareEntityRecognition(store)
  assert.equal(first, second)
  assert.equal(iterations, 1)
  assert.equal(store._aliasGroups.length, 1, '时间线和搜索应复用准入阶段构建的别名组')
  assert.equal(isEntityRecognitionReady(store), true)
})

test('agent/pre-step：只附加实体消歧提示，不改写用户问题', async () => {
  let listener = null
  const ctx = {
    on(name, callback) {
      assert.equal(name, 'agent/pre-step')
      listener = callback
    },
    logger: { warn() {} },
  }
  const store = {
    loaded: true,
    dataVersion: 'v1',
    async ready() {},
    async *iterateDocuments() {
      yield { document: { document_type: 'entity', display_title: '左乐' },
        entity: { canonical_name: '左乐', aliases: ['乐乐'] } }
    },
    async getDocumentByPath() { return null },
  }
  assert.equal(applyEntityRecognition(ctx, store), true)
  const original = { id: 'u1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '乐乐的师傅是谁？' }] }
  const decision = await listener({ messages: [original], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [original] }))
  assert.equal(decision.messages[0], original)
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[1].content[0].text, /左乐（问题中命中：乐乐）/)
  assert.match(decision.messages[1].content[0].text, /是否作为检索条件由你决定/)
})

test('agent/pre-step：资料未加载时直接放行，不把首次请求变成初始化步骤', async () => {
  let listener = null
  let iterated = false
  const ctx = {
    on(_name, callback) { listener = callback },
    logger: { warn() {} },
  }
  const store = {
    loaded: false,
    async ready() { throw new Error('pre-step 不应调用 ready') },
    async *iterateDocuments() { iterated = true },
  }
  applyEntityRecognition(ctx, store)
  const original = { id: 'u1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '凯尔希是谁？' }] }
  const downstream = { kind: 'enter', messages: [original] }

  assert.equal(await listener({ messages: [original], signal: new AbortController().signal },
    async () => downstream), downstream)
  assert.equal(iterated, false)
})

test('agent/pre-step：等待实体预热时响应取消并立即放行', async () => {
  let listener = null
  let releaseBuild
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const ctx = {
    on(_name, callback) { listener = callback },
    logger: { warn() {} },
  }
  const store = {
    loaded: true,
    dataVersion: 'v-cancel',
    async ready() {},
    async *iterateDocuments() {
      markStarted()
      await new Promise((resolve) => { releaseBuild = resolve })
      yield { document: { document_type: 'entity', display_title: '凯尔希' },
        entity: { canonical_name: '凯尔希', aliases: ['老猞猁'] } }
    },
    async getDocumentByPath() { return null },
  }
  applyEntityRecognition(ctx, store)
  const original = { id: 'u1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '老猞猁是谁？' }] }
  const downstream = { kind: 'enter', messages: [original] }
  const controller = new AbortController()
  const pending = listener({ messages: [original], signal: controller.signal }, async () => downstream)
  await started
  controller.abort()
  assert.equal(await pending, downstream)
  releaseBuild()
})
