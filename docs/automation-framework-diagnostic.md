# AutomationBench 执行与复查

基于 main `98621f318d88c5cb71ecc9e3952b0ac399978dba`。
当前候选为 `automation-layered-controller-v9`，改动集中在框架。

## 使用的提示词和配置

- 执行 system：`src/graph-agent/system.ts` 的 `NODE_SYSTEM_PROMPT`，版本
  `ditto-node-system-unified-v1`，正文未修改。
- 决策指令：`src/graph-agent/automation-baseline.ts` 的
  `AUTOMATION_DECISION_INSTRUCTION`，由 `officialBaseline('automationbench')`
  使用，正文未修改。
- 复查：Ditto 0.1.5 原生 REFLECT，使用未修改的
  `REFLECTION_SYSTEM_CONTRACT`。实际读取、写入回执和状态快照作为任务证据。
- `prompts/official-optimizer-system.en.md` 仅记录身份，`invoked:false`。
  本轮没有调用优化器搜索工作流，也没有使用旧提示词池。
- 模型 `deepseek-flash`；temperature 0；`maxTokens=393216`；每题一次，
  `firstTaskRepeat=false`。单组评测并发 4，预算上限 4,000 次调用、15,000,000 token。

## 已查明的问题与框架修改

### 1. 写入前先读取真实字段或表头

手机号题曾把手机号写进独立的 `Phone` 字段，`MobilePhone` 没有更新。
表格题曾把六列表头当成五列，将联系人和公司合并，导致后续列错位。

`src/official-agent/mutation-inspection.ts` 根据模型提出的资源 URL 和请求结构，
从实际发现的公开 GET 契约中选择只读检查。位置式表格写入先读取表头；
PATCH/PUT 先读取记录。读完交回模型重新决策，框架不替模型选择业务字段或填写答案。
没有匹配的公开读取契约时，不编造 GET；失败读取保留证据并限制重复尝试。

实际中间候选观察到：

```text
改前：PATCH {Phone: 新手机号}
改后：读取记录中的 Phone / MobilePhone → 模型选择 PATCH {MobilePhone: 新手机号}

改前：[Date, Type, "联系人 + 公司", Notes, Outcome]
改后：读取六列表头 → [Date, Type, Contact, Company, Notes, Outcome]
```

这些单题观察不等于最终 v9 的完整评测成绩。

### 2. 写后读回，保留完整关系信息并补查缺失字段

`mutation-inspection.ts` 在已发现的契约允许时，读取刚写入的完整记录。
创建记录返回 ID 后，也可通过匹配的真实 GET 验证新记录。
完整读取未返回所写字段时，在实际发现 Salesforce query 契约及其 `q` 参数的前提下，
补充查询这些字段；查询类型、记录 ID 和投影字段均来自实际写请求。
完整记录先保留公司关系等信息，补充查询不会将其替换掉。

`src/official-agent/execution-evidence.ts` 分开记录写入意图、实际读取和执行回执：

- 字段没有返回：`unverified`，列出 `unobservedFields`，不直接判错。
- 字段明确返回不同值：`conflicting`。
- 实际返回值符合请求：`witnessed`。
- 连续 PATCH 合并字段；PUT 替换；同一集合的多个 POST 分别保留。
- 日期按请求精度比较；带明确时区的 ISO 时间按同一时刻比较，不猜测无时区时间，
  不抹去真实时间、类型或超出支持精度的差异。

```text
改前：GET 没返回 MailingCity → 误报冲突 → 反复写入
改后：记录为未观察到；有合法查询契约时补查该字段

改前：15:00:00Z 与 15:00:00+00:00 → 冲突
改后：同一时刻 → 匹配；实际相差八小时仍为冲突
```

### 3. 明确没有生效的写入立即转入复查

接口可能返回成功并更新修改时间，但忽略请求中的某个字段。
仅比较整条返回内容会把新时间戳误当成业务进展。

`src/official-agent/progress.ts` 与 `src/official-agent/layered-controller.ts`
将最新写入的明确读回冲突接入复查分支，自动读取完成后也能触发。
路由比较的是最近一次真实写入；历史上被忽略的其他字段仍留在审计账本，
不会使后续正确写入反复被当作新失败。

