# 连续读回路由修复与正式验证

基于 PR #11 `6592a01`，控制器标记为 `automation-layered-controller-v10`。

验证：完整回归 404/404 通过、0失败、0跳过；包含真实已安装 Automation 模拟环境。类型检查和 campaign 脚本语法检查通过。在线成绩另存运行目录，不能用回归通过代替正确率结果。

完整记录 GET 未返回某个写入字段时，检查器会生成字段投影查询。v9 的 inspect Loop step 未保存这条新 inspection，也没有继续进入 inspect，可能直接要求模型重新决策并耗尽复查额度。

v10 在 inspect step 同时保存 result.inspection，先处理真实冲突/停滞的复查，再执行下一条 requiresInspection，队列为空才返回模型。未编造读取结果、修改写入参数或放宽评分。查询失败仍保留为观察；队列消费和既有 Loop/复查预算限制重复。

新增原生执行器集成回归覆盖：

- 目录发现 → 完整记录读取 → 写入 → 完整读回 → 缺失字段投影，在下一次模型决策前执行完成；保留 AccountId 等完整记录关系。
- 投影返回真实错误时只派发一次，保持 unverified，不伪造成功；复查额度耗尽可以正常退出。
- 既有“目标字段未变但时间戳变化”的真实冲突路由继续受测。

## 完整验证和 Search/Test

`scripts/run_automation_route_campaign.mjs` 显式运行以下流程：

1. 完整固定 Automation Search200，每题一次，验证 v10。使用公开 HubSpot 目录兼容模式；没有调用优化器。
2. 验证有效完成后，分别启动 DROP 和 Automation 正式 Search，每题五遍，最多三个完整有效候选（含基线）、两个设计轮、同轮最多三次提案。DROP 使用默认 baseline；Automation 显式传入 v10 完整声明式定义作为 seed，Actor strategy/system 未改。
3. Search 按既有规则停止后读取冻结的 selectedBeforeTest 工件，再运行 DROP Test800 和 Automation Test600，各三遍。两个数据集可独立推进，Test 不回流任何优化器。

为接受明确的 Search seed，runner 增加只用于程序调用的 initialDefinition 选项，进入现有验证和初始定义哈希；Test 会在创建 provider 前拒绝该替换参数。原 CLI 默认初始化和旧实验目录不变。

验证阶段累计工作流重试上限为五次，并保留每一次失败/用量。正式 Search/Test 使用 main 既有恢复、固定划分、评分、阶段淘汰和冻结协议。一次零分不自动判作工程无效，运行报告另列停止预算、模型格式错误及适配故障。

运行前提交并冻结代码，设置已有 DITTO_PROVIDER_PYTHON、DITTO_AUTOMATION_ROOT、DITTO_AUTOMATION_PYTHON 和 DITTO_AUTOMATION_DATA，使用原有忽略的凭据文件：

```powershell
node --experimental-vm-modules --env-file-if-exists=../ditto-workflow-search/.env scripts/run_automation_route_campaign.mjs ../output/automation-route-campaign-20261110
```

恢复同一完整运行时身份时，在命令末尾加 `resume`；不能混入旧暂停实验或 v2/v9 的结果。

完整代码快照、运行时身份、单独的阶段用量、每题结果和冻结工件写入独立目录。新 seed 不会静默成为旧 CLI 的默认。若模型余额或服务故障中断，脚本保留检查点并标为 interrupted，不宣称完成，也不会在无完整 Search 选择时开始 Test。
