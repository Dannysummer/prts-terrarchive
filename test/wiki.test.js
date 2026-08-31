import test from 'node:test'
import assert from 'node:assert/strict'
import { wikiSectionRanges } from '../src/wiki.js'

function record(text) {
  return { lines: text.split('\n').map((line, index) => ({ line_number: index + 1, text: line })) }
}

test('Wiki 字段解析支持规范闭合标签', () => {
  const ranges = wikiSectionRanges(record([
    '<相关活动>', '孤星：凯尔希参与调查。', '</相关活动>',
  ].join('\n')), ['相关活动'])
  assert.deepEqual(ranges, [{ name: '相关活动', start_line: 2, end_line: 2,
    marker_start_line: 1, marker_end_line: 3 }])
})

test('Wiki 字段解析支持角色×活动资料的隐式字段边界', () => {
  const ranges = wikiSectionRanges(record([
    '<所有相关的活动剧情总结>', '<相关内容>', '<相关剧情总结>', '第一段', '', '第二段',
    '<相关剧情高光>', '高光', '<相关角色总结>', '角色', '<相关trivia>', '琐事',
    '</相关内容>', '</所有相关的活动剧情总结>',
  ].join('\n')), ['相关剧情总结', '相关剧情高光', '相关角色总结', '相关trivia'])
  assert.deepEqual(ranges.map(({ name, start_line, end_line }) => ({ name, start_line, end_line })), [
    { name: '相关剧情总结', start_line: 4, end_line: 6 },
    { name: '相关剧情高光', start_line: 8, end_line: 8 },
    { name: '相关角色总结', start_line: 10, end_line: 10 },
    { name: '相关trivia', start_line: 12, end_line: 12 },
  ])
})
