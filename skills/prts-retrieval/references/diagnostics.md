# 检索诊断

只在工具失败、候选异常或需要解释召回过程时使用这些步骤。

- 本地无命中：缩短 `query`，确认使用展示名而非内部 ID；逐步放宽人物、篇章、活动或年份过滤条件。
- 角色 Wiki 命中其他页面的提及：不要只全文搜角色名，改用 `resource_types=["character_wiki"]` + `character_names`。
- 只需要角色页某个字段却得到整页：省略 query，并只选择一个 `wiki_sections` 值，让搜索直接返回完整字段。活动页使用 `story_wiki + activity_names`。
- `reviewed_wiki` 命中辅助生成材料：改用 `character_wiki` 或 `story_wiki`；只有明确需要角色×活动细节时才使用 `character_activity_wiki`。
- 云端无合适候选：先检查 `cloud_inspect` 的 `selected_sources`、`answer_context` 和 `candidates`，再决定是否调整检索意图或查询表达。
- 云端结果需落到原文：优先使用 cloud_search 返回末尾「## 可读取原文」中的本地标题与行号；没有稳定映射时，再以活动、篇名、人物与短原句调用 `corpus_search`。
- 结果互相冲突：比较资料覆盖范围与上下文，读取冲突位置的原文；最终以原文为准，并在结论有实质影响时说明存在资料归纳差异。
- 已有证据足以回答时停止，不为了形式完整机械调用全部工具。
