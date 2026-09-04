# 当前模块：明日方舟

调用本地或云端检索时使用 `games:["arknights"]`，除非运行时上下文表明问题还涉及终末地。

明日方舟本地资料类型：

- 原文：`story`；干员密录原文可用 `operator_record`。
- 官方角色资料：`character_profile`、`character_module`、`character_voice`、`character_skin`；不确定落在哪类时用 `character_bundle`。
- 整理资料：`character_wiki`、`story_wiki`、`character_activity_wiki`；确需跨 Wiki 搜索才用 `reviewed_wiki`。
- 设定与导航：`terra_journey`、`entity_profile`、`reference`。

`character_names` 是资料归属，`speakers` 是亲口说话，`entity_names` 是正文或结构化关系中出现；不同字段取交集。活动使用 `activity_names`，篇章使用 `story_names`，上级集合也可使用 `collection_names`。

常见路线：

- 角色参加活动：`character_wiki + character_names + wiki_sections:["相关活动"]`。
- 角色在活动中的作用：`story_wiki + activity_names + wiki_sections:["角色剧情概括"]`，再按需要查 `character_activity_wiki` 或官方原文。
- 亲口台词：`story/operator_record + speakers`，不要以 `entity_names` 代替说话人。
- 事件年代与顺序：优先 `timeline_search`；时间线是整理性证据，精确剧情仍回原文。
