# 云端工具

## cloud_search

- 一般把它作为第一轮分析入口：使用完整自然语言问题取得事件、实体、资料与可读原文位置，再决定是否需要本地精确核验。
- `query` 写成语义完整、可独立理解的自然语言，不使用关键词堆。
- 模糊的一句原文用 `single_sentence_search`；一段情节或人物互动交给默认主站意图路由；准确词句、篇章和行号改用本地工具。
- 默认 `evidence_policy=mixed` 完整复用 PRTS.chat 主站的意图路由、召回、审核、Cleaner 和上下文预算；不要自行设置渠道、过滤器、阈值或候选预算。
- `evidence_policy=original_only` 明确切换到仅官方剧情原文的向量检索路线，不附加实体资料、Wiki 或时间线，适合用于模糊搜索场景以及用户提问的单句原文。
- cloud_search 返回末尾的「## 可读取原文」列出已映射到本地篇章的标题与行号，可直接据此读取原文。用户没有要求原文且整理性证据足够、无冲突时，不必机械追读。

## cloud_inspect

- 默认检查最近一次云端检索，运行时会注入 `request_id`。
- `selected_sources` 与 `answer_context` 用于定点读取回答材料；`candidates` 用于检查候选状态；`events` 与 `trace_steps` 只在诊断时使用。
- 按 `next_cursor` 继续分页，避免重叠读取；`content_mode=none` 只取结构，`preview` 取受限正文，`full` 取当前页完整正文。
