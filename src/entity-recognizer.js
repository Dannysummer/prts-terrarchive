/**
 * 用户问题的实体别名预识别。匹配器与浏览器端 EntityAliasAutomaton
 * 同构，数据源复用 entities 投影与 char_alias.txt。
 *
 * 这一层只把规范实体提示给 Agent，不改写工具参数、不自动加过滤器，
 * 也不维护候选排序或检索进度。
 */
import { randomUUID } from 'node:crypto'
import { buildAliasGroups } from './timeline.js'

const preparedRecognizers = new WeakMap()

function cancelledError() {
  return Object.assign(new Error('实体预识别已取消'), { code: 'CANCELLED' })
}

function waitForPreparation(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(cancelledError())
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, cancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

function normalized(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

/** Browser 同源的 Aho-Corasick 实体别名匹配器。 */
export class EntityAliasAutomaton {
  constructor(groups = []) {
    this.nodes = [{ next: new Map(), fail: 0, outputs: [] }]
    for (const group of groups) {
      const canonical = String(group.canonical || '').trim()
      for (const rawAlias of group.aliases || []) {
        const alias = normalized(rawAlias)
        if (!canonical || !alias) continue
        let node = 0
        for (const character of alias) {
          if (!this.nodes[node].next.has(character)) {
            this.nodes[node].next.set(character, this.nodes.length)
            this.nodes.push({ next: new Map(), fail: 0, outputs: [] })
          }
          node = this.nodes[node].next.get(character)
        }
        this.nodes[node].outputs.push({ canonical, alias: String(rawAlias).trim(),
          length: [...alias].length })
      }
    }
    const queue = []
    for (const child of this.nodes[0].next.values()) queue.push(child)
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const parent = queue[cursor]
      for (const [character, child] of this.nodes[parent].next) {
        queue.push(child)
        let failure = this.nodes[parent].fail
        while (failure && !this.nodes[failure].next.has(character)) failure = this.nodes[failure].fail
        this.nodes[child].fail = this.nodes[failure].next.get(character) ?? 0
        this.nodes[child].outputs.push(...this.nodes[this.nodes[child].fail].outputs)
      }
    }
  }

  match(text) {
    const characters = [...normalized(text)]
    const found = []
    let node = 0
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index]
      while (node && !this.nodes[node].next.has(character)) node = this.nodes[node].fail
      node = this.nodes[node].next.get(character) ?? 0
      for (const output of this.nodes[node].outputs) {
        const start = index - output.length + 1
        // 单字别名在普通句子中误报率过高；仅当整个输入就是该字时保留。
        if (output.length === 1 && characters.length > 1) continue
        found.push({ canonical: output.canonical, alias: output.alias, start, end: index + 1 })
      }
    }
    found.sort((left, right) => left.start - right.start
      || (right.end - right.start) - (left.end - left.start)
      || left.canonical.localeCompare(right.canonical, 'zh-CN'))
    const selected = []
    for (const match of found) {
      if (selected.some((item) => match.start >= item.start && match.end <= item.end)) continue
      selected.push(match)
    }
    return selected
  }
}

/** 模式准入阶段预热并按 store + dataVersion 共享只读 AC 自动机。 */
export async function prepareEntityRecognition(store, { signal } = {}) {
  if (signal?.aborted) throw cancelledError()
  await waitForPreparation(store.ready(), signal)
  const dataVersion = store.dataVersion
  let state = preparedRecognizers.get(store)
  if (!state || state.dataVersion !== dataVersion) {
    state = { dataVersion, automaton: null, promise: null }
    state.promise = Promise.resolve(store._aliasGroups || buildAliasGroups(store))
      .then((groups) => {
        if (store.dataVersion !== dataVersion) {
          if (preparedRecognizers.get(store) === state) preparedRecognizers.delete(store)
          return prepareEntityRecognition(store)
        }
        store._aliasGroups ||= groups
        state.automaton = new EntityAliasAutomaton(groups)
        return state.automaton
      })
      .catch((error) => {
        if (preparedRecognizers.get(store) === state) preparedRecognizers.delete(store)
        throw error
      })
    preparedRecognizers.set(store, state)
  }
  return waitForPreparation(state.automaton ? Promise.resolve(state.automaton) : state.promise, signal)
}

export function isEntityRecognitionReady(store) {
  const state = preparedRecognizers.get(store)
  return Boolean(store.loaded && state?.dataVersion === store.dataVersion && state.automaton)
}

