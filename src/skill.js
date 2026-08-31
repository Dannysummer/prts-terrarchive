import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'prts-retrieval-skill'
export const inject = ['skills']

const skillDirectoryUrl = new URL('../skills/prts-retrieval/', import.meta.url)
const skillFileUrl = new URL('SKILL.md', skillDirectoryUrl)
const description = '检索并回答明日方舟剧情、人物、设定、台词、Wiki、时间线、档案、模组和活动问题。凡需使用 PRTS.chat 本地或云端资料进行事实核查、情节回忆或来源引用时使用。'

function skillBody(source) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(source)
  if (!match) throw new Error('prts-retrieval/SKILL.md 缺少有效 YAML frontmatter')
  return match[1].trim()
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export async function apply(ctx) {
  const content = skillBody(await readFile(skillFileUrl, 'utf8'))
  return ctx.skills.register({
    name: 'prts-retrieval',
    description,
    source: 'bundled',
    provider: 'prts-terrarchive',
    resourceBase: { kind: 'directory', path: fileURLToPath(skillDirectoryUrl) },
    content,
  })
}
