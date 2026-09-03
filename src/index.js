/**
 * prts-terrarchive：PRTS.chat 明日方舟检索五工具的 deepseek-harness 插件。
 *
 * 零 npm 依赖：不经 defineTool（避免与宿主 dsh-tools 版本漂移），直接向
 * ctx.tools 注册原始 ToolDefinition。模型使用扁平参数（严格 title+line 的
 * corpus_read、anyOf 拆为 execute 内跨字段校验），执行层再落实版本化契约。
 *
 * 工具集（与浏览器 agent/browser 五工具对齐）：
 *   corpus_search   grep 风格本地语料搜索/目录（literal/受限 regex）
 *   corpus_read     按完整篇章标题 + 官方行号直读原文（不自动夹带伴随资料）
 *   timeline_search 活动时间线检索（别名裂变 / 年份交集 / 出处标记反查）
 *   cloud_search    云端组合语义检索（需 cloud.baseUrl 配置）
 *   cloud_inspect   云端检索状态复查（request_id 由运行时注入）
 *
 * 加载方式（任选其一）：
 *   1) bundle：dsh plugin --profile <name> add /path/to/agent-dsh
 *   2) overlay：dsh web --patch ./agent-dsh/cordis.patch.yml（需可被 Node 解析）
 *
 * 配置（cordis.patch.yml 行内 config）：
 *   releasesDir      资料包 releases 目录（默认 $DSH_HOME/prts-corpus/releases）
 *   cacheShards      分片 LRU 缓存大小（默认 8）
 *   download         { releaseId, order, siteBaseUrl } 设置页显式下载的版本与来源
 *   cloud            { baseUrl, game, userId, token, timeoutMs }；game 默认 all（双游戏）
 */

import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { CorpusStore, naturalDocumentTitle } from './store.js'
import { executeRead, readContractFromCursor,
  projectReadPublic, renderRead } from './read.js'
import { executeSearch, renderSearch } from './search.js'
import { executeTimelineSearch, renderTimeline } from './timeline.js'
import { AnonymousSessionProvider, CloudRetrievalClient, StaticTokenProvider,
  createAgentCloudClientRegistry,
  cloudErrorResponse, readOrCreateClientId } from './cloud.js'
import { createSharedState } from './state.js'
import { applyUi } from './ui.js'
import { attachLocalSourceMappings } from './source-map.js'
import { projectCloudInspect, projectCloudSearch } from './cloud-projection.js'
import { combinePartialReadResponses, coveredRead, createEvidenceStateRegistry,
  planReadCoverage, rememberCloudMappings, rememberRead,
  rememberSearchCandidates, replayCoveredRead, resolveReadWindow,
  visibleToolResults } from './evidence-state.js'
import { applyEntityRecognition, isEntityRecognitionReady,
  prepareEntityRecognition } from './entity-recognizer.js'
import { WIKI_SECTION_VALUES } from './wiki.js'

/** Cordis 插件名（Loader 诊断用，与 npm 包名 prts-terrarchive 相互独立）。 */
export const name = 'prts-corpus'

/** 同一 Host 进程中，host 常驻实例与会话 preset 共用一份大型索引。 */
const storesByDirectory = new Map()

const READ_DESCRIPTION = [
  '按完整自然语言标题读取 PRTS.chat 本地资料；title + line 扩大原文上下文，title + section 读取 Wiki 字段，title + mode=document 分页阅读全文。',
  '继续阅读时使用上次结果给出的完整 title 和下一行 line，不要生成或复述内部 cursor。旧会话里的 cursor 仅用于兼容，可以同时带正确的 title 和新的 max_lines/max_chars。剧情标题使用“活动 · 章节代码 · 篇名 · 行动前后”，不使用内部 ID、ref 或路径。',
  '引用原文使用“《篇章名》第 N 行”；不要使用内部代号、路径或自造篇章名。',
].join(' ')

const SEARCH_DESCRIPTION = [
  '像 grep 一样搜索 PRTS.chat 本地语料；命中立即返回原行及上下各一行，并按文档归并。',
  'query 使用短实体名、篇章展示名或原句片段；也可省略 query，仅按过滤条件列出资料入口。',
  '角色个人页用 character_wiki；活动/密录整理页用 story_wiki；角色在单个活动中的辅助整理用 character_activity_wiki。wiki_sections 可精确限定相关活动、相关角色、剧情总结、角色剧情概括等标签字段。',
  'literal 是默认连续字面匹配；只有特殊模式才使用受限 regex。下一页保留原搜索条件，并把返回的 next_after 原样放入 after；锚点由资料类型与自然标题组成，不再暴露内部 cursor。',
].join(' ')

const TIMELINE_DESCRIPTION = [
  '按活动名、年份及自动展开的实体别名检索活动时间线（PRTS Wiki《泰拉年表》本地投影）。',
  '人物放 entity_names 以自动裂变别名；结果只给时间、事件正文和“年表出处”标记，把标记原样传回 source_marker 可反查完整来源。',
].join(' ')

const CLOUD_SEARCH_DESCRIPTION = [
  '用一次自然语言请求同时查询 PRTS.chat 云端的明日方舟与终末地图谱、档案、原文、自建 Wiki 和时间线组合索引；只有用户明确限定游戏时才使用 games 收窄。',
  '返回末尾的「## 可读取原文」列出已映射到本地篇章的完整自然语言标题与行号；直接按 title + line 调用 corpus_read。',
].join(' ')

const CLOUD_INSPECT_DESCRIPTION = [
  '按 section 和过滤条件读取最近一次云端检索状态（request_id 由运行时自动注入）。',
  '用于定点读取回答材料、候选状态或诊断记录，并支持按 next_cursor 分页。',
].join(' ')

