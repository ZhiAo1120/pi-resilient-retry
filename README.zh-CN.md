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
| 重试次数 | 不限，但有同一错误保护 | 最多 3 次，超出即拦下并提示原因 |
| 历史修复 | 仅在上游明确报告 ID 失效时剥 id | `/retry` 剥 id，`--deep` 连 reasoning 一起剥 |

两者生命周期钩子互不冲突，可同时安装。一个负责「不让任务中断」，一个负责「你想介入时精准续跑」。

## 解决什么问题

Pi 本身**有**自动重试：过载、429、5xx、超时、流中断，最多重试 `retry.maxRetries` 次。
除此之外的错误会立刻结束当前运行。这正是中转站把长任务搞死的原因：上游返回 `400`、
未映射的文案如 `upstream sent an error event`、或中转站特有的拒绝。

本扩展在 `agent_before_settle`（Pi 中最后一个能强制再发一次模型请求的边界）加了一层兜底。
当运行因可重试错误结束、且用户没有中止时，等待退避后继续该运行。

## 安装

```bash
pi install git:github.com/ZhiAo1120/pi-resilient-retry
# 开发时直接加载检出目录
pi install /path/to/pi-resilient-retry
```

重启 Pi，或执行 `/reload`。扩展自行加载，无需逐会话设置。

## 配置

全部可选。

```json
{
  "resilientRetry": {
    "enabled": true,
    "maxRetries": 0,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000,
    "repeatLimit": 30,
    "visibleRetry": false,
    "retryQuotaErrors": false,
    "repairHistory": true
  }
}
```

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭扩展而不卸载。 |
| `maxRetries` | `0` | 无成功请求时允许的连续重试次数。`0` = 不限。 |
| `baseDelayMs` | `2000` | 首次退避延迟；每次翻倍。 |
| `maxDelayMs` | `60000` | 延迟上限，所有延迟都限制在此值内。 |
| `repeatLimit` | `30` | 同一个**未变化**错误允许的尝试次数。`0` 关闭该保护。 |
| `visibleRetry` | `false` | 每次重试加一条 `custom_message` 标记，发出前会被剥离。 |
| `noticeEvery` | `1` | 每 N 次尝试打印一次；每轮的第 1 次始终打印。 |
| `retryQuotaErrors` | `false` | 也重试额度/计费错误。 |
| `repairHistory` | `true` | 允许移除仅用于重放的历史 id，仅当上游报告 id 失效时。 |

`maxRetries` 和 `repeatLimit` 在任何一次成功请求后重置，因此限制的是单次故障，而非整个会话。

## 重试是怎么发生的

重试是**系统**重新调用模型，不是你发言。扩展在边界返回一个续跑指令，把失败的助手回合从上下文
丢弃后重发请求。全程不会代替你发送任何消息：

```
会话：user "hi" → assistant（报错）→ [context omit] → assistant（报错）→ [context omit] → assistant "回答"
请求：载荷 5787B，始终只有一条用户消息，每次完全相同
```

失败的尝试用 `context_edit` 删除，因此模型收到的仍是原始请求：不增长、不丢记忆、缓存前缀稳定。

### 可选标记

`visibleRetry: true` 会为每次重试加一条 `custom_message` 标记（可用 `noticeEvery` 降低频率）。
该标记在发出前会被剥离，模型永远看不到。默认关闭，因为 Pi 会话只追加——每条标记都会永久留在
会话文件里——而 Percho 也不渲染 custom message。

## 为什么重试不能只是「再发一遍同样的请求」

中转站会把每次尝试派给不同的上游节点。因此原样重放同一份载荷可能**永远失败**：
节点 A 生成的历史项带着 id，节点 B 拒绝解析
（`The requested item was created under a different Azure OpenAI resource`）。

只有当上游**明确报告**本会话的 id 不可用时才修复：

| 触发文案 | 说明 |
|---|---|
| `created under a different Azure OpenAI resource` | 中转站池化场景中实际观测到的失败 |
| `belongs to a different upstream account` | 同类重放拒绝 |
| `previous_response_id` / `item` / `session` … `not found` \| `expired` \| `invalid` | id 已无法解析 |

其他所有失败都会以**逐字节相同**的历史重试，模型保留记忆，prompt 缓存前缀也保持不变。
真正执行修复时，只移除完整项的可选 `id`；消息正文、工具调用配对、`call_id`、
`encrypted_content` 和 reasoning 项全部保留。修复只对一次请求生效。

设 `repairHistory: false` 可改为原样重发。

## 如何确认重试真的发生了

Percho 不渲染 Pi 的任何扩展 UI 通道（`notify`、`setStatus`、`custom_message`），
所以对话是唯一能让重试可见的地方。每次重试都会显示：

```
↻ pi-resilient-retry：上游请求失败，自动重试中（第 1 次）。
```

在终端里的 Pi 会话还会在底部显示实时进度
（`⏳ 上游报错，重试第 3/30 次 · 等待 12s · Esc 取消`）。按 Esc、`/stop` 或关闭会话，
都会在四分之一秒内取消等待。

## 阻止无解的循环

无限重试只有在**错误一直在变**时才安全。当同一个错误反复出现、中间没有任何一次成功请求时，
重复它不会有任何作用，扩展会停止并说明原因。

每次错误都不同（中转站轮换节点）时会一直重试；同一个错误连续三十一次则不会。

## 排查「没有重试」的原因

设一个调试日志把每次决策记录下来：

```json
{ "resilientRetry": { "debugLog": "/tmp/resilient-retry.log" } }
```

每个 settle 边界会追加一行 JSON，包含 outcome、助手消息的 `stopReason`、错误开头、
运行是否被中止，以及最终决策：

```json
{"event":"session_start","enabled":true,"config":{...}}
{"event":"agent_before_settle","outcome":"error","stopReason":"error",
 "error":"503: {\"message\":\"Upstream service unavailable\"}","aborted":false,
 "hasUI":false,"decision":"retry","attempt":1,"delayMs":2000,"repair":false}
{"event":"agent_before_settle","outcome":"error","stopReason":"error",...,
 "decision":"skip: run aborted"}
```

**完全没有 `session_start` 行，说明扩展根本没被加载。** 排查完记得删掉 `debugLog`。

## 它不做什么

- **不重放工具调用。** 重试只重复失败的模型请求，绝不重新执行工具。
- **不覆盖中止。** Esc、`/stop` 和被取消的运行永不被重试。
- **不做错误文案过滤（用于是否重试）。** 中转站背后有多个上游，
  一个节点的拒绝不代表下一个节点也会拒绝。每次失败都会获得一次尝试；
  文案只用于一件事：判断会话 id 是否已失效。

## 与 Pi 内置重试的关系

两层同时运行。Pi 的重试先处理它认识的瞬态错误；本扩展接住 Pi 拒绝的那些。
刻意保留 Pi 自身的设置，是为了让 Pi 的额度识别继续工作，本扩展的默认策略依赖它。

## 开发

```bash
npm install
npm test     # 策略单元测试，无需网络
npm run check
```

端到端已验证（假上游）：连续 `400` 能重试恢复；配额错误在 `retryQuotaErrors: false` 时
一次请求后停止；瞬态 503 重试时历史 id 完整保留；跨 resource 拒绝在剥离 id 后恢复；
同一错误达到 `repeatLimit` 后停止；静默重试时请求载荷保持恒定。

## 许可证

MIT
