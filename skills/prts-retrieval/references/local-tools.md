# 本地工具补充

实际调用参数以运行时附加的“当前工具契约”为准；本页只补充字段语义。

## 统一过滤字段

- `games`：`arknights`、`endfield`。明确单游戏时必须收窄；双游戏比较可联合发现、分侧核验。
- `resource_types`：两款游戏共用字段，但可选值不同。明日方舟使用 `story`、`operator_record`、`character_*`、`*_wiki` 等；终末地使用 `original_story`、`archive`、`knowledge`、`wiki`、`character_story`、`timeline`。不要跨模块套类型。
- `content_types`：内容形式，终末地原文尤其适合用它区分对话、过场、广播、远程通讯、黑屏文字、环境对话和 SNS。
- `collection_names`：统一的上级集合字段，可表示明日方舟活动或终末地任务/资料集合。
- `character_names` 是资料归属；`speakers` 是亲口说话；`entity_names` 是正文或结构化关系中出现。

本地资料不包含云端图谱、向量候选和 Cleaner 结果；本地零命中不能推出云端也无结果。

## 读取与分页

搜索分页保留原条件并原样提交 `page.next_after`。全文读取续页原样提交 `page.continuation`：`{title, mode:"document", line}`。around 读取的 `has_more=false` 只描述该次窗口，不能证明整篇文档已结束。
