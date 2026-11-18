# 测试记录

本插件的验证分三层：**离线 fixture**（`npm test`，任何人可复现）、**真机自检**（装好后的工具）、**真机接管核验**（Config 状态 + 实际对话）。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | Windows 11 x64 |
| DSH | Desktop 0.2.2-rc.3（win-x64） |
| 被测适配器 | 随 DSH 发布的 `@deepseek-ai/dsh-llm-deepseek` 0.2.2-rc.3（vendor 副本） |
| 模型 / 推理档 | `deepseek-flash`，`reasoningEffort: max` |
| Node（本地跑测试） | v24.14.0；CI 用 22.x |

## 一、离线 fixture：9 个用例

```bash
npm test
```

`tests/run.mjs` 会把 `lib/adapter.js` 和它依赖的 shipped 包（`@deepseek-ai/*`、`eventsource-parser`、`semver`）装进临时目录 `tests/.work/`，再从那里导入适配器跑 fixture——**不往插件根目录装 node_modules**，避免遮蔽 DSH 自带的同名包（`LlmError` 的 identity 是 instance 级别的，跨副本会让错误码降级成 `UNKNOWN`）。

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| `refusal-with-no-content-is-retryable-empty-response` | 空内容 + `stop_reason: refusal` | `EMPTY_RESPONSE`（可重试）+ 0 个 text block（真实故障形态） |
| `refusal-stop-details-are-carried-in-the-error` | `stop_details.explanation` | 仍是 `EMPTY_RESPONSE`，错误 message 带 explanation 供排障 |
| `refusal-after-thinking-never-synthesizes-text` | 先 thinking 再 refusal | `EMPTY_RESPONSE`，且**不产生任何 text block**（不污染会话） |
| `pause-turn-is-terminal-not-malformed` | `pause_turn` | `{kind:'stop'}`，不报错 |
| `context-window-exceeded-maps-to-max-tokens` | `model_context_window_exceeded` | `{kind:'max-tokens'}` |
| `cancelled-is-terminal-not-malformed` | `cancelled` | `{kind:'stop'}` |
| `unknown-stop-reason-still-malformed` | `banana` | 仍 `MALFORMED_RESPONSE`（不放宽真损坏） |
| `plain-end-turn-unchanged` | `end_turn` | 与上游行为一致 |
| `tool-use-still-tool-calls` | `tool_use` + input_json_delta | `{kind:'tool-calls'}` |

**结果（2026-11-18）**：`9/9 cases passed`。

## 二、真机自检：`llm_refusal_fix_selftest`

装好 bundle 后在任意会话里调用该工具，输出 9 条 fixture 的摘要（与离线用例同一批契约，作为「这个进程里补丁真的在跑」的冒烟测试）：

**结果（2026-11-18，0.2.0 装机后）**：`9/9 PASS`（0.1.0 时期是 7/7）。

## 三、真机接管核验

| 检查 | 期望 | 实测 |
| --- | --- | --- |
| 插件管理 | 本 bundle 已启用（applied） | ✅ |
| Config：内置行 `@deepseek-ai/dsh-llm-deepseek-account` | `inactive` | ✅ |
| Config：本包行 `dsh-llm-refusal-fix` | `schema`（活跃） | ✅ |
| 正常对话（本会话自身） | 走修补后的 provider 正常返回 | ✅ |

## 四、原始故障证据（修复前）

2026-11-17 用本地抓包代理重放了失败回合的持久化 system prompt + user message，上游返回的合法 SSE delta：

```json
{"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null},"usage":{"input_tokens":14631,"output_tokens":22,"output_tokens_details":{"thinking_tokens":22}}}
```

同一 payload 3 次重放：1 拒 2 通；生产环境同一个 QQ 会话两次唤醒共 12 次尝试全部拒答。→ 上游是**采样式安全判定**，客户端把合法终止原因当协议损坏，才是 bug。