/** ---- 模型可见参数（DSH ctx.tools 的 JSON Schema 子集：无 anyOf/$defs/pattern/数值边界） ---- */

const RESOURCE_TYPES = ['story', 'character_profile', 'character_module', 'character_voice',
  'character_skin', 'operator_record', 'character_bundle', 'character_wiki', 'story_wiki',
  'character_activity_wiki', 'reviewed_wiki',
  'terra_journey', 'entity_profile', 'reference',
  'original_story', 'archive', 'knowledge', 'wiki', 'character_story', 'timeline']

const CONTENT_TYPES = ['dialogue', 'cutscene', 'radio', 'remote_comm', 'black_screen',
  'environment_talk', 'sns_topic', 'sns_chat', 'narration', 'archive', 'knowledge']

const stringList = (description) => ({ type: 'array', items: { type: 'string' }, description })

const SEARCH_PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    query: { type: 'string', description: '短搜索词：实体名、篇章展示名、活动名或原句片段；不要直接提交整句研究问题' },
    resource_types: { type: 'array', items: { type: 'string', enum: RESOURCE_TYPES },
      description: '资料类型；character_bundle 可一次查看角色档案、模组、语音和密录' },
    games: { type: 'array', items: { type: 'string', enum: ['arknights', 'endfield'] },
      description: '可选游戏过滤；省略时在同一次调用中同时检索明日方舟与终末地' },
    content_types: { type: 'array', items: { type: 'string', enum: CONTENT_TYPES },
      description: '统一内容形式，例如 dialogue、cutscene、radio、sns_chat；两款游戏使用相同参数' },
    collection_names: stringList('上级资料集合展示名；明日方舟活动与终末地任务都使用此字段'),
    character_names: stringList('角色展示名，如“凯尔希”'),
    story_names: stringList('剧情篇章的展示名，如“晶簇之内”；不要填写内部 story_id 或路径'),
    activity_names: stringList('活动展示名'),
    wiki_sections: { type: 'array', items: { type: 'string', enum: WIKI_SECTION_VALUES },
      description: 'Wiki 标签字段，可与资料类型、角色、活动和 query 组合；角色页常用相关活动/相关角色/剧情高光，活动页常用剧情总结/关键人物/角色剧情概括' },
    entity_names: stringList('只返回出现指定实体的行'),
    speakers: stringList('结构化说话人展示名，只匹配亲口台词；适合查某人亲口说过什么'),
    match_mode: { type: 'string', enum: ['literal', 'regex'],
      description: '默认 literal 连续字面匹配；除非必须，不使用受限 regex' },
    context_terms: { type: 'array', items: { type: 'string' },
      description: '要求命中附近同时出现的语境词（最多 8 个）' },
    after: { type: 'object', additionalProperties: false,
      description: '下一页锚点；与原 query 和过滤条件一起提交上次返回的 next_after',
      required: ['resource_type', 'title', 'position'], properties: {
        resource_type: { type: 'string', enum: RESOURCE_TYPES },
        title: { type: 'string', description: '上一页扫描到的资料自然标题' },
        position: { type: 'integer', description: '该标题在当前资料版本中的顺序位置' },
      } },
  },
}

const SEARCH_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['result_kind', 'documents', 'page', 'truncated', 'truncation_reasons'],
  properties: {
    result_kind: { type: 'string', enum: ['text_matches', 'structured_matches',
      'complete_sections', 'documents'] },
    documents: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['game', 'title', 'resource_type', 'content_type', 'matches', 'matches_truncated'],
      properties: {
        game: { type: 'string', enum: ['arknights', 'endfield'] },
        title: { type: 'string' }, resource_type: { type: 'string' },
        content_type: { type: 'string' }, collection_name: { type: 'string' },
        activity_name: { type: 'string' }, character_name: { type: 'string' },
        matches_truncated: { type: 'boolean' },
        matches: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['match_kind', 'evidence_kind', 'excerpt', 'citation'],
          properties: {
            line_start: { type: 'integer' }, line_end: { type: 'integer' },
            match_kind: { type: 'string' }, evidence_kind: { type: 'string' },
            citation: { type: 'string' },
            excerpt: { type: 'array', items: { type: 'object', additionalProperties: false,
              required: ['line', 'role', 'line_type', 'speaker', 'text', 'truncated'],
              properties: { line: { type: 'integer' },
                role: { type: 'string', enum: ['match', 'context', 'constraint'] },
                line_type: { type: 'string' }, speaker: { type: 'string' },
                text: { type: 'string' }, truncated: { type: 'boolean' } } } },
          } } },
        section_content: { type: 'object', additionalProperties: false,
          required: ['section', 'completeness', 'blocks', 'citation'],
          properties: { section: { type: 'string' },
            completeness: { type: 'string', enum: ['complete', 'partial'] },
            blocks: { type: 'array', items: { type: 'object', additionalProperties: false,
              required: ['type', 'text'], properties: { type: { type: 'string', enum: ['text'] },
                text: { type: 'string' } } } }, citation: { type: 'string' } } },
        entity_summary: { type: 'object', additionalProperties: false,
          required: ['canonical_name', 'truncated', 'citation'],
          properties: { canonical_name: { type: 'string' }, description: { type: 'string' },
            history_summary: { type: 'string' }, truncated: { type: 'boolean' },
            citation: { type: 'string' } } },
      } } },
    page: { type: 'object', additionalProperties: false,
      required: ['returned_documents', 'total_relation', 'has_more', 'exhausted', 'next_after'],
      properties: { returned_documents: { type: 'integer' }, total_documents: { type: 'integer' },
        total_relation: { type: 'string', enum: ['eq', 'unknown'] },
        has_more: { type: 'boolean' },
        exhausted: { type: 'boolean' },
        next_after: { oneOf: [{ type: 'object', additionalProperties: false,
          required: ['resource_type', 'title', 'position'], properties: {
            resource_type: { type: 'string' }, title: { type: 'string' },
            position: { type: 'integer' },
          } }, { type: 'null' }] } } },
    truncated: { type: 'boolean' },
    truncation_reasons: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['code', 'game', 'message'], properties: {
        code: { type: 'string' }, game: { type: 'string', enum: ['arknights', 'endfield'] },
        message: { type: 'string' },
      } } },
  },
}

