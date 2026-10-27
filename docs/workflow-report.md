# 每轮工作流可视化

`scripts/render-workflow-report.py` 从已完成的验证产物生成 PNG。只读取 run manifest、immutable checkpoint、evaluation summary，以及 samples 中的耗时和调用遥测，不读取题面、预测、标准答案或测试集。

默认使用简洁版：方案与轮次、F1、题数×次数、真实工作流程、新增模型调用和 Token。多次确认显示平均分与各次分数；200题扩展对照可显示原64题和新增136题的成绩。工程版本、父候选缺失说明及重复成本口径不放在默认图里。需要完整审计展示时加 `--detailed`。

本机 Python（含 Pillow）：

```powershell
python scripts/render-workflow-report.py runs/prompt-comparison/drop/<run-id> --output outputs/drop-workflow-report.png
```

多个 run 目录按初始流程优先传入，可以跨 run 对比。加 `--watch 5` 后每五秒检查一次；每个候选完成验证时，生成一张“初始流程 / 当前候选”对照卡，并更新横向总览。stdout 输出 JSON 消息及绝对图片路径，供主实验进程或聊天展示。

图中节点、Graph 和 Loop 转移来自保存的定义；只有明确声明的依赖才连线，独立节点不会伪造先后关系。完整模块的返回值标注为 Loop 返回。详细版可显示与实际父候选的结构差异。

F1 和各次得分取自 summary。默认图的新增调用和 Token 取 summary.newUsage，仅含当前候选新增验证费用。整个搜索包含优化器的总账保存在 manifest.newUsage；详细版另行展示。缺少遥测时标记未知，不用节点数乘题数猜测。

完成标准：summary 和 samples 均已发布，并且题次条数等于 examples × repeats。无效评测在图中明确标记，不显示可比较分数。
