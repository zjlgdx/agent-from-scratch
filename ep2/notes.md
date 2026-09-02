# 《从零手写Agent》EP2 Issue Loop MVP: 让 Agent 自己跑完一个任务队列

向 Agent 输入本地 Bug 清单，让它在无人值守环境下逐一修复并运行检查脚本验证。EP0、EP1 那种手写 while 循环到这里就不够用了。这节课引入本系列唯一的外部依赖，Pi 的 Coding Agent SDK（`@earendil-works/pi-coding-agent`），用一百多行代码搭一个跑任务队列的 Issue Loop。

---

## 目标与准备

- **运行环境**：Node 22.18 以上（能直接跑 .ts 和 `--env-file`，我用的是 24）
- **目标项目（target/）**：`target/stats.ts`（刻意埋了 3 个 bug 的小统计库）+ `target/app.ts`（验证脚本）
- **任务清单**：本地 `issues.md`（标准的 Markdown Checklist）

```md
# toy 项目的 issue 清单(`- [ ]` 待修,`- [x]` 已修)

- [ ] median 没排序:median([3,1,2]) 应该返回 2,现在返回 1
- [ ] median 对偶数长度的数组应取中间两数的平均值:median([1,2,3,4]) 应该返回 2.5,现在返回 3
- [ ] range 算反了:range([1,5,3]) 应该返回 4,现在返回 -4
```

### 待修复的代码（`target/stats.ts`）

```ts
// 一个刻意埋了 bug 的小统计库,EP2 的 agent 按 issues.md 来修它。
export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  const mid = Math.floor(xs.length / 2);
  return xs[mid];
}

export function range(xs: number[]): number {
  return Math.min(...xs) - Math.max(...xs);
}
```

---

## 热身：hello.ts，先看 SDK 替我们省了什么

`hello.ts` 只做一件事：起一个会话，让它读 `package.json` 说一句话。对照 EP0 和 EP1，下面这些不用再手写了：

- 消息历史与 `tool_call_id` 配对（EP0 里 `messages.push(msg)` 那条契约）；
- 工具的 Schema 与执行分发，`read`、`edit`、`bash` 都是内置的；
- 流式事件：文本增量、工具开始与结束、消息结束，`session.subscribe` 一个订阅全拿到；
- 模型注册表与 Provider 适配，`modelRuntime.getModel("groq", "openai/gpt-oss-120b")` 一行拿到模型。

开发者需要负责的核心事务只有两项：编写提示词与裁定工具范围。后续遇到的几个工程问题，多由 SDK 默认过度封装的隐式行为引起。

---

## 宿主主循环和每个 issue 的独立会话

程序分两层：
1. **外层宿主主循环**：读 `issues.md`、管理任务等待间隔、调度单次修复任务，并在修复后自己跑 `node target/app.ts` 数 FAIL 行：变少才把 issue 打勾，没变少就停下来；
2. **内层 Agent 会话（`fixIssue`）**：为每个 Issue 创建全新的独立会话，只给 `read` 和 `edit` 两个工具，让 Agent 专注于看代码、定位原因、做最小修改。

```ts
// 每个 issue 一个全新会话。Pi 不抛 API 错误，得自己盯 stopReason。
async function fixIssue(issue: string): Promise<boolean> {
  const { session } = await createAgentSession({
    model,
    thinkingLevel: "low",
    tools: ["read", "edit"], // 不给 bash：验证归主循环管，agent 只负责改代码
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  });
  let apiError = false;
  try {
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.type === "tool_execution_start") {
        console.log(`[工具] ${event.toolName} ${JSON.stringify(event.args)}`);
      }
      if (event.type === "message_end" && event.message.stopReason === "error") {
        apiError = true;
        console.error("\n[API 错误]", event.message.errorMessage);
      }
    });
    await session.prompt(
      "target/ 目录里有一个小统计库 stats.ts 和检查脚本 app.ts。\n" +
        "下面的 issue 描述了一个 bug:先读 target/stats.ts 找到原因,再用 edit 做最小修复。不要动 app.ts。\n\n" +
        `Issue:${issue}`,
    );
  } finally {
    session.dispose();
  }
  return !apiError;
}
```

