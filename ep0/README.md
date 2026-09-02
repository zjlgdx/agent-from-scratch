# EP0 — 裸循环:tool call 到底是什么

单文件 `agent.mjs`,零依赖,直接 HTTP 调任意 OpenAI 兼容接口(默认 Groq 免费档)。需要 Node 18+。

## 怎么跑

1. 到 <https://console.groq.com/keys> 免费注册拿 key(不用绑卡);想用别家见根目录 `.env.example`
2. 运行:

```sh
export GROQ_API_KEY=gsk_...
node ep0/agent.mjs
# 换提供商或模型:export LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=...(默认 openai/gpt-oss-120b)
# 笔记里 2026-07 的实验跑在 llama-3.3-70b 上,Groq 已下线;复现走 Cloudflare:LLM_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

试试这句:

> 看看当前目录有什么文件,读一下 README,然后写一个 hello.py

工具调用会以 `[tool] read_file {...}` 的形式打印出来,方便观察循环的每一步。
免费档有每分钟请求/Token 限速,撞到 429 歇几秒再发就行。
