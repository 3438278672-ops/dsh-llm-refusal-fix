# Changelog

## 0.2.0 — 2026-11-18

**修正 0.1.0 的语义错误：拒答不能作为「正常结束 + 合成说明」。**

- `refusal` → 可重试的 `EMPTY_RESPONSE`（不再是 `{kind:"stop"}`）：refusal 是合法的
  「本轮没有可回答内容」，不是协议损坏；agent loop 现成的 `EMPTY_RESPONSE` 重试策略会
  自动重试（500ms 起、指数退避，最多 5 次）。拒答是抽样行为，重试通常能拿到正常回答。
- **删除合成说明文本**：0.1.0 会把「因内容安全审查拒绝回答」作为一条 text block 交给
  agent，后果是——①回合被视为正常结束，不再重试；②这句话作为 assistant 消息进入会话
  历史，下一轮更容易继续被拒。实测在交互会话里越聊越糟，关掉插件反而恢复正常。
- 移除 `refusalNotice` 配置项（提示文案不属于模型层；见 README「提示文案放在哪一层」）。
- fixture 同步更新：refusal 三个形态（无内容 / 带 stop_details / 跟在 thinking 后）都断言
  `EMPTY_RESPONSE` 且**不产生任何 text block**；其余用例不变。
- 不变量：适配器只负责「终止原因 → Harness 终止状态」的映射，绝不替模型生成内容。

## 0.1.0 — 2026-11-18

> ⚠️ 已废弃：`refusal → 正常结束 + 合成说明` 的语义在交互场景有反作用，请使用 0.2.0。

- 新增：把 DeepSeek Messages 的**合法终止原因**从 `MALFORMED_RESPONSE` 里救回来。
  `stop_reason: "refusal"`（模型内容安全拒答）此前会被 Messages 适配器判成协议损坏，
  整个 agent 回合直接以 error 结束；QQ 桥随后把 `DeepSeek Messages stream: unsupported
  stop reason refusal` 原样贴进群。
- 修法是补契约而不是特判：`refusal` → 正常结束 + 一条可读说明文本块（同时避免
  `EMPTY_RESPONSE`）；`pause_turn` / `cancelled` → 正常结束；
  `model_context_window_exceeded` → `max-tokens`；未知值仍然报 `MALFORMED_RESPONSE`。
- 实现：vendor 修补版 Messages adapter（`lib/adapter.js`）+ 同名 provider 路由
  `deepseek-account` 接管（`lib/account.js`），设置命名空间保持
  `llm-deepseek-account`，既有账号/模型/设置都不用动。
- 测试：9 个离线 fixture（`npm test`，CI 跑同一套）+ 装好后的
  `llm_refusal_fix_selftest` 真机冒烟。
- 背景：#11337 / #13611（`deepseek-ai/deepseek-harness` Discussions）。上游 0.2.2-rc.4
  只把错误码改成 `CONTENT_REFUSED`，可恢复性未修；上游修好后本包即可卸载。