const READ_PARAMETERS = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '资料完整自然语言展示标题' },
    line: { type: 'integer', description: '要读取的官方行号；around 模式必填' },
    mode: { type: 'string', enum: ['document'], description: '只在阅读全文时传 document；title + line 和 title + section 会自动选择读取方式' },
    section: { type: 'string', enum: WIKI_SECTION_VALUES, description: '读取 Wiki 标签字段' },
    before: { type: 'integer', description: 'around 前文行数，默认 3，上限 100' },
    after: { type: 'integer', description: 'around 后文行数，默认 3，上限 100' },
    cursor: { type: 'string', description: '仅兼容旧会话中的不透明游标；新调用应使用上次结果给出的 title + line' },
    max_lines: { type: 'integer', description: '最多返回行数，默认 100，上限 500' },
    max_chars: { type: 'integer', description: '最多返回字符数，默认 12000，上限 100000' },
  },
  additionalProperties: false,
}

const READ_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['primary', 'page'],
  properties: {
    primary: { type: 'object', additionalProperties: false,
      required: ['game', 'title', 'kind', 'selection', 'lines', 'citation'],
      properties: { game: { type: 'string', enum: ['arknights', 'endfield'] },
        title: { type: 'string' }, kind: { type: 'string' },
        selection: { type: 'object', additionalProperties: false,
          required: ['mode', 'line_start', 'line_end', 'truncated'],
          properties: { mode: { type: 'string' }, line_start: { type: 'integer' },
            line_end: { type: 'integer' }, section: { type: 'string' },
            truncated: { type: 'boolean' } } },
        lines: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['line', 'line_type', 'speaker', 'text'],
          properties: { line: { type: 'integer' }, source_line_id: { type: 'string' },
            line_type: { type: 'string' }, speaker: { type: 'string' }, speaker_id: { type: 'string' },
            text: { type: 'string' }, audio: { type: 'string' }, hint: { type: 'string' } } } },
        text: { type: 'string' }, citation: { type: 'string' } } },
    page: { type: 'object', required: ['returned_lines', 'has_more', 'continuation'],
      properties: { returned_lines: { type: 'integer' }, has_more: { type: 'boolean' },
        continuation: { oneOf: [{ type: 'object', additionalProperties: false,
          required: ['title', 'line', 'before', 'after'], properties: {
            title: { type: 'string' }, line: { type: 'integer' }, before: { type: 'integer' },
            after: { type: 'integer' },
          } }, { type: 'null' }] } } },
  },
}

const TIMELINE_PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    query: { type: 'string', description: '可选的事件正文短语（≤200 字符）。人物应优先放入 entity_names 以自动展开别名' },
    activity_names: { type: 'array', items: { type: 'string' }, description: '活动展示名，例如“孤星”（≤20 项）' },
    entity_names: { type: 'array', items: { type: 'string' }, description: '角色或实体展示名；工具会用别名图鉴自动裂变后检索（≤20 项）' },
    year_start: { type: 'integer', description: '起始年份（含）；可单独使用' },
    year_end: { type: 'integer', description: '结束年份（含）；可单独使用' },
    source_marker: { type: 'string', description: '反查模式：原样复制时间线结果方括号内的年表出处标记（年表出处:tle_ 开头）' },
    max_results: { type: 'integer', description: '最多返回事件数，默认 20，上限 100' },
  },
}

const CHANNEL_VALUES = ['graph', 'csv', 'vector', 'fallback_raw', 'wiki', 'timeline']

