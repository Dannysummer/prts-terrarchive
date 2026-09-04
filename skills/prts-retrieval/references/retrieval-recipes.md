# 明日方舟检索配方

以下流程只在明日方舟模块启用时使用，并始终带 `games:["arknights"]`。

## 角色参加过哪些活动

1. `corpus_search({games:["arknights"], resource_types:["character_wiki"], character_names:[角色], wiki_sections:["相关活动"]})`。
2. 使用完整字段按原顺序整理活动和作用，不用全文搜角色名重新拼清单。
3. 用户要求确认某次实际参与时，再用 `story/operator_record + activity_names + entity_names` 定位；需要精确动作或台词时读取上下文。

## 某角色在某活动中的作用

1. 查 `story_wiki + activity_names + wiki_sections:["角色剧情概括"] + query:角色`。
2. 需要更细过程时，查 `character_activity_wiki + character_names + activity_names + wiki_sections:["相关剧情总结"]`。
3. 需要具体行动、说话人或因果时，以活动和角色为范围搜索 `story/operator_record`，再读取命中上下文。

## 某活动的整体研究

1. 默认 `cloud_search` 建立事件和人物骨架；若只需现成概括，直接读 `story_wiki` 的 `剧情总结`。
2. 读 `关键人物` 建立人物集合，按需读取目标人物的 `角色剧情概括`。
3. 用 `timeline_search(activity_names:[活动])` 补时间位置。
4. 只对会影响结论的关键事件回到官方原文，不机械通读全部篇章。

## 人物关系

1. 默认 `cloud_search` 搜索双方、关系和关键事件。
2. 分别读取双方 `character_wiki` 的 `相关角色`，检查是否双向出现及叙述是否一致。
3. 对关系起因、变化、冲突或态度，按云端映射或活动线索读取 `story/operator_record` 原文。

## 台词与说话人

1. 确切短句：`corpus_search({games:["arknights"], query:短句, resource_types:["story","operator_record"]})`。
2. 查询某人亲口说的话时加 `speakers:[角色]`；查询谈及某人时才用 `entity_names`。
3. 只记得大意时走 `single_sentence_search`，随后以返回标题和行号读取上下文。

## 人物综合资料

先用角色 Wiki 的 `简要介绍/详细介绍/相关活动` 建立骨架；身份和身体资料查 `character_profile`，补充经历查 `character_module/operator_record`，原话与称呼查 `character_voice/story`。只核验实际用于回答的结论。