宿主这边的裁判只有几行：

```ts
// 裁判：跑检查脚本,数 FAIL 行。宿主只认这个数字,不认 agent 说"修好了"。
function runChecks(): { out: string; failed: number } {
  const out = execSync("node target/app.ts", { encoding: "utf8" });
  return { out, failed: (out.match(/^FAIL/gm) ?? []).length };
}

// 主循环里:修之前数一次,修完再数一次
const before = runChecks().failed;
// ... fixIssue(issue) ...
const { out, failed: after } = runChecks();
if (after >= before) {
  console.error(`[验证] FAIL ${before} -> ${after},没有变少。不打勾,停下来人工看看。`);
  process.exit(1);
}
markDone(issue);
```

---

## 运行轨迹

```text
> node --env-file=../.env agent.ts                                                                                                                                    11:22

=== 修:median 没排序:median([3,1,2]) 应该返回 2,现在返回 1 ===
[工具] read {"limit":2000,"offset":1,"path":"target/stats.ts"}
[工具] edit {"edits":[{"newText":"export function median(xs: number[]): number {\n  // Ensure the array is sorted before picking the middle element\n  const sorted = [...xs].sort((a, b) => a - b);\n  const mid = Math.floor(sorted.length / 2);\n  return sorted[mid];\n}","oldText":"export function median(xs: number[]): number {\n  const mid = Math.floor(xs.length / 2);\n  return xs[mid];\n}"}],"path":"target/stats.ts"}
已在 target/stats.ts 中修复 median 函数，使其在返回中位数前先对数组进行排序，确保 median([3,1,2]) 正确返回 2。app.ts 未做任何修改。
[验证] node target/app.ts
PASS mean([1,2,3,4]) = 2.5(期望 2.5)
PASS median([3,1,2]) = 2(期望 2)
FAIL median([1,2,3,4]) = 3(期望 2.5)
FAIL range([1,5,3]) = -4(期望 4)
2 个没过

[验证] FAIL 3 -> 2,打勾

=== 修:median 对偶数长度的数组应取中间两数的平均值:median([1,2,3,4]) 应该返回 2.5,现在返回 3 ===
[工具] read {"limit":2000,"offset":1,"path":"target/stats.ts"}
[工具] edit {"edits":[{"newText":"const mid = Math.floor(sorted.length / 2);\n  if (sorted.length % 2 === 0) {\n    // average of the two middle numbers for even length\n    return (sorted[mid - 1] + sorted[mid]) / 2;\n  }\n  return sorted[mid];","oldText":"const mid = Math.floor(sorted.length / 2);\n  return sorted[mid];"}],"path":"target/stats.ts"}
已在 target/stats.ts 中修复 median 函数：

- 对偶数长度数组计算两个中间值的平均值。
- 保持奇数长度数组的原有行为。

app.ts 未做任何更改。祝你使用愉快！
[验证] node target/app.ts
PASS mean([1,2,3,4]) = 2.5(期望 2.5)
PASS median([3,1,2]) = 2(期望 2)
PASS median([1,2,3,4]) = 2.5(期望 2.5)
FAIL range([1,5,3]) = -4(期望 4)
1 个没过

[验证] FAIL 2 -> 1,打勾

=== 修:range 算反了:range([1,5,3]) 应该返回 4,现在返回 -4 ===
[工具] read {"limit":2000,"path":"target/stats.ts"}
[工具] edit {"edits":[{"newText":"export function range(xs: number[]): number {\n  return Math.max(...xs) - Math.min(...xs);\n}","oldText":"export function range(xs: number[]): number {\n  return Math.min(...xs) - Math.max(...xs);\n}"}],"path":"target/stats.ts"}
Implemented the correct range calculation in target/stats.ts:

- Updated range function to return Math.max(...xs) - Math.min(...xs) instead of the incorrect subtraction, fixing the bug where it previously returned a negative value.
[验证] node target/app.ts
PASS mean([1,2,3,4]) = 2.5(期望 2.5)
PASS median([3,1,2]) = 2(期望 2)
PASS median([1,2,3,4]) = 2.5(期望 2.5)
PASS range([1,5,3]) = 4(期望 4)
全部通过

[验证] FAIL 1 -> 0,打勾
issues.md 里没有 open issue 了。
```