const CLOUD_SEARCH_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['query'],
  properties: {
    query: { type: 'string', description: '改写为语义完整、适合向量检索的自然语言' },
    games: { type: 'array', items: { type: 'string', enum: ['arknights', 'endfield'] },
      description: '可选游戏范围；省略时同一次调用同时检索明日方舟与终末地' },
    depth: { type: 'string', enum: ['fast', 'standard', 'deep'],
      description: '检索深度：fast 轻量意图路由；standard 保证加入 vector；deep 使用 graph、csv、vector。首轮通常省略' },
    evidence_policy: { type: 'string', enum: ['mixed', 'original_only'],
      description: 'mixed 保留多种资料；original_only 只让原文类候选进入最终来源。不等于 channels=["vector"]' },
    options: {
      type: 'object', additionalProperties: false,
      description: '高级批量检索控制，用于一次召回一组候选；新意图首轮通常省略',
      properties: {
        channels: { type: 'array', items: { type: 'string', enum: CHANNEL_VALUES },
          description: '批量搜索时只运行列出的渠道：graph=关系/事件；csv=档案、活动总结、密录；vector=不记得原句时按语义模糊召回原文场景；fallback_raw=广泛兜底原文；wiki=自建 Wiki；timeline=活动时间线。显式 channels 会关闭未列出的渠道' },
        exclude_channels: { type: 'array', items: { type: 'string', enum: CHANNEL_VALUES },
          description: '从默认计划排除指定渠道；可选值与 channels 相同，且不能与 channels 重叠' },
        query_variants: { type: 'array', items: { type: 'string' },
          description: '一轮批量覆盖最多 8 个保留原意的自然语言查询；每项都必须完整、通顺、可独立理解，不能是关键词堆' },
        entity_overrides: { type: 'array',
          description: '仅在实体链接错误且规范实体已确认时覆盖；每项至少填写 text、official_name、label。通常优先 filters.entity_names' },
        filters: {
          type: 'object', additionalProperties: false,
          description: '收窄批量候选：同一字段内 OR，不同字段间 AND。仅使用首轮已确认的人类可读实体、活动、篇章代码或说话人',
          properties: {
            entity_names: stringList('规范实体展示名，例如“凯尔希”“玻利瓦尔”'),
            entity_labels: stringList('实体类型，例如“角色”“国家”“组织”“地点”“活动”'),
            activities: stringList('活动展示名，例如“孤星”'),
            story_codes: stringList('用户可见的关卡或篇目代码，例如“CW-ST-4”；不要填写内部剧情 ID'),
            source_types: { type: 'array', items: { type: 'string' },
              description: '限定资料类型：原文 vector_original/vector_scene；实体与图谱 entity_profile/entity_attachment/graph_entity/graph_relation/graph_event/entity_attribute；结构化档案 csv_archive/csv_activity/csv_record；知识资料 vector_wiki/travel_notes/timeline；classic_hit 为经典检索命中' },
            speakers: stringList('结构化说话人展示名，只匹配亲口台词候选'),
          },
        },
        limits: {
          type: 'object', additionalProperties: false,
          description: '批量规模控制',
          properties: {
            per_channel: { type: 'object', description: '各渠道最多保留候选数，键使用 graph/csv/vector/fallback_raw/wiki/timeline' },
            candidate_limit: { type: 'integer', description: '批量合并去重前后的全局候选上限' },
            final_limit: { type: 'integer', description: 'Cleaner 最终交给回答上下文的来源上限' },
            context_chars: { type: 'integer', description: '最终 answer_context 字符上限；调试召回时不要无故放大' },
          },
        },
        thresholds: {
          type: 'object', additionalProperties: false,
          description: '分数阈值（只用于裁剪候选，不代表事实可信度）',
          properties: {
            per_channel: { type: 'object', description: '各渠道最低分，键使用实际渠道名；不同渠道分数不可横向比较' },
            minimum_score: { type: 'number', description: '全局最低检索分数' },
          },
        },
        validation: { type: 'string', enum: ['default', 'none', 'record_only', 'llm'],
          description: '云端候选审核：default=产品默认；none=跳过 LLM 审核；record_only=记录审核但不淘汰；llm=显式启用审核' },
        search_intent: { type: 'string', enum: ['quote_search', 'scene_search', 'single_sentence_search'],
          description: 'single_sentence_search=只记得一句官方剧情原文的大意、字词可能记错时定位单句；quote_search=跨资料批量找亲口台词、名词或近似引文，通常配 speakers；scene_search=按大概情节、事件过程或人物互动描述模糊召回原文场景' },
        preprocess: { type: 'boolean', description: '查询预处理开关，默认 true；只有预处理明显误改查询时才设 false' },
        link_entities: { type: 'boolean', description: '自动规范化实体，默认开启；关闭后 graph、timeline 与实体资料召回可能明显减少' },
        attach_entity_profiles: { type: 'boolean', description: '是否把命中实体的资料卡并入候选；只找原文且资料卡造成噪声时可关闭' },
        run_cleaner: { type: 'boolean', description: '是否执行云端候选清洗、去重和最终上下文组装；正常回答保持开启，只有诊断原始召回时才关闭' },
        append_fallback_original: { type: 'boolean', description: '是否追加兜底原文检索；主渠道不含 vector 且仍需原文线索时使用' },
        append_wiki: { type: 'boolean', description: '是否追加自建 Wiki 语义检索' },
        append_timeline: { type: 'boolean', description: '是否追加活动时间线；查询需能链接到明确活动实体' },
      },
    },
  },
}

// The answering model selects only between the two product routes. Advanced
// filters and candidate budgets remain a server/diagnostic contract, but are
// intentionally not model-facing because applying them before the shared
// Cleaner changes the main site's proven retrieval semantics.
CLOUD_SEARCH_PARAMETERS.properties.depth.description =
  '兼容字段；不会改变云端主站的检索路由。回答深度由 Agent 自己的运行模式控制，通常省略'
CLOUD_SEARCH_PARAMETERS.properties.evidence_policy.description =
  'mixed=完整复用 PRTS.chat 主站检索、审核与 Cleaner；original_only=只运行官方剧情原文向量路线'
CLOUD_SEARCH_PARAMETERS.properties.options = {
  type: 'object', additionalProperties: false,
  description: '通常省略。只有用户记得一句原文大意且措辞可能不准时，选择官方剧情单句向量路线',
  properties: {
    search_intent: {
      type: 'string', enum: ['single_sentence_search'],
      description: '只检索官方剧情单句向量表，并执行原有 LLM 验证；其他问题使用默认主站路线',
    },
  },
}

