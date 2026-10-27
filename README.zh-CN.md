# pi-resilient-retry

持续重试那些 Pi 内置重试**放弃**的上游 API 失败，让长任务不再因一次报错而中断。

[English](README.md) | 中文

## 推荐搭配安装

本扩展解决「任务不被打断」。如果你还想在自动重试之外**手动精准续跑**，
请同时安装 [pi-retry](https://github.com/ZhiAo1120/pi-retry)：

| | pi-resilient-retry（本扩展） | pi-retry |
|---|---|---|
| 触发方式 | 自动，失败即重试 | 手动敲 `/retry` |
| 定位 | 后台重试，任务不中断 | 精准续跑，不重放已完成操作 |
| 重试次数 | 不限（可配置） | 最多 3 次，超出即拦下并提示原因 |
| 历史修复 | 仅在上游明确报告 ID 失效时剥 id | `/retry` 剥 id，`--deep` 连 reasoning 一起剥 |

两者生命周期钩子互不冲突，可同时安装。一个负责「不让任务中断」，一个负责「你想介入时精准续跑」，
互补而非替代。

## 解决什么问题

Pi 本身**有**自动重试：过载、429、5xx、超时、流中断，最多重试 `retry.maxRetries` 次。
除此之外的错误会立刻结束当前运行。这正是中转站把长任务搞死的原因：

- 上游返回 `400`
- 未映射的错误文案，如 `upstream sent an error event`
- Pi 判定为致命的额度措辞

本扩展在 `agent_before_settle`（Pi 中最后一个能强制再发一次模型请求的边界）加了一层兜底。
当运行因可重试错误结束、且用户没有中止时，等待退避后继续该运行。

## 为什么重试不能只是「再发一遍同样的请求」

中转站会把每次尝试派给不同的上游节点。因此原样重放同一份载荷可能**永远失败**：
节点 A 生成的历史项带着 id，节点 B 拒绝解析
（`The requested item was created under a different Azure OpenAI resource`）。

修复会让请求变成任何节点都能接受的形式，但**同时也会让模型丢失跨回合记忆**，
所以它**不是**每次重试都做。

## 历史修复的触发条件

只有当上游**明确报告**本会话的 id 不可用时才修复：

| 触发文案 | 说明 |
|---|---|
| `created under a different Azure OpenAI resource` | 中转站池化场景中实际观测到的失败 |
| `belongs to a different upstream account` | 同类重放拒绝 |
| `previous_response_id` / `item` / `session` … `not found` \| `expired` \| `invalid` | id 已无法解析 |

其他所有失败——普通 400、429、503、流中断——都会以**逐字节相同**的历史重试，
模型保留记忆，prompt 缓存前缀也保持不变。真正执行修复时，只移除完整项的可选 `id`；
消息正文、工具调用配对、`call_id`、`encrypted_content` 和 reasoning 项全部保留。

设 `repairHistory: false` 可完全关闭修复。

## 安装

```bash
pi install git:github.com/ZhiAo1120/pi-resilient-retry
# 开发时直接加载检出目录
pi install /path/to/pi-resilient-retry
```

重启 Pi，或执行 `/reload`。扩展自行加载，无需 `/retry` 命令，也无需逐会话设置。

## 配置

可选。默认不限制重试次数，因为中转站会把每次尝试路由到不同上游，
有限预算可能放弃掉一个本来能成功的节点。状态栏和 Esc 会约束故障期间的代价。

```json
{
  "resilientRetry": {
    "enabled": true,
    "maxRetries": 0,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000,
    "retryQuotaErrors": false,
    "repairHistory": true
  }
}
```

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭扩展而不卸载。 |
| `maxRetries` | `0` | 无成功请求时允许的连续重试次数。`0` = 不限；设为数字可限制单次故障。 |
| `baseDelayMs` | `2000` | 首次退避延迟；每次翻倍。 |
| `maxDelayMs` | `60000` | 延迟上限，所有延迟都会被限制在此值内。 |
| `retryQuotaErrors` | `false` | 也重试额度/计费错误——重试通常修不好这类问题。 |
| `repairHistory` | `true` | 允许移除仅用于重放的历史 id，**仅当**上游报告会话 id 不可用时。 |

`maxRetries` 在任何成功请求后重置，因此它限制的是单次故障，而非整个会话。

## 可见进度

重试**从不静默**。等待期间底部状态栏常驻显示：

```
⏳ 上游报错，重试第 3/20 次 · 等待 12s · Esc 取消
```

若本次重试会剥离历史 id，会额外说明原因：

```
⏳ 上游报错，重试第 2 次 · 等待 4s · 会话 id 已失效，将剥离历史 id · Esc 取消
```

恢复时提示 `上游已恢复（重试 3 次后成功）`，耗尽时给出红色通知加原始错误摘要。
按 Esc、`/stop` 或关闭会话，都会在四分之一秒内取消等待。

## 它不做什么

- **不重放工具调用。** 重试只重复失败的模型请求，绝不重新执行工具。
  已经执行过工具的请求会保留其结果。
- **不覆盖中止。** Esc、`/stop` 和被取消的运行永不被重试。
- **不猜测额度。** 计费和额度错误默认排除，因为重复它们只是浪费时间。
  如果你的中转站把临时额度问题报成额度错误，开启 `retryQuotaErrors`。
- **不做错误文案过滤（用于是否重试）。** 中转站背后有多个上游，
  一个节点的拒绝不代表下一个节点也会拒绝。每次失败都会获得一次尝试。
  错误文案只用于**一件事**：判断会话 id 是否已失效。

## 与 Pi 内置重试的关系

两层同时运行。Pi 的重试先处理它认识的瞬态错误；本扩展接住 Pi 拒绝的那些。
刻意保留 Pi 自身的设置，是为了让 Pi 的额度识别继续工作，本扩展的默认策略依赖它。

## 开发

```bash
npm install
npm test     # 策略单元测试，无需网络
npm run check
```

端到端行为已对假上游验证：在关闭 Pi 自身重试（`retry.maxRetries: 0`）的情况下，
连续三次 `400` 后返回 `200` 能正常恢复；配额错误在 `retryQuotaErrors: false` 时于一次请求后停止；
瞬态 503 重试时历史 id 完整保留（记忆不丢）；跨 resource 拒绝时会剥离 id 后恢复。

## 许可证

MIT。见 [LICENSE](LICENSE)。
