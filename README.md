# dsh-llm-refusal-fix

[![tests](https://github.com/3438278672-ops/dsh-llm-refusal-fix/actions/workflows/test.yml/badge.svg)](https://github.com/3438278672-ops/dsh-llm-refusal-fix/actions/workflows/test.yml)

独立仓库：<https://github.com/3438278672-ops/dsh-llm-refusal-fix>

把 DeepSeek Messages 的**合法终止原因**从「协议错误」里救出来。

装上后，模型因内容安全审查拒答（`stop_reason: "refusal"`）时：

1. 不再被当成协议损坏：refusal 是合法的「本轮没有可回答内容」，适配器报**可重试**的 `EMPTY_RESPONSE`（此前是 `MALFORMED_RESPONSE`，错在把合法终止原因判成解码失败）；
2. agent 用现成的 `EMPTY_RESPONSE` 重试策略自动重试（500ms 起、指数退避，最多 5 次）。拒答本身是抽样行为（实测同一请求 3 次里 1 拒 2 通），通常重试一两次就能拿到正常回答；
3. 适配器**绝不合成回答文本**——不会把「因内容安全审查拒绝回答」当成模型消息写进会话历史（0.1.0 就是这么干的，结果下一轮更容易被拒，见 CHANGELOG）；
4. 重试耗尽才向调用方报错；
5. 只有真正损坏的流（未知 `stop_reason`、坏 JSON、事件类型不符）才继续报 `MALFORMED_RESPONSE`。

顺带修正同一类问题：`pause_turn`、`cancelled` 归为正常结束，
`model_context_window_exceeded` 归为 `max-tokens`（此前全部被判成协议损坏）。

## 提示文案放在哪一层

「因内容安全审查拒绝回答」这句话属于**展示层**，不属于模型层：

- adapter 只负责把终止原因翻译成正确的 Harness 状态，不能替模型说话（否则它会作为
  assistant 消息进入历史，把下一轮也带偏）；
- 重试耗尽后的提示由消费端决定：GUI 直接显示该错误即可；QQ 桥接这类会把
  `error.message` 原样转发给终端用户的程序，可以把 `EMPTY_RESPONSE`
  （message 含 `refused to answer under its content safety review`）翻成一句人话，
  或干脆不往群里贴原始错误文本。

## 装了什么

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 禁用内置 `llm-deepseek-account` 行，插入本 bundle 的 `llm-deepseek-account-fix` 行 |
| `lib/adapter.js` | 随 dsh 发布的 `@deepseek-ai/dsh-llm-deepseek` 能力等价副本；只改「终止原因 → Harness 终止状态」这一层契约 |
| `lib/account.js` | 随 dsh 发布的 account provider 副本；只改适配器从 vendored 副本导入、`providerId` / `settingsNs` 可配置 |
| `index.js` | 插件入口：注册 provider + 自检工具 |

`deepseek-account` 这个 provider 路由名保持不变，所以模型选择、账号登录、模型目录、
既有设置都不用动。

## 安装

本包是 **profile 级 bundle**：装一次，这个 profile 的所有会话都生效（不用改模型、
不用重新登录、不用改任何既有设置）。四种 spec 都能装：

```
# git（独立仓库，最省事）
plugin_manager install_bundle github:3438278672-ops/dsh-llm-refusal-fix

# npm（发布后最省事）
plugin_manager install_bundle dsh-llm-refusal-fix

# tarball（从 Releases 页下载后）
plugin_manager install_bundle D:\path\dsh-llm-refusal-fix-0.2.0.tgz

# 本地目录（开发时）
plugin_manager install_bundle D:\path\dsh-llm-refusal-fix
```

发布包与校验信息见 <https://github.com/3438278672-ops/dsh-llm-refusal-fix/releases> 。

装完立即生效（无需重启 DSH）。装好后环境里会多一个工具：

```
llm_refusal_fix_selftest
```

调用它会输出 9 条 fixture 的 PASS/FAIL 汇总。全部 PASS 说明补丁已生效；如果整包加载
失败，插件管理里会看到哪一行出错。

### 验证补丁真的接管了路由

- 插件管理里本包状态应为「已启用」；
- `cordis_inspect_query`（Config）里内置 `@deepseek-ai/dsh-llm-deepseek-account`
  行应为 `inactive`，本包 `dsh-llm-refusal-fix` 行为 `schema`（活跃）；
- 正常对话照常可用，说明模型调用已经走修补后的 adapter。

### 回滚

禁用或移除本 bundle 即可：patch 行失效 → 内置 provider 行自动恢复，一切回到原样。

## 可调项

bundle 行 config（默认值即推荐值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `providerId` | `deepseek-account` | provider 路由名（接管内置行时必须保持这个值） |
| `settingsNs` | `llm-deepseek-account` | 设置命名空间（保持原值才能沿用既有账号/模型设置） |

## 测试

```bash
npm test        # 9 个离线 fixture，末行输出 9/9 cases passed
```

- 离线 fixture 见 `tests/fixtures.mjs`（终止原因 → Harness 终止状态的全部契约，含
  「未知值仍报 MALFORMED_RESPONSE」的反向用例）；
- 依赖装进 `tests/.work/` 临时目录，**不在插件根目录留 node_modules**（会遮蔽 dsh 自带
  副本，错误码 identity 会变）；
- 装好后还可以在任意会话里跑 `llm_refusal_fix_selftest`（9 条 fixture 的真机冒烟）；
- 完整的测试环境、真机接管核验与上游原始 SSE 证据见 [TESTING.md](TESTING.md)。

## 版本兼容

本包 vendor 的是 dsh **0.2.2 线**（开发时验证于 0.2.2-rc.3 Win x64 桌面版）的
adapter / account provider 实现。它依赖 dsh 自带的 `@deepseek-ai/*` 包（bundle 不需要
声明这些依赖），所以：

- 同一条 0.2.2.x 线上，任何 rc 版本都能用；
- 大版本变化（例如 `stopReason` 已在上游修掉、或 `LlmAdapter` 契约改了）时请先确认
  上游是否已修复：**上游一旦修好，本包就可以卸载**——本包存在的意义就是在上游修好
  之前把契约补上；
- 卸载：禁用/移除本 bundle 即恢复内置 provider（patch 行随之失效）。

## 背景

- 上游讨论：#11337 / #13611（deepseek-ai/deepseek-harness Discussions）。
- 0.2.2-rc.4 把错误码改成了 `CONTENT_REFUSED`（诊断变好），但 `CONTINUABLE_FAILURES`
  仍然没有它，回合依旧无法继续；本包把它归位成可重试的 `EMPTY_RESPONSE`，
  复用 agent loop 现有的重试策略。

## License

MIT
