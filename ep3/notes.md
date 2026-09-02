# 《从零手写Agent》EP3 对照生产实现: 从一个真实 Harness 的源码里学到什么

## 一、裸循环直接上生产会遇到什么

EP0 我们写了 136 行裸循环，EP2 跑通了任务队列。裸循环能转，但真拿去干复杂任务，有三个地方会先出问题：

1. **输出失控**：工具返回巨量输出（比如读一个几百 KB 的日志、扫一遍目录）瞬间就是几万 Token，TPM 和上下文当场撑爆，EP2 真实踩过。
2. **路径越界**：模型只是在生成文本参数，它生成 `path: "../../etc/passwd"`，裸循环直接调 `fs`，就读出去了。
3. **死循环**：裸循环一旦启动就是个黑盒 `while (true)`。模型理解偏了，或者在两三个工具间打转，宿主没有中途插话纠偏（Steer）的机制，人在终端前只能强杀进程。

EP0 的裸循环是把 API 和工具串起来的发动机；Harness 做的是给它装底盘、刹车和安全气囊。

---

## 二、对照靶子：Pi 的 Harness 源码

本课说的“真实 Harness”就是 EP2 用过的 Pi SDK。它的内核在 `@earendil-works/pi-agent-core` 的 `dist/harness/` 目录里（版本 0.80.10，装完 EP2 的依赖后在 `ep2/node_modules` 下就能翻到）。本课这几个机制各有对应物：

| 本课机制 | Pi 里的对应物 |
| :--- | :--- |
| 输出熔断 `truncateOutput` | `pi-coding-agent/dist/core/tools/truncate.js`：`DEFAULT_MAX_LINES = 2000`、`DEFAULT_MAX_BYTES = 50KB`，截断后在结果里标明 `truncatedBy: "lines" \| "bytes"` |
| 路径沙箱 `resolveSafePath` | Pi 的 `read` 工具本身不做 cwd 沙箱；它在 `core/tools/read.js` 里判断路径是否落在自己的文档目录时，用的是 `path.relative` 看结果是否以 `..` 开头，这一招可以借来做沙箱，别拿 `startsWith` 比前缀 |
| 上下文修剪 `pruneContext` | `harness/compaction/compaction.js`：`shouldCompact`、`keepRecentTokens`、`findTurnStartIndex`，超预算时让模型写摘要（Summary）替换旧历史 |
| Steer / FollowUp | `harness/agent-harness.js`：`steerQueue`、`followUpQueue`、`nextTurnQueue`，默认 `one-at-a-time`，作为 `getSteeringMessages` / `getFollowUpMessages` 回调交给内层循环，在 Turn 边界排空 |

本课做的事，是把这些机制各抠出最小的一版，塞回 EP0 那个裸循环里。

---

## 三、护栏一：工具沙箱与输出熔断

### 1. 路径沙箱（resolveSafePath）
我们把目标路径限制到 `target/` 目录下，解析出的绝对路径不在 `target/` 下面，就拦下来，抛 `[Security Sandbox Violation]`。

**我第一版写错了**：用 `startsWith(SANDBOX_DIR)` 比前缀，`../target-backup/x` 解析出来同样以 `.../target` 开头，能穿过去。现在改用 `path.relative` 看结果是不是以 `..` 开头，Pi 判断路径归属用的也是这一招。

**`bash` 工具没有沙箱**。它只是把工作目录（cwd）设成 `target/`，`cat ../../AGENTS.md` 照样能读出来。留着它有两个用处：截断后模型有办法用 `sed`、`grep` 分段读；你可以亲手试出“工作目录不等于沙箱”。Pi 的 `bash` 工具也只设工作目录，真正的隔离要靠容器这类外层手段。

模型只是个文本生成器，不能指望它做合规判断。安全边界得由宿主来守，而宿主自己也会写错，要拿 `../` 这种输入实际去试。

### 2. 输出截断（truncateOutput）
工具输出超过 15 行或 800 字符就切掉后面的部分。

关键在尾部那行提示：如果只是静默截断，模型会误以为文件只有 15 行；注入 `[Output Truncated: 已展示前 15/72 行...]` 后，模型知道后续还有内容。

终端里没直接看到这行字，是因为 `ep3/agent.mjs:271` 为了避免刷屏，只打印了首行预览：
```js
console.log(`[result preview] ${result.split("\n")[0]}...`);
```
而包含末尾截断标记的完整文本已原样塞入 `messages` 数组交给了模型。模型在下一步改用 `sed` / `grep` 分段读，说明它确实收到了这句截断提示。

