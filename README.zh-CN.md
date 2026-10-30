# pi-resilient-retry

**先让 Pi 执行原生恢复；仍失败时，插件才继续同一任务。**

这是与模型协议无关的 **AgentSession 兜底流程**，不是新增「带重试的模型入口」。
在 Pi、Percho 中继续选择现有模型即可；协议、鉴权和流处理仍由原 SDK 承担。
使用 `@earendil-works/pi-coding-agent` 1.4 系列的公开扩展 API。

[English](README.md) | 中文

## 推荐搭配安装

本扩展解决「任务不被打断」。如果你还想在自动重试之外**手动精准续跑**，
请同时安装 [pi-retry](https://github.com/ZhiAo1120/pi-retry)：

| | pi-resilient-retry（本扩展） | pi-retry |
|---|---|---|
| 触发方式 | 自动，失败即重试 | 手动敲 `/retry` |
| 定位 | 后台重试，任务不中断 | 精准续跑，不重放已完成操作 |
| 重试次数 | 插件续跑次数默认不限，有重复错误保护 | 以该扩展的手动重试策略为准 |
| 历史修复 | 仅在上游明确报告 ID 失效时剥 id | `/retry` 剥 id，`--deep` 连 reasoning 一起剥 |

两者触发方式不同。使用手动 `/retry` 前先停止自动恢复；本轮没有重新验证搭配安装的行为。

## 解决什么问题

Pi 本身**有**自动重试：过载、429、5xx、超时、流中断，最多重试 `retry.maxRetries` 次。
除此之外的错误会立刻结束当前运行。这正是中转站把长任务搞死的原因：上游返回 `400`、
未映射的文案如 `upstream sent an error event`、或中转站特有的拒绝。

本扩展在 `agent_before_settle`（Pi 中最后一个能强制再发一次模型请求的边界）加了一层兜底。
当运行因可重试错误结束、且用户没有中止时，先启动原生续跑，再在请求发出前等待退避。

## 安装

```bash
pi install git:github.com/ZhiAo1120/pi-resilient-retry
# 开发时直接加载检出目录
pi install /path/to/pi-resilient-retry
```

重启 Pi，或在空闲时执行 `/reload`。无需逐模型配置，也不需要新 provider / 鉴权入口，
**前提是宿主会向这个会话加载本扩展**。Percho 内置子会话的限制见下文。

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
    "retryQuotaErrors": false,
    "repairHistory": true
  }
}
```

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭扩展而不卸载。 |
| `maxRetries` | `0` | 无成功请求时允许的连续**插件续跑**次数。`0` = 不限，不是总 HTTP 请求上限。 |
| `baseDelayMs` | `2000` | 首次退避延迟；每次翻倍。 |
| `maxDelayMs` | `60000` | 延迟上限，所有延迟都限制在此值内。 |
| `repeatLimit` | `30` | 连续相同的终态错误；比较完整错误文本（规范化空白）。`0` 关闭该保护。 |
| `retryQuotaErrors` | `false` | 也重试额度/计费错误。 |
| `repairHistory` | `true` | 允许移除仅用于重放的历史 id，仅当上游报告 id 失效时。 |
| `debugLog` | 未设 | 可选 JSONL 决策元数据文件；不记录原始错误、提示、载荷、鉴权或 headers。 |

预算在成功、被中止的结算、会话初始化后重置，限制连续终态故障，而非整个会话。
数值接受非负有限值；无效数值使用默认值。小数延迟保留（实际精度受定时器限制）。
旧的 `visibleRetry`、`noticeEvery` 配置不再生效，可删除；即使保留为 `true` 也不会新增消息标记。

## 重试是怎么发生的

重试是**系统**重新调用模型，不是你发言。扩展在边界返回一个续跑指令，把失败的助手回合从上下文
丢弃后重发请求。全程不会代替你发送任何消息：

```
会话：user "hi" → assistant（报错）→ [context omit] → assistant（报错）→ [context omit] → assistant "回答"
请求：始终是原始消息和历史；普通重试的载荷保持相同
```

失败的尝试用 `context_edit` 从**后续模型上下文**中排除，因此普通重试不增加提示、不丢历史记忆。
原始错误记录和 `context_edit` 仍保留在只追加的会话文件中，并非删除原始记录或让文件完全不增长。
前序扩展提出的边界编辑保持不变，插件只追加自己针对失败请求的编辑。

### 不再通过消息显示重试

不注入 user、assistant 或 `custom_message`，不要求模型输出「正在重试」。旧版本生成的
`customType: "resilient-retry"` 消息只在构造模型输入时按身份排除，不改写会话文件。
正常用户消息、助手回答、工具结果即使提到 `pi-resilient-retry` 也完整保留。
早期版本写成真实用户发言的提示不会按文本猜测并自动删除。

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

其他失败时，插件**不修改普通请求载荷或历史**。本地测试验证了普通请求逐字节相同；
SDK 路由和其他扩展仍拥有各自的转换行为。
真正执行修复时，只移除完整项的可选 `id`；消息正文、工具调用配对、`call_id`、
`encrypted_content` 和 reasoning 项全部保留。修复只对一次请求生效。

设 `repairHistory: false` 可关闭这些修复。修复不会改 wire model ID、历史消息的
`provider` / `api`、call ID、thinking signature 或原始会话记录。
不会清除 transport 的 `previous_response_id`、引用型项或加密 reasoning；缺少安全重建它们的信息。
错误提到这些 ID 不代表一定能修复；本地假上游接受省略 ID，也不等于所有真实服务接受该 schema。

## 如何看到重试正在进行

复用 Pi / Percho **原生的智能体执行中效果**，不依赖 Percho 不消费的扩展 UI 通道：

```
失败 → agent_end → agent_before_settle（立即决定续跑）
     → agent_start → turn_start → context（等待退避）→ 请求上游