相关讨论：

- https://github.com/deepseek-ai/deepseek-harness/discussions/11337
- https://github.com/deepseek-ai/deepseek-harness/discussions/13611

## 五、0.1.0 的实测教训（0.2.0 的依据）

- 0.1.0 把 refusal 映射成 `{kind:'stop'}` 并合成一条说明文本。实测在交互会话里：回合被视为正常结束 → **不重试**；说明文本作为 assistant 消息进入历史 → 下一轮更容易继续被拒。连续几轮后用户看到的就是「（本次请求因内容安全审查拒绝回答。）」反复出现。
- 关掉插件后恢复正常：内置适配器把 refusal 判成 `MALFORMED_RESPONSE`（该码在可重试列表），agent 自动重试 5 次，通常某次就成功。
- 结论：refusal 必须保持「可重试」，且适配器不能合成任何回答文本（0.2.0 已按此实现）。

## 六、端到端与真机上游实测（0.2.0，2026-11-18）

### 6.1 mock 端点驱动真实适配器：6/6

`npm run test:e2e`（`tests/e2e.mjs`）：本地 `http.createServer` 扮演 Messages 端点，通过真实 HTTP 驱动**未改动的修补版 `DeepSeekAdapter` 类**（不是只喂 fixture）：第 1 次回 refusal SSE，第 2 次回正常 SSE。

| 断言 | 结果 |
| --- | --- |
| 第 1 次调用抛 `EMPTY_RESPONSE` | ✅ |
| 错误说明含 `refused to answer under its content safety review` | ✅ |
| 第 1 次调用不产生任何 text-delta | ✅ |
| 第 2 次（重试）正常结束，`finish.kind = 'stop'` | ✅ |
| 第 2 次拿到上游正文 `ok` | ✅ |

### 6.2 真实抓包重放：4/4

`node tests/e2e-replay.mjs`：把 2026-11-17 抓到的真实拒答流（原样 SSE，`stop_reason: refusal`，28 个事件）解析后喂给修补后 `translate()`：

| 断言 | 结果 |
| --- | --- |
| 真实拒答 → 可重试 `EMPTY_RESPONSE` | ✅ |
| 错误 message 指明安全审查 | ✅ |
| 不合成任何 assistant 文本 | ✅ |
| 拒答不产生 finish chunk | ✅ |

### 6.3 真实上游（`api.deepseek.com`）：逐次结果

用本机账号 token 直连真实 Messages 端点（`D:\TAP\_live02.mjs`，token 只读不打印）：

| 场景 | 结果 |
| --- | --- |
| 普通请求（"Reply with the single word: OK"） | `finish=stop`，拿到正文，无合成文本 |
| 拒答易发 payload（0.1.0 时期 12 连拒的同一段 wake prompt）第 1 次 | `stop` |
| 第 2 次 | `EMPTY_RESPONSE`（安全审查说明） |
| 第 3 次 | `EMPTY_RESPONSE` |
| 第 4 次 | `stop` |

→ 真实上游的采样式拒答被正确标成**可重试**，重试后拿到正常回答；这正是 agent 循环需要的语义（`EMPTY_RESPONSE` 在重试列表里）。

## 七、未覆盖 / 待观察

- agent 循环自然重试整条链路还没在线上自然撞到（拒答是采样的）。预期：重试成功则用户无感；5 次重试全拒才向调用方报 `EMPTY_RESPONSE`。
- 重试耗尽时 QQ 桥会把错误原文贴进群（`bridge.js:12239-12245` 的行为）；桥接侧是否把 `EMPTY_RESPONSE`/`refused to answer under its content safety review` 翻成人话或静默，仍是待定项。
- 上游 0.2.2-rc.4 把错误码改成 `CONTENT_REFUSED`，但仍未修可恢复性；上游修好 `CONTINUABLE_FAILURES`/终止原因映射之后，本包即可卸载。