const CLOUD_INSPECT_PARAMETERS = {
  type: 'object', additionalProperties: false,
  description: '查看最近一次云端检索的指定区段；request_id 由运行时自动注入',
  properties: {
    games: { type: 'array', items: { type: 'string', enum: ['arknights', 'endfield'] },
      description: '只查看指定游戏的候选、来源或事件；省略时查看联合状态' },
    section: { type: 'string', enum: ['summary', 'candidates', 'selected_sources', 'events', 'trace_steps', 'answer_context'],
      description: '默认 summary' },
    cursor: { type: 'integer', description: '分页游标：原样复制上次返回的 next_cursor' },
    limit: { type: 'integer', description: '本页条数' },
    channels: stringList('按渠道过滤（candidates/events）'),
    query_variants: stringList('按查询变体过滤'),
    retrievers: stringList('按检索器过滤'),
    source_types: { type: 'array', items: { type: 'string' }, description: '按来源类型过滤' },
    statuses: { type: 'array', items: { type: 'string' }, description: '按候选状态过滤' },
    stages: stringList('按处理阶段过滤'),
    candidate_ids: stringList('按候选 ID 精确过滤'),
    evidence_ids: stringList('按证据 ID 精确过滤'),
    event_sequence_from: { type: 'integer', description: '事件序号下界（含）' },
    event_sequence_to: { type: 'integer', description: '事件序号上界（含）' },
    event_time_from: { type: 'string', description: '事件时间下界' },
    event_time_to: { type: 'string', description: '事件时间上界' },
    content_mode: { type: 'string', enum: ['none', 'preview', 'full'],
      description: 'none 只取结构字段；preview 返回受限正文；full 返回该页完整正文' },
    content_max_chars: { type: 'integer', description: '正文字符上限' },
  },
}

/** ---- 模型扁平参数 → 版本化 wire contract ---- */

/**
 * corpus_read：title/line 扁平参数 → locator/selection 契约。
 * 严格 title+line 表面（与浏览器 MODEL_TOOL_SCHEMAS.corpus_read 对齐）。
 */
async function modelReadToContract(args = {}, store) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw Object.assign(new Error('读取参数必须是对象'), { code: 'INVALID_REQUEST' })
  }
  if (args.cursor !== undefined) {
    const allowed = new Set(['cursor', 'title', 'mode', 'max_lines', 'max_chars'])
    if (Object.keys(args).some((key) => !allowed.has(key))) {
      throw Object.assign(new Error('旧 cursor 只能附带 title、mode=document、max_lines/max_chars'),
        { code: 'INVALID_REQUEST' })
    }
    const restored = readContractFromCursor(args.cursor)
    if (args.mode !== undefined && args.mode !== 'document') {
      throw Object.assign(new Error('旧 cursor 只兼容 mode=document'), { code: 'INVALID_REQUEST' })
    }
    if (args.title !== undefined) {
      const record = await store.getDocumentByTitle(String(args.title).trim())
      if (!record || record.record.document.document_id !== restored.locator.document_id) {
        throw Object.assign(new Error('title 与 cursor 指向的资料不一致；请使用 cursor 对应的完整标题'),
          { code: 'INVALID_REQUEST' })
      }
    }
    return { ...restored, limits: {
      ...restored.limits,
      ...(args.max_lines !== undefined ? { max_lines: args.max_lines } : {}),
      ...(args.max_chars !== undefined ? { max_chars: args.max_chars } : {}),
    } }
  }
  const title = String(args.title ?? '').trim()
  if (!title) throw Object.assign(new Error('必须提供完整自然语言 title'), { code: 'INVALID_REQUEST' })
  const section = String(args.section ?? '').trim()
  const mode = args.mode || (section ? 'section' : Number.isInteger(args.line) ? 'around' : '')
  if (!mode) throw Object.assign(new Error('请提供 line、section 或 mode="document"'),
    { code: 'INVALID_REQUEST' })
  if (!['around', 'section', 'document'].includes(mode)) {
    throw Object.assign(new Error('mode 仅支持 document；line/section 会自动选择模式'),
      { code: 'INVALID_REQUEST' })
  }
  if (mode === 'around' && !Number.isInteger(args.line)) {
    throw Object.assign(new Error('around 模式必须提供整数 line'), { code: 'INVALID_REQUEST' })
  }
  const locator = { display_title: title }
  if (mode === 'section' && !section) {
    throw Object.assign(new Error('section 模式必须提供 section'), { code: 'INVALID_REQUEST' })
  }
  if (section && mode !== 'section') {
    throw Object.assign(new Error('section 只能与 mode=section 一起使用'), { code: 'INVALID_REQUEST' })
  }
  const selection = mode === 'document'
    ? { mode, cursor: null }
    : mode === 'section'
          ? { mode, section }
        : { mode: 'around', center_line: args.line,
          ...(args.before !== undefined ? { before_lines: args.before } : {}),
          ...(args.after !== undefined ? { after_lines: args.after } : {}) }
  return {
    locator, selection,
    limits: { ...(args.max_lines !== undefined ? { max_lines: args.max_lines } : {}),
      ...(args.max_chars !== undefined ? { max_chars: args.max_chars } : {}) },
  }
}

/** ---- 云端渲染（output.render 用，压缩为模型可读文本） ---- */

function renderCloudSearch(_args, value) {
  if (value.status === 'error') {
    return [{ type: 'text', text: `[cloud_search:error] ${value.error.code}: ${value.error.message}` }]
  }
  return [{ type: 'text', text: projectCloudSearch(value) }]
}

function renderCloudInspect(_args, value) {
  if (value.status === 'error') {
    return [{ type: 'text', text: `[cloud_inspect:error] ${value.error.code}: ${value.error.message}` }]
  }
  return [{ type: 'text', text: JSON.stringify(projectCloudInspect(value)) }]
}

/** ---- 插件入口 ---- */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   releasesDir?: string,
 *   cacheShards?: number,
 *   uiSkin?: 'harness' | 'prts-agent',
 *   download?: { releaseId?: string, order?: ('modelscope'|'site')[], siteBaseUrl?: string },
 *   cloud?: { baseUrl?: string, game?: 'arknights' | 'endfield', userId?: string, token?: string, timeoutMs?: number, maxResponseBytes?: number },
 * }} [config]
 */