```

- **原生活动**：真实 `agent_start`、`turn_start` 在退避前发出，宿主可以使用原有执行状态。
  插件不伪造事件、错误卡或结果 pane。
- **终端 Pi**：宿主实现 `setWorkingMessage` 时，工作文字从「等待重试（第 N 次）」切为「正在重试（第 N 次）」。
- **取消 / 结束**：用宿主 Stop 或关闭会话。AbortSignal 监听器立即唤醒退避；定时器和监听器均清理，
  大延迟也不会溢出。成功、中止、达到限制后清除本扩展的工作文字。
  直接 dispose 时，通过真实 abort 信号在 SDK 使上下文失效前清除 UI；终态回调不访问已关闭上下文。
  每个低层 `agent_end` 都交还插件工作文字，再由使用独立控制器的 SDK 原生退避接管。
  后期结算只使用事件数据和缓存的 run 元数据，不读可能失效的 context getter。
- **验收边界**：已验证 SDK / RPC 活动和取消；没有观察交互式 TUI、完整 Percho 桌面动效或 pane 视觉。

退避不能放在 `agent_before_settle` 内：此时低层 `agent_end` 已发出，宿主已经关闭执行动效。
也不能阻塞原生开始事件的处理器：Pi 要等扩展处理器返回后才把该事件通知 UI。
因此等待放在两个开始事件之后的 `context` 钩子里；等待本身不修改任何消息。

每次低层运行结束与续跑开始之间仍有正常的生命周期切换，可能短暂复位或留下宿主原生错误卡。
扩展不伪造生命周期事件，也不修改 Percho 来隐藏这些记录。精确次数和失败原因可查下述调试日志。

## 阻止无解的循环

重复错误保护用于阻止同一错误的无效循环，不证明变化中的错误就安全或低成本。
需要限制插件预算时，请设置有限 `maxRetries`。比较使用完整错误文本的空白规范化摘要，
不再因长错误的前 200 字符相同而误触发保护。

每次错误都不同（中转站轮换节点）时会一直重试；同一个错误连续三十一次则不会。

## 排查「没有重试」的原因

设一个调试日志把每次决策记录下来：

```json
{ "resilientRetry": { "debugLog": "/tmp/resilient-retry.log" } }
```

只记录白名单事件 / 决策标签、次数、标志与 SHA-256 `errorFingerprint`。
不写原始上游错误、请求 / 响应正文、凭证、headers、日志路径。新文件权限为 `0600`，
不改变已有文件权限。SDK / 宿主自身的日志和原始会话记录是独立的。

```json
{"event":"agent_before_settle","outcome":"error","stopReason":"error","aborted":false,"decision":"retry","attempt":1,"delayMs":2000,"repair":false}
{"event":"agent_before_settle","outcome":"error","stopReason":"error","decision":"skip: policy declined"}
```

正常启动会记录 `session_start`。若缺失，请同时检查扩展加载及**正确配置作用域内可写的日志路径**；
日志写入失败会被忽略，不会破坏运行，不能仅凭无日志断言未加载。排查后移除 `debugLog`。

## 它不做什么

- **插件不重放任务 / 工具。** 已完成工具及结果保留；模型新选择的工具调用仍交给 Pi。
  失败的部分文字可能被重新生成，但真实失败响应仍保留在原始记录里。
- **不覆盖中止。** 取消的运行不再重试；即使最后消息被适配器标成 `error`，
  公共结算事件的 aborted 标志也会重置预算。
- **明确策略。** 配额 / 计费错误默认排除；其他终态错误受重复 / 有限预算保护。
  文案还用于判断是否允许 ID 修复。
- **不是全局拦截器。** 未加载扩展的直接 provider 调用、工具 HTTP、图片生成 API 不自动覆盖。

## 与 Pi 内置重试的关系

顺序固定为：**请求 → Pi 原生恢复 → 耗尽 / 不适用 → 插件续跑**。
插件不改 `retry` / `retry.provider`，不覆盖 provider，也不新增请求内部的 stream / client 重试层。
每次续跑仍会走 Pi 原有策略。

所以 `resilientRetry.maxRetries` 不是总上游请求上限：原生重试 1 次、插件续跑 1 次，
连续失败时也可能产生 4 个 HTTP 请求。`retry.maxRetries: 0` 是关闭 Pi 原生重试，
`resilientRetry.maxRetries: 0` 却是插件续跑不限；请区分这两个预算。

## Percho 与 SDK 的限制

本轮验证的是 Pi CLI / SDK **1.4.0** 与 Percho **0.6.6**；后者内置 SDK 实际导出
`VERSION 1.4.0`。环境中的 `PI_PACKAGE_DIR` 覆盖会影响 package / assets 的版本显示，
不能只按包名或旧研究材料断言运行版本。

Percho 内置子代理使用 `noExtensions: true`，只注入权限 factory，共享的是 ModelRuntime，
**不是扩展生命周期**。provider 回调发生在原生重试决策之前，公开选项没有子会话耗尽标志或
稳定逻辑请求 ID。因此**没有发布透明的 native-first 子代理包装模式**：它只能猜、提前重试，
或者依赖禁止的宿主私有改动。

当前 SDK 已能支持：子会话明确加载本 factory 后，现有公开 `agent_before_settle` 就足够实现
native-first。缺的是 Percho 的子会话加载接线，不是 SDK 重试算法。最小接入是保留
`noExtensions: true` 和权限 gate，白名单加载本 factory。Pi CLI 型子代理若其子进程确实加载
扩展，也可以支持；不能仅凭父会话加载就认定子会话已加载。不使用 `subagent_extension:result` 桥接、
不伪造 `taskId`，不加 UI 插件，也不修改安装包。

## 开发

```bash
npm install
npm test     # 策略单测 + 真实 SDK / 本地 HTTP 生命周期测试，无需外网
npm run check
```

`index.ts` 只做生命周期接入；`retry-core.ts` 集中策略、预算、等待、修复和元数据日志。
没有新增 SDK / HTTP client 运行依赖；包只有一个明确扩展入口，并包含核心文件。

测试覆盖 SDK/client 与原生耗尽**先于**插件、原生成功 / Stop 不接管、配额 opt-in、有限 / 无限预算、
不重放已完成工具、旧标记身份过滤、完整错误指纹、定时器溢出 / 监听清理与安全日志。
真实 SDK + Responses / Anthropic 本地 HTTP fixture 验证图片、thinking / text 签名、工具配对、
hook 返回的替代载荷、headers、usage、不可变 ID 修复与真正的截断流。
这些是 SDK / loopback 观测，**不是对真实供应商或 OAuth 的验收**。

也可直接用 macOS 上 Percho 内置的 SDK 运行同一组生命周期测试（不启动桌面窗口，不修改安装）：

```bash
(
  ROOT=$(mktemp -d)
  trap 'rm -rf "$ROOT"' EXIT
  mkdir -p "$ROOT/agent"
  env -i PATH="$PATH" HOME="$ROOT" PI_CODING_AGENT_DIR="$ROOT/agent" PI_OFFLINE=1 \
    ELECTRON_RUN_AS_NODE=1 \
    PI_RETRY_TEST_SDK=/Applications/Percho.app/Contents/Resources/app.asar/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
    /Applications/Percho.app/Contents/MacOS/Percho --experimental-strip-types --test test/*.test.mjs
)
```

工作区打包验证脚本 / 报告位于
`.local/agent-work/pi-resilient-retry-optimization/package-proof/`（不进入 npm 包）。
使用真实 CLI RPC 入口及两个 SDK 的普通 package / JITI loader，配置 / HOME / 会话均临时隔离，
只用假 key 和 loopback。冷加载、空闲重载、禁用 / 重启用、并行会话隔离、父会话关闭、
未注入 factory 的对照组及 Stop，与完整宿主 / 桌面验收分开报告。
没有改变真实凭证 / 配置；真实上游 OAuth、WebSocket 和 Percho 子代理原生 UI 仍未验证。

## 许可证

MIT
