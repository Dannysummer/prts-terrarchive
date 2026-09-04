# 当前工具契约

## `corpus_search`

它是本地结构化字面检索，不接收完整研究问题。可用参数为 `query`、`games`、`resource_types`、`content_types`、`collection_names`、`character_names`、`story_names`、`activity_names`、`wiki_sections`、`entity_names`、`speakers`、`match_mode`、`context_terms`、`after`。

同一数组内 OR，不同过滤字段间 AND。`query` 默认连续字面匹配；只有确需模式时才用受限 `regex`。省略 `query` 可按归属列目录；省略 `query` 且指定一个 Wiki 字段可返回完整字段。分页必须保留原条件并把结果的 `page.next_after` 原样放进 `after`，直到 `page.exhausted=true`。

## `corpus_read`

- 定点上下文：`{title, line, before?, after?}`。
- Wiki 字段：`{title, section}`。
- 全文首段：`{title, mode:"document", max_lines?, max_chars?}`。
- 全文续读：原样提交结果的 `page.continuation`，即 `{title, mode:"document", line}`；可以另加 `max_lines/max_chars`。

只使用工具返回的完整自然标题。新调用不要创建 cursor；旧会话已有 cursor 时才使用兼容入口。

## `timeline_search`

可用 `query`、`activity_names`、`entity_names`、`year_start`、`year_end`、`source_marker`、`max_results`。`entity_names` 会展开别名；不同维度取交集。`source_marker` 仅用于反查来源，不写入回答。

## `cloud_search`

模型可见参数只有 `query`、`games`、兼容字段 `depth`、`evidence_policy`，以及可选的 `options.search_intent="single_sentence_search"`。不要发送 channels、filters、阈值、候选预算、`quote_search` 或 `scene_search`。

默认省略 `depth/options` 并使用 `evidence_policy="mixed"`。只有一句官方剧情原文的大意且措辞可能不准时使用 `single_sentence_search`；`original_only` 会切到仅官方剧情原文的向量路线。结果末尾的可读取标题与行号可直接交给 `corpus_read`。

## `cloud_inspect`

仅在云端结果截断、来源不清或诊断召回时使用。通常省略 `request_id`，运行时会关联最近一次云端请求；按返回的整数 `next_cursor` 分页。优先查看 `selected_sources` 或 `answer_context`，诊断时再看 `candidates/events/trace_steps`。
