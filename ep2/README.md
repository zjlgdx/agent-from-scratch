# EP2:issue loop(pi SDK)

前置:Node ≥ 22.18(能直接跑 .ts 和 --env-file,作者用的是 24);仓库根目录放 `.env`,内容 `GROQ_API_KEY=gsk_...`(console.groq.com/keys 免费注册)。

```bash
cd ep2
npm install                        # 唯一依赖:@earendil-works/pi-coding-agent
node target/app.ts                 # toy 项目现状:3 个 FAIL
node --env-file=../.env hello.ts   # 最小 pi 会话(热身)
node --env-file=../.env agent.ts   # issue loop:逐条修 issues.md 里的 bug,约 3 分钟
```

每修完一个 issue,脚本自己跑 `node target/app.ts` 数 FAIL:变少才打勾,没变少就停。跑完应全部 PASS,issues.md 里全变 `[x]`。
想重来:`git checkout -- target/stats.ts issues.md`。

换提供商:pi 自带 `groq`、`cerebras`、`cloudflare-workers-ai`、`nvidia`、`openrouter` 等 provider。在 `.env` 里配对应的 key(`CEREBRAS_API_KEY`、`CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`、`NVIDIA_API_KEY`、`OPENROUTER_API_KEY`),再设 `LLM_PROVIDER` 和 `LLM_MODEL`,例如 `LLM_PROVIDER=cerebras LLM_MODEL=gpt-oss-120b`。模型 id 不对时 `hello.ts` 会把当前可用的列出来。