---

## 三个决定和一个意外

### 1. 为什么每个 Issue 必须隔离会话？

会话不隔离，上一个 Issue 的代码片段、报错和回复全留在历史里，每次请求都要重发，几轮就会耗尽 TPM 额度；模型也容易被前面的代码带偏。按任务隔离后，单次请求只有几百 Token，加上任务之间 `sleep(65_000)`，免费 API 的滑动窗口够用。

### 2. 为什么只给 read + edit，坚决不给 bash？

实测给 Agent `bash` 工具，模型面对不熟悉的项目，第一反应就是 `ls -R` 或全局 `grep`，整个 `node_modules` 灌进上下文，直接 413。

更关键的是谁说了算。Agent 只负责改代码，“改没改对”由宿主跑 `node target/app.ts` 来判，不能让模型既当运动员又当裁判。标准也要朴素：FAIL 行数比修之前少才打勾，否则直接停下。若宿主仅打印检查结果而不做断言与比较，就属于只看不判的无裁判状态，无法拦截未修复或劣化代码的合入。

### 3. “最小修复”与模型习惯的偏差

另一次运行里修第一个 Issue 时，即使提示词反复强调了“做最小修复”，模型依然倾向于加上 `if (xs.length === 0) return NaN;` 这种防御性逻辑。提示词里写“最小”，模型未必照做；加空值防御是它预训练形成的编程惯性，单纯一句提示词往往难以完全抑制。

---

## 实测踩到的三个坑

### 1. 38k Tokens 413 报错（SDK 的默认自动发现）

刚跑 `hello.ts` 时，单次请求就 413 了。排查发现，Pi 默认会全机自动扫描已安装的 Skills、Extensions 和上下文文件，把系统提示词直接撑到了 38k token。用 `DefaultResourceLoader` 传一组开关（`noSkills`、`noExtensions`、`noContextFiles` 等，完整参数见 `agent.ts`）关掉自动发现之后，系统提示词降回 430 token，那才是核心框架提示词本身的大小。

### 2. Groq 的 TPM 是按峰值预扣的

网关层的 TPM 计量往往并非在生成结束后按实际消耗结算，而是请求到达时按**预估峰值**前置扣除（根据 2026-08 从 413 响应里的 Requested 数字反推，官方文档未公开具体公式）：

> **单次请求计算量 = 输入 Prompt Tokens + max_tokens**

问题就出在这里：SDK 模型注册表里的 `max_tokens` 默认上限动辄数万（32768 甚至 65536）。哪怕只发了 10 个词的 Prompt，网关也会按 `10 + max_tokens` 预扣来判定是否超标，直接超出免费层 8k/12k TPM 的速率上限。解决办法是在代码里显式把 `model.maxTokens` 调低，`agent.ts` 里是 512，`hello.ts` 里是 1024。

### 3. API 报错不抛异常

Pi SDK 在遇到 API 报错时不会在 `prompt()` 调用中直接 throw 异常，而是将错误写入 `event.message.stopReason === "error"` 与 `errorMessage`。如果不主动订阅事件并检查这个状态，程序在终端里就是“没输出、没报错、正常退出”，看起来像什么都没发生。

---

## 小结

- 循环本身不难，难的是三件事：每个 issue 一个干净的会话、只给必要的工具、验证留在宿主手里。
- SDK 省掉了协议处理，但 Skills 自动扫描、maxTokens 预扣、报错不抛异常这些坑，还得宿主自己兜住。

---

代码：[agent-from-scratch/ep2](https://github.com/zjlgdx/agent-from-scratch/tree/main/ep2)（[agent.ts](https://github.com/zjlgdx/agent-from-scratch/blob/main/ep2/agent.ts)，约 120 行，唯一依赖 pi SDK；热身用的 [hello.ts](https://github.com/zjlgdx/agent-from-scratch/blob/main/ep2/hello.ts)）

运行：

```sh
cd ep2 && npm install
node --env-file=../.env hello.ts    # 热身
node --env-file=../.env agent.ts    # issue loop,约 3 分钟
```