/** 资料版本变化后自动复用或重建 AC 自动机。 */
export function createEntityRecognizer(store) {
  return {
    async detect(text, { signal } = {}) {
      const automaton = await prepareEntityRecognition(store, { signal })
      if (signal?.aborted) throw cancelledError()
      const matches = automaton.match(text)
      if (signal?.aborted) throw cancelledError()
      let cachedCatalog = store._endfieldRelationCatalog
      if (cachedCatalog?.dataVersion !== store.dataVersion) {
        let value
        try {
          const loaded = await store.getDocumentByPath?.('config/retravelers.json')
          const record = loaded?.record || loaded
          value = JSON.parse((record?.lines || []).map((line) => line.text).join('\n') || '{}')
        } catch { value = {} }
        cachedCatalog = { dataVersion: store.dataVersion, value }
        store._endfieldRelationCatalog = cachedCatalog
      }
      const catalog = cachedCatalog.value
      const normalizedText = normalized(text)
      const relationHints = []
      for (const row of catalog.retravelers || []) {
        const names = [row.endfield_name, row.terra_memory_prototype].filter(Boolean)
        if (names.some((name) => normalizedText.includes(normalized(name)))) {
          relationHints.push({ kind: 'retraveler_memory_prototype', ...row,
            query_terms: [...new Set([...names, '再旅者', '记忆原型'])] })
        }
      }
      for (const row of catalog.visual_parallels_without_lore_relation || []) {
        const names = [row.endfield_name, row.arknights_name].filter(Boolean)
        if (names.some((name) => normalizedText.includes(normalized(name)))) {
          relationHints.push({ kind: 'visual_parallel_without_lore_relation', ...row,
            query_terms: names })
        }
      }
      return { matches, entities: [...new Set(matches.map((item) => item.canonical))],
        relation_hints: relationHints }
    }
  }
}

function userText(messages) {
  return (messages || []).filter((message) => message?.source?.kind === 'user')
    .flatMap((message) => message.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text || '')).filter(Boolean).join('\n')
}

function recognitionMessage(result) {
  const aliases = new Map()
  for (const match of result.matches) {
    const values = aliases.get(match.canonical) || new Set()
    values.add(match.alias)
    aliases.set(match.canonical, values)
  }
  const lines = [...aliases].map(([canonical, values]) =>
    `- ${canonical}（问题中命中：${[...values].join('、')}）`)
  const message = {
    id: randomUUID(), role: 'user',
    source: { kind: 'plugin', plugin: 'prts-terrarchive', form: 'notice', summary: '实体别名预识别' },
    content: [{ type: 'text', text: [
      '<prts:recognized-entities>',
      '本地别名图鉴从用户问题中识别到以下规范实体。这仅用于名称消歧；是否作为检索条件由你决定。',
      ...lines,
      ...(result.relation_hints?.length ? [
        '人工审校关系提示（用于展开检索，不是官方原文）：',
        ...result.relation_hints.map((hint) => hint.kind === 'retraveler_memory_prototype'
          ? `- ${hint.endfield_name}：再旅者；泰拉记忆原型=${hint.terra_memory_prototype || '未登记'}。检索词：${hint.query_terms.join('、')}。两者不是别名。`
          : `- ${hint.endfield_name} / ${hint.arknights_name}：仅登记外观相似；现有剧情没有关系证据，不得推断为再旅者或记忆原型。`),
      ] : []),
      '</prts:recognized-entities>',
    ].join('\n') }],
  }
  Object.freeze(message.content[0])
  Object.freeze(message.content)
  Object.freeze(message.source)
  return Object.freeze(message)
}

/** 在首次模型请求前把用户问题的实体预识别结果附加为短上下文。 */
export function applyEntityRecognition(ctx, store) {
  if (typeof ctx.on !== 'function') return false
  const recognizer = createEntityRecognizer(store)
  ctx.on('agent/pre-step', async ({ messages, signal }, next) => {
    const text = userText(messages)
    // Preset admission prepares the corpus before the agent exists. A missing
    // store here must never turn the first model request into an initializer.
    if (!text || signal?.aborted || !store.loaded) return next()
    let result
    try {
      result = await recognizer.detect(text, { signal })
    } catch (error) {
      if (signal?.aborted || error?.code === 'CANCELLED') return next()
      ctx.logger?.warn?.(`prts-corpus: 实体预识别失败，已跳过: ${error?.message ?? error}`)
      return next()
    }
    const downstream = await next()
    if ((!result.entities.length && !result.relation_hints?.length) || downstream.kind !== 'enter') return downstream
    return { ...downstream, messages: [...downstream.messages, recognitionMessage(result)] }
  })
  return true
}