export async function apply(ctx, config = {}) {
  // Cordis 传空配置时可能是 null 而非 undefined，默认参数不生效，需兜底
  config = config ?? {}
  // 工具开关：host 常驻时只做资料管理（registerTools:false），PRTS 预设（模式）加载时才注册工具（true）
  const enableTools = config.registerTools !== false
  const configuredHome = process.env.DSH_HOME?.trim()
  const dshHome = resolve(configuredHome || join(homedir(), '.dsh'))
  const portableReleasesDir = process.env.PRTS_CORPUS_RELEASES_DIR?.trim()
  const releasesDir = config.releasesDir
    ? (isAbsolute(config.releasesDir) ? config.releasesDir : resolve(process.cwd(), config.releasesDir))
    : portableReleasesDir ? resolve(portableReleasesDir) : join(dshHome, 'prts-corpus', 'releases')

  // 共享状态：三层配置（默认 ← patch ← $DSH_HOME/prts-corpus.json），设置页可运行时改
  const configPath = join(dshHome, 'prts-corpus.json')
  const shared = createSharedState({ patchConfig: config, configPath, releasesDir })
  await shared.loadConfig()

  // 云端匿名会话的持久 client id：跨重启稳定，服务端据此统计独立 DSH 用户。
  // 读不出来（只读 HOME 等）不致命——退回每次加载随机的旧行为。
  let cloudClientId = null
  try {
    cloudClientId = await readOrCreateClientId(join(dshHome, 'prts-corpus', 'client-id'))
  } catch (error) {
    ctx.logger?.warn?.(`prts-corpus: client-id 持久化失败（独立用户统计将不准确）: ${error?.message ?? error}`)
  }

  let storeEntry = storesByDirectory.get(releasesDir)
  if (!storeEntry) {
    storeEntry = {
      store: new CorpusStore({ releasesDir, cacheShards: shared.effective().cacheShards,
        cursorSecretPath: join(dshHome, 'prts-corpus', 'cursor-secret.bin') }),
      watcher: null,
      watchRefs: 0,
      releaseTimer: null,
      refs: 0,
    }
    storesByDirectory.set(releasesDir, storeEntry)
  }
  storeEntry.refs += 1
  ctx.effect(() => () => {
    storeEntry.refs -= 1
    if (storeEntry.refs === 0) storesByDirectory.delete(releasesDir)
  }, 'prts-corpus: shared store')
  const store = storeEntry.store
  shared.store = store
  const evidenceStates = createEvidenceStateRegistry()
  // DSH 自身不会以同一 callId 重试工具执行；此缓存只防御第三方 tools/execute
  // 策略在同一 exec 内的重放，避免重复扫描语料。完整跨重启幂等仍由未来共享
  // 调用存储承担，避免把检索正文写入配置目录。
  const completedSearchCalls = new Map()

  const stopWatching = await shared.watchConfig(ctx.logger)
  ctx.effect(() => stopWatching, 'prts-corpus: config watch')
  ctx.effect(() => shared.subscribe((effective) => {
    store.cacheShards = effective.cacheShards
  }), 'prts-corpus: store config')

  // Host 常驻实例拥有 PRTS preset 的资料准入；preset 自身直到准入通过才会挂载。
  if (config.registerUi !== false) {
    ctx.inject(['agentPresets'], (presetCtx) => {
      let preparing = null
      let preparationError = null
      const notify = () => { presetCtx.agentPresets.notifyAvailability('prts') }
      const installed = async () => {
        try {
          const pointer = JSON.parse(await readFile(join(releasesDir, 'current.json'), 'utf8'))
          const releaseId = String(pointer.release_id || '')
          if (!releaseId) return false
          const manifest = JSON.parse(await readFile(
            join(releasesDir, releaseId, 'release-manifest.json'), 'utf8'))
          return manifest.release_id === releaseId && /^[0-9a-f]{64}$/.test(String(manifest.data_version || ''))
        } catch {
          return false
        }
      }
      const availability = async () => {
        if (shared.download.active) return {
          status: 'preparing', reason: '资料正在下载。可在“设置 → 插件 → PRTS 语料”查看进度。',
        }
        if (preparing) return { status: 'preparing', reason: '资料已安装，正在准备本地索引和实体别名。' }
        if (isEntityRecognitionReady(store)) return undefined
        if (preparationError) return {
          status: 'blocked',
          reason: `资料准备失败：${preparationError}。请前往“设置 → 插件 → PRTS 语料”检查或重新下载。`,
        }
        if (!await installed()) return {
          status: 'blocked',
          reason: process.env.PRTS_PORTABLE === '1'
            ? '发行版语料缺失或配置无效。请确认 ZIP 已完整解压；也可前往“设置 → 插件 → PRTS 语料 → 版本管理”重新下载。'
            : '尚未安装资料或资料目录配置无效。请前往“设置 → 插件 → PRTS 语料 → 版本管理”下载并检查配置。',
        }
        if (!preparing) {
          preparing = store.ready()
            .then(() => prepareEntityRecognition(store))
            .catch((error) => { preparationError = error?.message ?? String(error) })
            .finally(() => {
              preparing = null
              notify()
            })
        }
        return { status: 'preparing', reason: '资料已安装，正在准备本地索引和实体别名。' }
      }
      presetCtx.agentPresets.registerAvailability('prts', availability)
      presetCtx.effect(() => shared.subscribeRuntime(() => {
        preparationError = null
        if (!shared.download.active) store.reset()
        notify()
      }), 'prts-corpus: preset availability')
    })
  }

  const mountTools = (toolCtx) => {
    const tools = toolCtx.tools
    // Host 的 preset 准入已经完成初始化；工具挂载不再触发下载或全量扫描。
    applyEntityRecognition(toolCtx, store)
    tools.register({
      name: 'corpus_search',
      description: SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMETERS,
      output: { schema: SEARCH_OUTPUT_SCHEMA, render: renderSearch },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const evidenceState = evidenceStates.forExecution(exec)
        const callId = String(exec?.callId || '')
        // 先做对象校验再做幂等哈希：JSON.stringify(undefined) 返回 undefined，
        // 直接 update 会抛 TypeError，绕过本工具的 INVALID_REQUEST 错误通道。
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw Object.assign(new Error('搜索参数必须是对象'),
            { code: 'INVALID_REQUEST', retryable: false })
        }
        const enabledGames = shared.effective().enabledGames
        let scopedArgs = args
        if (args.cursor == null) {
          const requestedGames = Array.isArray(args.games) ? args.games : enabledGames
          const games = requestedGames.filter((game) => enabledGames.includes(game))
          if (!games.length) {
            throw Object.assign(new Error('请求的游戏资料库当前未启用，请先在 PRTS 资料设置中勾选'),
              { code: 'INVALID_REQUEST', retryable: false })
          }
          scopedArgs = { ...args, games }
        }
        const requestHash = createHash('sha256').update(JSON.stringify(scopedArgs)).digest('hex')
        if (callId && completedSearchCalls.has(callId)) {
          const cached = completedSearchCalls.get(callId)
          if (cached.requestHash !== requestHash) return {
            contract_version: 'prts-corpus-tools-v1', status: 'error', request_id: callId,
            data_version: store.dataVersion ?? null,
            error: { code: 'INVALID_REQUEST', message: 'callId 已绑定到另一个搜索请求', retryable: false },
          }
          return structuredClone(cached.response)
        }
        const response = await executeSearch(store, scopedArgs, { signal: exec?.signal,
          requestId: callId || undefined })
        if (response?.error) {
          throw Object.assign(new Error(response.error.message),
            { code: response.error.code, retryable: response.error.retryable })
        }
        if (callId) {
          completedSearchCalls.set(callId, { requestHash, response: structuredClone(response) })
          if (completedSearchCalls.size > 256) completedSearchCalls.delete(completedSearchCalls.keys().next().value)
        }
        rememberSearchCandidates(evidenceState, response)
        return response
      },
    })

    tools.register({
      name: 'corpus_read',
      description: READ_DESCRIPTION,
      parameters: READ_PARAMETERS,
      output: { schema: READ_OUTPUT_SCHEMA, render: renderRead },
      timeoutMs: 120_000,
      // 原文覆盖去重依赖前一个 tool/result 已进入模型可见 surface。并行
      // 读取会让同一步的每个调用都误判为首次读取，因此必须由 Harness 按
      // 模型调用顺序独占执行并逐个提交结果。
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const evidenceState = evidenceStates.forExecution(exec)
        let contract
        try {
          contract = await modelReadToContract(args, store)
        } catch (error) {
          throw Object.assign(new Error(error.message),
            { code: error.code || 'INVALID_REQUEST', retryable: false })
        }
        // 证据覆盖按 Harness Agent 隔离；模型不感知 intent_id。
        contract.intent_id = evidenceState.intentId
        const requested = await resolveReadWindow(store, contract)
        const visibleResults = visibleToolResults(exec?.agent)
        if (coveredRead(evidenceState, requested, visibleResults)) {
          const replay = replayCoveredRead(evidenceState, requested, contract)
          if (replay) return projectReadPublic(replay)
        }
        const coveragePlan = planReadCoverage(evidenceState, requested, visibleResults)
        const requestedLineCount = requested ? requested.lineEnd - requested.lineStart + 1 : Infinity
        const partial = coveragePlan?.reusedRanges.length > 0 && coveragePlan.unreadRanges.length > 0
          && requestedLineCount <= Number(contract.limits?.max_lines || 100)
        if (partial) {
          const responses = []
          for (const range of coveragePlan.unreadRanges) {
            const partialContract = structuredClone(contract)
            partialContract.selection = { mode: 'range', start_line: range.lineStart, end_line: range.lineEnd }
            const response = await executeRead(store, partialContract, { signal: exec?.signal })
            if (response.status !== 'ok') throw Object.assign(new Error(response.error.message), response.error)
            rememberRead(evidenceState, response, { callId: String(exec?.callId || '') })
            responses.push(response)
            if (exec?.callId) {
              visibleResults.set(String(exec.callId),
                responses.map((item) => renderRead({}, item)[0]?.text || '').join('\n'))
            }
          }
          return projectReadPublic(combinePartialReadResponses(requested, contract, coveragePlan, responses,
            Boolean(coveredRead(evidenceState, requested, visibleResults))))
        }
        const response = await executeRead(store, contract, { signal: exec?.signal })
        if (response.status !== 'ok') throw Object.assign(new Error(response.error.message), response.error)
        rememberRead(evidenceState, response, { callId: String(exec?.callId || '') })
        return projectReadPublic(response)
      },
    })

    tools.register({
      name: 'timeline_search',
      description: TIMELINE_DESCRIPTION,
      parameters: TIMELINE_PARAMETERS,
      output: { schema: {}, render: renderTimeline },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      execute: (args, exec) => executeTimelineSearch(store, args, { signal: exec?.signal }),
    })

    // 云端工具：按生效配置注册，配置变更（设置页）时 dispose + 热重建
    const cloudDisposers = []
    const rebuildCloud = () => {
      for (const dispose of cloudDisposers.splice(0)) {
        try { dispose() } catch { /* 卸载旧注册 */ }
      }
      const c = shared.effective()
      if (!c.cloudEnabled || !c.cloudBaseUrl) return false
      const cloudClients = createAgentCloudClientRegistry(() => {
        const tokenProvider = c.cloudToken
          ? new StaticTokenProvider(c.cloudToken)
          : new AnonymousSessionProvider({ baseUrl: c.cloudBaseUrl,
            userId: c.cloudUserId || cloudClientId || undefined,
            timeoutMs: c.cloudTimeoutMs })
        const cloudGame = c.enabledGames.length === 2 ? 'all' : c.enabledGames[0]
        return new CloudRetrievalClient({
          baseUrl: c.cloudBaseUrl, tokenProvider, game: cloudGame,
          timeoutMs: c.cloudTimeoutMs, maxResponseBytes: c.cloudMaxResponseBytes,
        })
      })
      const searchDispose = tools.register({
        name: 'cloud_search',
        description: CLOUD_SEARCH_DESCRIPTION,
        parameters: CLOUD_SEARCH_PARAMETERS,
        output: { schema: {}, render: renderCloudSearch },
        timeoutMs: 180_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          try {
            const evidenceState = evidenceStates.forExecution(exec)
            const cloud = cloudClients.forExecution(exec)
            await cloud.capabilities({ signal: exec?.signal })
            const requestedGames = Array.isArray(args.games) ? args.games : c.enabledGames
            const games = requestedGames.filter((game) => c.enabledGames.includes(game))
            if (!games.length) throw Object.assign(
              new Error('请求的游戏资料库当前未启用，请先在 PRTS 资料设置中勾选'),
              { code: 'INVALID_REQUEST', retryable: false })
            const payload = { ...args, games, intent_id: evidenceState.cloudIntentId }
            const response = await cloud.search(payload, { signal: exec?.signal })
            const mapped = await attachLocalSourceMappings(store, response, { signal: exec?.signal })
            rememberCloudMappings(evidenceState, mapped)
            return mapped
          } catch (error) {
            return cloudErrorResponse(error)
          }
        },
      })
      if (typeof searchDispose === 'function') cloudDisposers.push(searchDispose)

      const inspectDispose = tools.register({
        name: 'cloud_inspect',
        description: CLOUD_INSPECT_DESCRIPTION,
        parameters: CLOUD_INSPECT_PARAMETERS,
        output: { schema: {}, render: renderCloudInspect },
        timeoutMs: 120_000,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          try {
            const evidenceState = evidenceStates.forExecution(exec)
            const cloud = cloudClients.forExecution(exec)
            await cloud.capabilities({ signal: exec?.signal })
            const payload = { ...args,
              ...(args.request_id || !evidenceState.lastCloudRequestId
                ? {} : { request_id: evidenceState.lastCloudRequestId }) }
            const response = await cloud.inspect(payload, { signal: exec?.signal })
            const mapped = await attachLocalSourceMappings(store, response, { signal: exec?.signal })
            rememberCloudMappings(evidenceState, mapped)
            return mapped
          } catch (error) {
            return cloudErrorResponse(error)
          }
        },
      })
      if (typeof inspectDispose === 'function') cloudDisposers.push(inspectDispose)

      toolCtx.logger?.info?.(`prts-corpus: cloud tools enabled (baseUrl=${c.cloudBaseUrl}, games=${c.enabledGames.join(',')})`)
      return true
    }
    rebuildCloud()
    toolCtx.effect(() => shared.subscribe(rebuildCloud), 'prts-corpus: cloud config')
  }

  // tools/connection 都是可选部署能力；ctx.inject 会等待其出现并在其消失时
  // 自动卸载对应子树，避免“插件 ACTIVE 但永久漏注册”的启动顺序竞态。
  // Agent preset 的 standing mount 必须等工具子 fiber 完成注册后才能宣告就绪。
  // 不 await 会形成“Skill 已可见、工具仍缺席”的半挂载会话，且子 fiber 的
  // schema/注册异常也无法阻止该会话创建。
  if (enableTools) await ctx.inject(['tools'], mountTools)

  if (enableTools) {
    await mkdir(releasesDir, { recursive: true })
    storeEntry.watchRefs += 1
    if (!storeEntry.watcher) {
      storeEntry.watcher = watch(releasesDir, { persistent: false }, (_event, filename) => {
        if (String(filename ?? '') !== 'current.json') return
        if (storeEntry.releaseTimer) clearTimeout(storeEntry.releaseTimer)
        storeEntry.releaseTimer = setTimeout(async () => {
          storeEntry.releaseTimer = null
          try {
            const pointer = JSON.parse(await readFile(join(releasesDir, 'current.json'), 'utf8'))
            if (store.loaded && store.releaseId === pointer.release_id) return
          } catch { /* 让 ready() 输出真实指针错误 */ }
          store.reset()
          store.ready().catch((error) => {
            ctx.logger?.warn?.(`prts-corpus: 版本热切换失败: ${error?.message ?? error}`)
          })
        }, 100)
      })
    }
    ctx.effect(() => () => {
      storeEntry.watchRefs -= 1
      if (storeEntry.watchRefs > 0) return
      if (storeEntry.releaseTimer) clearTimeout(storeEntry.releaseTimer)
      storeEntry.releaseTimer = null
      storeEntry.watcher?.close()
      storeEntry.watcher = null
    }, 'prts-corpus: release watch')
  }

  // 设置页 API（connection 为可选服务；headless profile 不挂载）。
  // host 常驻（registerUi 缺省 true）注册 /api/prts-corpus + 设置 tab 数据源；
  // PRTS 预设（registerUi:false）只注册工具，避免与 host 重复注册同名前缀路由。
  if (config.registerUi !== false) {
    ctx.inject(['connection'], (connectionCtx) => { applyUi(connectionCtx, shared) })
  }
}
