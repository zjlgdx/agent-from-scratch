# EP1 — 手工 ReAct:2022 年的人怎么让模型干活

单文件 `agent.mjs`,零依赖,和 EP0 同一个 OpenAI 兼容接口(默认 Groq)——但请求里不传 `tools`,回复里没有 `tool_calls`。工具清单写在 prompt 里,模型输出纯文本轨迹(Thought / Action / Action Input),`stop` 参数拦在 Observation 之前,解析和执行全在本地。需要 Node 18+。

## 怎么跑

1. 到 <https://console.groq.com/keys> 免费注册拿 key(不用绑卡);想用别家见根目录 `.env.example`
2. 运行:

```sh
export GROQ_API_KEY=gsk_...
node ep1/agent.mjs
# 换提供商或模型:export LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=...(默认 openai/gpt-oss-120b)
```

模型注意:笔记里 2026-07 的五场实验跑在 `llama-3.3-70b-versatile` 上,Groq 已下线,复现走 Cloudflare 或 NVIDIA。`openai/gpt-oss-20b` 跑不了本课:请求里明明没传 tools,它看到 prompt 里的工具清单还是会吐原生格式的 tool call,Groq 直接 400 `Tool choice is none, but model called a tool`——这恰好是本课结尾那个论点的现代版证据。

试试这句:

> 看看当前目录有什么文件,读一下 README,然后写一个 hello.py

整条 ReAct 轨迹会原样打印出来,方便对照 EP0 的 `[tool]` 输出看区别。
免费档有每分钟请求/Token 限速,撞到 429 歇几秒再发就行。