```text
改前：写入 → 返回 {} → 时间戳变了、目标字段没变 → 一直重写
改后：写入 → 真实 GET 确认目标字段仍不同 → 复查 → 模型重新选择处理方式
```

### 4. 将最终任务目标与历史写入意图区分

公司题中，旧 Account 读取返回真实 404。模型后来创建新公司并关联联系人，
官方评分通过，但旧复查仍坚持修改不存在的旧公司。
另有候选曾向联系人姓名字段写入公司名；即使该写入没有被接口接受，
历史请求值仍持续影响复查结论。

`src/official-agent/automation-review.ts` 组织独立的状态证据：

- 原始任务仍由原标准指令给出。
- 最近真实资源状态及原始邮件等读取证据用于判断任务目标。
- 真实写入方法、资源、成功回执继续提供，避免只看状态而误以为没有执行操作。
- 邮件发送和无法读回的字段仍提供原始请求及回执；MIME/base64 只做可读展示。
- 旧复查意见和已经被替代的模型计划不作为新一轮复查依据。
- 全部历史请求、冲突、错误和模型原文仍保留在公开轨迹与审计账本。
- `passed:true` 若与同次 `severity:error` 矛盾，不放行结束；复查上限仍为四次。

这套机制不把官方得分或隐藏评分状态交给执行模型。
公司题是否能在最终候选中正常结束，仍需完成在线验证。

### 5. 保留协议恢复与接口兼容修复

`decision-protocol.ts` 解码原始 JSON、说明文字中的单个 JSON 或 DeepSeek DSML
单动作，保留原参数；拒绝多动作、重复键和歧义输出，并限制恢复次数。

HubSpot 公开目录的 `/associations/contact/...` 与本地路由要求的
`/associations/contacts/...` 不一致。显式设置
`DITTO_AUTOMATION_COMPAT=hubspot-association-catalog-v1` 时仅修正该目录项，
默认关闭，并保留原目录及兼容事件。标准对照与候选均启用同一兼容设置。
这属于本地路由契约问题。

报告脚本 `scripts/automation_layered_report.mjs` 从执行历史节点还原实际命令，
避免把框架暂缓 PATCH 后执行的 GET 错标为 PATCH。

## 验证状态

仅包含待提交文件的独立代码副本执行 `npm test`：
**393 通过、0 失败、8 项可选检查跳过**。
覆盖真实读前检查、创建后读取、字段缺失、时间精度、回执保留、旧意图隔离，
以及目标字段不变但修改时间不断变化时的实际复查路由。

此前已经完成的同环境单次结果：

| 版本 | 完成题数 | 通过 | 用量 |
| --- | --- | --- | --- |
| 标准执行器，同一 HubSpot 目录修复 | 200 | 194（97%） | 1,089 次调用；3,335,780 token |
| 旧控制器 v2 | 200 | 196（98%） | 1,154 次调用；1,155 次 HTTP 尝试；至少 3,755,991 token |
| 当前 v9 | 尚无有效完成题 | 待评测 | 首次请求即 HTTP 402，余额不足 |

v2 的一次底层尝试没有返回用量，因此 token 是下限。
中间候选均在发现框架问题后中断，不能拼接为 v9 的完整结果。
本次属于 Search/validate 上的单次框架验证，没有自动搜索选优或独立 Test 成绩。

两道邮件任务的已有公开轨迹显示，工单解决/会议创建及邮件发送已实际执行，
但官方分数仍为零。离线检查定位到邮件标题的严格字符串匹配差异；
执行提示词、框架和工具中没有加入这些隐藏匹配词，评分器保持原样。

## 复现与运行产物

先配置正常的模型接口、provider Python 和 AutomationBench 环境。
数据默认位于 `data/automationbench`，也可设置 `DITTO_AUTOMATION_DATA`。

```powershell
npm run build
node --experimental-vm-modules --env-file=.env scripts/automation_layered_comparison.mjs runs/automation-layered-v9/comparison layered-only
node scripts/automation_layered_report.mjs runs/automation-layered-v9/comparison <已有标准对照目录>
```

每个候选使用独立目录。运行身份、代码快照、标准提示词、预算账本、checkpoint 和
公开轨迹保留在被忽略的 `runs/` 中；付费接口失败可保留现场继续恢复。
提交不包含密钥、数据集、依赖、私有评分状态或大型运行产物。
