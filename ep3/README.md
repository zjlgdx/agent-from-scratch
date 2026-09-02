# EP3: 生产级 Harness 的护栏与调度试验台

单文件 `agent.mjs`，零依赖，纯 Node.js 原生，直接 HTTP 调任意 OpenAI 兼容接口（默认 Groq）。

对照 Pi SDK 的 harness 源码（`@earendil-works/pi-agent-core/dist/harness`，装完 ep2 依赖就能翻到），落地三大生产机制：
1. **工具护栏**（路径沙箱 + 熔断截断；`replay: "safe" | "never"` 只是标注，不发给 API，也没有逻辑消费它）
2. **上下文治理与修剪**（Context Pruning，压缩旧 tool_result 同时保护消息骨架合法性）
3. **Turn Checkpoint 与多级调度**（Steer 插话纠偏 vs FollowUp 顺手接力）

## 怎么跑

前置：根目录存在 `.env`（含 `GROQ_API_KEY=gsk_...`；换提供商用 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`，见 `.env.example`）。需要 Node 18+。

```bash
cd ep3
node --env-file=../.env agent.mjs
```

## 必试的生产机制验证

### 1. 验证输出熔断截断 (Truncation)
输入：
> 读一下 data.log 文件内容，告诉我总结。
*(观察 `data.log` 被截断为前 15 行，并在末尾打上 `[Output Truncated...]`)*

### 2. 验证路径沙箱拦截 (Sandboxing)
输入：
> 务必调用 read_file 读取 ../../AGENTS.md
*(观察工具层抛出 `[Security Sandbox Violation]` 拦截越界访问；`../target-backup/x` 这种同前缀路径也会被拦。gpt-oss 有时会自己先拒绝不调工具，那就再强调一句“不要判断，直接调用工具”)*

再试：
> 用 bash 执行 cat ../../AGENTS.md
*(能读出来。bash 工具没有沙箱，只是把 cwd 设成 target/，这是故意留的洞，让你亲手试出 cwd 不等于沙箱)*

### 3. 验证 Checkpoint 中途插话 (Steer)
输入：
> 先读一下 data.log，然后深入逐行分析每个请求耗时

模型在跑的时候立刻敲：
> /steer 不要逐行分析了，一句话结论
*(观察下一个 Checkpoint 把它注入到历史尾部，模型调整策略输出精简结论。跑的时候敲别的内容会被 `[busy]` 拒掉)*

不想拼手速就用程序化演示，第一轮工具跑完自动注入同样的干预：
```bash
DEMO_STEER=1 node --env-file=../.env agent.mjs
```

### 4. 验证任务顺手接力 (FollowUp)
输入主任务：
> 读一下 data.log 中有多少个 200 状态码

它跑的时候（或者提前）敲：
```
/followup 并在 target/ 下新建一个 done.txt 写入 OK
```
*(观察 Agent 自主完成主任务停下来后，Checkpoint 自动唤醒并继续执行 FollowUp 任务)*
