# Changelog

## 0.1.0 — 2026-11-18

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