顺带说一下我给工具加的 `replay` 标注。这不是 OpenAI 协议字段，Pi 里也没有这个概念。只读工具标 `replay: "safe"`，写入和命令执行标 `replay: "never"`，发请求前在本地剥掉（`agent.mjs:198`）。本课只把它打印出来，没有任何逻辑消费它。真正的 Harness 在崩溃恢复或重试时要靠它决定能不能重放：读操作幂等可以重跑；写操作有不可逆副作用，不能盲目跑第二遍，只能补一条“已中断”的合成结果。

---

## 四、护栏二：上下文治理与历史修剪

### 1. 结构断裂风险：为什么不能直接 splice 删旧消息
OpenAI/Groq API 对消息历史有格式校验：每个 `role: "tool"` 必须和前面 `assistant.tool_calls` 里的 `tool_call_id` 一一对应。删掉某条消息破坏了配对，下一次请求直接 400。

### 2. 保留消息配对，只压缩旧工具结果
遍历历史消息，保留最近几轮的完整数据；对更早轮次的 `role: "tool"` 消息，保留它的 `role` 和 `tool_call_id`，骨架和协议契约都还在，只把 `content` 换成一句占位符 `[Pruned old tool result...]`。

Token 一下少了很多，不会再撞 TPM 和 413，而服务端看到的历史结构仍然合法。代价是原地改写历史会让服务端按前缀建的缓存命不中，所以修剪只在超预算时做，而且每条旧结果只会被压一次，换后面每一轮更小的请求。这和后文的只追加原则不冲突：一个是常态，一个是例外。

---

## 五、护栏三：轮次检查点与多级调度

### 1. 检查点（Checkpoint）与只追加原则
检查点在单轮循环的关键交界处：上一轮工具执行完毕，下一次请求模型之前。外面不管发生了什么指令变化，都在这里统一结算和调度。

上下文只追加（Append-only），不在中间改。中间一改，服务端按历史前缀建的 KV Cache 就命不中了，下一次请求得重算；能省多少、有没有缓存折扣，各家不一样。

看 `agent.mjs:227-236`：指令不是在工具跑的一瞬间打断进程，而是放进 `steeringQueue`，在下一个 Turn 开始前的 Checkpoint，作为一条标准的 `role: "user"` 消息追加到末尾。在消息前加上 `[Steering Notice / Human Interruption]` 标签，并在系统提示词里明确声明了它的最高优先级。带着 `DEMO_STEER=1` 启动，输入“先读一下 data.log，然后逐行分析每个请求耗时”，模型第一轮读完日志后插话生效，第二轮立刻放弃长篇大论，直接给出一句话精简结论。

### 2. 中途插话（Steer）与顺手接力（FollowUp）
Steer 和 FollowUp 一硬一软。Steer 在每个 Turn 之前检查，队列里有就立刻注入。FollowUp 要等模型干完当前主任务（没有发起 `tool_calls`）、而且没有 Steer 时才消费（`agent.mjs:252-261`）。FollowUp 的用处是不用傻等模型跑完 10 步工具再敲下一句：运行中打 `/followup 顺便把结果存到 done.txt`，Agent 做完上一段接着干。

第一版交互式命令行（REPL）用 `for await` 逐行读输入，`await runHarnessTurn` 期间根本读不到键盘，`/steer` 和 `/followup` 只能在两次运行之间生效，“中途”其实是假的。现在改成监听 `line` 事件加一个 `busy` 标记（`agent.mjs:312-329`）：模型跑的时候敲 `/steer`、`/followup` 立刻入队，下一个 Checkpoint 消费；其他输入会被拒掉。`DEMO_STEER=1` 仍然保留，作为不靠手速的确定性演示。

### 3. 会话事务回滚（Session Rollback）
看入口处的 `agent.mjs:335-343`：
```js
const mark = sessionMessages.length;
try {
  await runHarnessTurn(sessionMessages);
} catch (err) {
  sessionMessages.length = mark; // 事务失败回滚
}
```

网络超时或 API 报 500/400 时，如果让半截消息留在上下文里，后面的对话就全废了。一行 `sessionMessages.length = mark`，就把整轮会话回滚到了开始之前。

---

## 小结：生产级 Harness 的本质

裸循环只解决模型和工具能不能转起来。生产 Harness 的功夫全在循环缝隙里：进出口上是路径沙箱和输出截断，资源上是历史修剪，调度上是 Checkpoint、Steer、FollowUp 和会话回滚。

---

代码：[agent-from-scratch/ep3](https://github.com/zjlgdx/agent-from-scratch/tree/main/ep3)（[agent.mjs](https://github.com/zjlgdx/agent-from-scratch/blob/main/ep3/agent.mjs)，约 350 行，零依赖）

运行：

```sh
cd ep3
node --env-file=../.env agent.mjs
DEMO_STEER=1 node --env-file=../.env agent.mjs   # 不靠手速的中途插话演示
```
