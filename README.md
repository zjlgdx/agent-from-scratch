# agent-from-scratch

《从零手写 Agent》— 一个重度 AI 用户的补课笔记。

我用 AI 写过近十万行代码、跑过上千个 agent session,却在被问到"什么是 tool call、什么是 ReAct"时一个都答不上来。这个仓库是补课现场:每一课亲手把 agent 的内核写一遍,配一篇笔记,边学边发。

## 形式

- 每课一个目录:可运行的代码 + 当课笔记
- 根目录 `questions.md` 是错题本,跨课维护,EP4 从里面取题
- 笔记同步发在 [灯下 Lamplight](https://blog.aixie.de/notes)
- 代码刻意保持小:能 150 行讲清楚的,不写 1500 行

## 模型与提供商

本系列只依赖 OpenAI 兼容的 `/chat/completions` 协议,不绑任何模型或提供商。代码里只有三个环境变量:`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`,默认 Groq 免费档;EP2 走 pi 的模型注册表,用 `LLM_PROVIDER` + `LLM_MODEL`。各家配置见 [.env.example](.env.example)。

免费提供商在 2026-09 的状态(会变,以各家文档为准):

| 提供商 | 免费额度 | 本系列能用的模型 |
|---|---|---|
| Groq | 每分钟 8k 上下 tokens(按模型),不绑卡 | `openai/gpt-oss-120b`(默认) |
| Cerebras | 5 次/分钟,100 万 tokens/天 | `gpt-oss-120b` |
| Cloudflare Workers AI | 1 万 neurons/天(约 30 万输入 tokens) | `@cf/openai/gpt-oss-120b`、`@cf/meta/llama-3.3-70b-instruct-fp8-fast`;EP0/EP1/EP3 实测可用,EP2 暂不行(pi 0.80.10 的 provider 第二轮回填工具结果时 400) |
| NVIDIA build.nvidia.com | 注册送 1000 次,40 次/分钟,不绑卡 | `openai/gpt-oss-120b`、`meta/llama-3.3-70b-instruct` |
| OpenRouter | 20 次/分钟,50 次/天(充 10 美元后 1000 次/天) | 21 个 `:free` 模型,没有 gpt-oss |

笔记里的每段实验轨迹都标注了模型和日期。EP0、EP1 的原始实验跑在 `llama-3.3-70b-versatile` 上,Groq 已于 2026-09 下线它,Cloudflare 和 NVIDIA 还有。同一个实验换模型结果会漂移:机制(tool call 是文本、消息配对、stop 夺回控制权、沙箱归宿主)不随模型变,现象(编工具名、编 Observation、滥用工具)随模型变,漂移本身也是教材。

## 目录

| 课 | 主题 | 状态 |
|---|---|---|
| EP0 | 136 行裸循环:tool call 到底是什么 | 已完成 |
| EP1 | 手工 ReAct:2022 年的人怎么让模型干活 | 已完成 |
| EP2 | issue loop MVP:让 agent 自己跑完一个任务队列(pi.dev) | 已完成 |
| EP3 | 对照生产实现:从一个真实 harness 的源码里学到什么 | 已完成 |
| EP4 | 十个我曾经答不上来的问题 | 已完成 |

只认真规划下一课,大纲不提前膨胀;EP4 之后有没有 EP5,由真实反馈和新摩擦决定。

## 自律条款

写在最前面,防止它变成又一个大而全的失败项目:

1. 每课代码一个晚上到一个周末封顶,超了砍范围,不延时间;
2. 不写规格文档,先跑通再写笔记;
3. 只有文件和终端:不建 daemon、web UI、平台;
4. 发布前必须自己完整跑通;
5. 笔记正文自己写,AI 只负责教学、结对和审稿。

## 延伸阅读

写每一课之前先自己动手;卡住或写完之后,再对照这些权威材料(链接均已验证可用):

**EP0 之前/之后**
- [Thorsten Ball — How to Build an Agent](https://ampcode.com/how-to-build-an-agent) — 最有名的"几百行代码写 agent"教程,和 EP0 是同一题材,写完自己的再看它怎么写
- [Claude API — Tool use 官方文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) — tool_use/tool_result 的权威 wire format

**EP1 之前**
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629) — 2022 原始论文,EP1 就是复现它的核心循环

**EP2 之前**
- [Pi SDK 文档](https://pi.dev/docs/latest/sdk) — AgentSession、defineTool、事件流
- [Anthropic — Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — "先简单可组合,确有收益再加复杂度"的方法论

**全程参考**
- [Anthropic — Writing Effective Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — 工具怎么设计才好用
- [OpenAI — A Practical Guide to Building AI Agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/) — 另一家的一手方法论,交叉印证

## License

代码采用 [MIT](LICENSE);笔记文字保留所有权利。
