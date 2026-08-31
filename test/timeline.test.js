import { test } from 'node:test'
import assert from 'node:assert/strict'

import { activityAliases, executeTimelineSearch, renderTimeline } from '../src/timeline.js'

function timelineStore() {
  const row = {
    activity_id: 'main_17', activity_name: '相变临界',
    events: [{
      event_id: 'tle_0123456789abcdef01234567',
      time: { text: '1 月 20 日', year_start: 1102, year_end: 1102 },
      event: '阿米娅等人抵达泽尔格勒。', sources: [],
    }],
  }
  return {
    dataVersion: 'test-v1',
    async ready() {},
    async getDocumentByPath(path) {
      if (path !== 'activity_timelines.jsonl') return null
      return { record: { lines: [{ text: JSON.stringify(row) }] } }
    },
  }
}

test('时间线：主线章节号可作为自然活动别名', async () => {
  assert.ok(activityAliases({ activity_id: 'main_17', activity_name: '相变临界' })
    .includes('第十七章'))
  const byQuery = await executeTimelineSearch(timelineStore(), { query: '第17章' })
  assert.equal(byQuery.status, 'ok')
  assert.equal(byQuery.normalized_filters.inferred_activity_from_query, '第17章')
  assert.equal(byQuery.normalized_filters.activity_names[0], '相变临界')
  assert.equal(byQuery.events[0].activity_name, '相变临界')

  const byFilter = await executeTimelineSearch(timelineStore(), { activity_names: ['第十七章'] })
  assert.equal(byFilter.status, 'ok')
  assert.equal(byFilter.events.length, 1)
})

test('时间线：缺少年份的月日标签在 canonical 与 model render 中补全年份', async () => {
  const result = await executeTimelineSearch(timelineStore(), { activity_names: ['相变临界'] })
  assert.equal(result.events[0].time, '1102 年 1 月 20 日')
  assert.equal(result.events[0].year_start, 1102)
  assert.match(renderTimeline({}, result)[0].text, /1102 年 1 月 20 日/u)
})

test('时间线：过滤字段传非数组时按 INVALID_REQUEST 拒绝', async () => {
  // schema 之外的第三方调用可能传字符串；此前 .map 抛 TypeError 被归为 INTERNAL_ERROR。
  const stringNames = await executeTimelineSearch(timelineStore(), { activity_names: '孤星' })
  assert.equal(stringNames.status, 'error')
  assert.equal(stringNames.error.code, 'INVALID_REQUEST')
  assert.match(stringNames.error.message, /activity_names 必须是字符串数组/)

  const numericEntities = await executeTimelineSearch(timelineStore(), { entity_names: 42 })
  assert.equal(numericEntities.status, 'error')
  assert.equal(numericEntities.error.code, 'INVALID_REQUEST')
  assert.match(numericEntities.error.message, /entity_names 必须是字符串数组/)
})

test('时间线：按标准化时间升序稳定排序，并按事件 ID 合并关联活动', async () => {
  const duplicateId = 'tle_aaaaaaaaaaaaaaaaaaaaaaaa'
  const rows = [{ activity_id: 'event:new', activity_name: '新活动', events: [
    { event_id: 'tle_bbbbbbbbbbbbbbbbbbbbbbbb', time: { text: '冬季', year_start: 1101 },
      event: '较晚事件', sources: [] },
    { event_id: duplicateId, time: { text: '1 月 2 日', year_start: 1062 },
      event: '共同事件', sources: [] },
  ] }, { activity_id: 'event:old', activity_name: '旧活动', events: [
    { event_id: 'tle_cccccccccccccccccccccccc', time: { text: '时间不详' },
      event: '未知年代事件', sources: [] },
    { event_id: 'tle_dddddddddddddddddddddddd', time: { text: '夏季', year_start: 31 },
      event: '建国事件', sources: [] },
    { event_id: 'tle_eeeeeeeeeeeeeeeeeeeeeeee',
      time: { text: '11 世纪 30 年代', year_start: 11, year_end: 11 },
      event: '世纪事件', sources: [] },
    { event_id: duplicateId, time: { text: '1 月 2 日', year_start: 1062 },
      event: '共同事件', sources: [] },
  ] }]
  const store = { dataVersion: 'test-v1', async ready() {},
    async getDocumentByPath(path) {
      if (path !== 'activity_timelines.jsonl') return null
      return { record: { lines: rows.map((row) => ({ text: JSON.stringify(row) })) } }
    } }
  const result = await executeTimelineSearch(store, { year_start: 0, max_results: 100 })
  assert.deepEqual(result.events.map((event) => event.event),
    ['建国事件', '世纪事件', '共同事件', '较晚事件'])
  assert.deepEqual(result.events[2].activity_names, ['新活动', '旧活动'])
  assert.equal(result.page.total, 4)
  assert.equal(result.stats.matched_occurrences, 5)
  assert.match(renderTimeline({}, result)[0].text, /\[新活动、旧活动\]/u)

  const century = await executeTimelineSearch(store, { year_start: 1030, year_end: 1039,
    max_results: 100 })
  assert.deepEqual(century.events.map((event) => event.event), ['世纪事件'])
})
