# 错题本

规则：遇到答不上来的词或问题，加一条，当时不深究。后面哪课弄懂了就打勾，用自己的话写一句答案；EP4（十个我曾经答不上来的问题）从这里取原料，每条最后写它去了 EP4 第几题。

编号全局递增、不复用。EP4 笔记和 `ep4/quiz.mjs` 的“代码溯源”按这个编号引用（`questions.md #n`）。

## EP0 裸循环（2026-07-17 结课）

### #0 runtime / harness 到底指什么

- [x] 围绕模型调用的一整圈东西（循环、工具执行、消息历史、错误处理）；ep0/agent.mjs 就是一个 136 行的极简 runtime。
- 去向：EP4 Q10

### #1 模型那条带 tool_calls 的 assistant 消息，为什么必须原样塞回 messages？只塞工具结果、不塞这条 assistant 消息，下一次请求会发生什么？

- [x] OpenAI 这套格式要求每条 role:"tool" 消息通过 tool_call_id 对应到前一条 assistant 消息的 tool_calls 里，一批结果补齐才能继续。少了它就是孤儿消息，但不同服务端反应不一样：Groq 上的 llama 没有拦，模型看不到自己调过工具，同一个文件写了三遍，第四次输出畸形才报 400（tool_use_failed，拒的是畸形输出）；换 gpt-oss 则在渲染模板时直接 400。严格校验的服务端会把不完整的历史当非法请求，根本轮不到模型。
- 验证实验（把 ep0/agent.mjs:95 的 `messages.push(msg)` 注释掉再问一句话）：

```text
> node ep0/agent.mjs                                                                                       19:15
模型:llama-3.3-70b-versatile(Ctrl-C 退出)

你: hello

AI: 你好，我可以帮助你进行文件操作，如读取、写入和列出文件。如果你需要这些服务，请告诉我。否则，如果你有其他问题，请问是什么呢？我会尽力回答。记住，我只能处理本地文件相关的问题，无法访问互联网。

你: 写一首词

[tool] write_file {"content":"月亮沉落，星光闪烁，夜色静谧，世界安睡。","path":"词.txt"}

[tool] write_file {"content":"寒蝉凄切\n\n露井寒，月挂枫林。烛龙蛇，银河垂垂。","path":"词.txt"}

[tool] write_file {"content":"落日照大江，江流浩浩然。","path":"词.txt"}

[error] API 400: {"error":{"message":"tool call validation failed: attempted to call tool 'write_file{\"content\": \"花好月圆人寿，世代共承欢乐。\", \"path\": \"词.txt\"}' which was not in request.tools","type":"invalid_request_error","code":"tool_use_failed","failed_generation":"<function=write_file{\"content\": \"花好月圆人寿，世代共承欢乐。\", \"path\": \"词.txt\"}></function>"}}
```

- 去向：EP4 Q1

### #2 一条回复里同时出现两个 tool_call（比如 write_file 和 list_files），两个执行结果怎么和各自的调用对上号？

- [x] 靠 tool_call_id。每个结果单独一条 role:"tool" 消息，带着对应的 id 塞回去。
- 去向：EP4 Q2

### #3 模型让 read_file 读一个不存在的文件，程序会崩吗？模型会看到什么？这套 OpenAI 格式里有没有“这是一个错误”的专门标志位？

- [x] try/catch 兜住不崩，错误字符串当普通 tool 消息塞回；这套格式没有 is_error 标志（Anthropic 格式有，这是两家 wire format 的真实差异）。模型看错误文本决定下一步怎么做。
- 去向：EP4 Q3

### #4 “写一首诗”那个例子里，一共发生了几轮 agent 调用、几次模型 API 调用？

- [x] 1 轮 agent 调用（只问了一次“写一首诗”），3 次 API 调用：第 1 次拿到 write_file，第 2 次拿到 list_files，第 3 次拿到纯文本回复。一般规律：至少 1 次，每执行完一批工具再加 1 次。
- 验证实验（临时在 callModel 里加了计数打印）：

```text
> node ep0/agent.mjs                                                                                       19:41
模型:llama-3.3-70b-versatile(Ctrl-C 退出)

你: 写一首词，并检查格式正确

[call model api count] 1

[tool] write_file {"content":"江南佳丽地，水驿落花洲。花满渚，柳拂河，春风已无处。江南忆，最忆是，江南。","path":"ci.txt"}

[tool] read_file {"path":"ci.txt"}

[call model api count] 2

AI: 您的词已经成功写入文件 ci.txt 中，并且内容如下：江南佳丽地，水驿落花洲。花满渚，柳拂河，春风已无处。江南忆，最忆是，江南。格式似乎正确，无误。
```

- 去向：EP4 Q4

### #5 我们从没定义过 brave_search，模型为什么会“知道”这个工具名、还能生成格式标准的调用？

- [x] 训练语料里见过 brave_search 这类工具名，所以能凭空生成格式标准的调用。这就是“tool call 只是按 schema 生成的文本”的最硬证据。
- 去向：EP4 Q4

### #6 400 报错的那次实验结束后，消息历史（messages）里留下了什么？如果留下了半截状态，会有什么后果？

- [x] 什么都没留下：ep0/agent.mjs:128 先记了 mark，catch 里 `messages.length = mark` 把这一轮整个回滚，连本次提问都撤掉了；报错只打印到终端，从未进过 messages。不回滚就会留下半截孤儿消息污染上下文，后面的会话可能全报 400。

```js
const mark = messages.length;
messages.push({ role: "user", content: line });
try {
  await runTurn(messages);
} catch (err) {
  messages.length = mark; // 回滚这一轮,别让半截状态留在历史里
  console.error(`\n[error] ${err.message}`);
}
```

- 和 #3 的区别（当时看着矛盾，理清后才敢打勾）：#3 是内层 catch 捕获的错误，工具执行失败时对话是健康的，模型正等一个 tool 结果，错误文本就是合法的结果，塞回去。#6 是外层 catch 捕获的错误：API 调用本身失败了，内层不捕获，直接抛到 REPL 那层；没法把错误“告诉模型”，因为告诉它恰恰需要一次成功的 API 调用。口诀：内层 catch 捕获的进 messages，外层 catch 捕获的回滚。
- 去向：EP4 Q3

### #7 如果模型在 arguments 里传 path: "../../etc/passwd"，EP0 现在的代码会发生什么？“模型碰不到执行层”这句话在这里够不够用？

- [x] 路径存在就 readFileSync 读出来塞给模型，不存在就把 ENOENT 塞回去，EP0 没有任何校验。“模型碰不到执行层”只说明执行发生在本地，不说明本地会拦：模型的 arguments 只是生成的文本，既可能出错，也可能被输入诱导（提示词注入），不能信它做合规判断。鉴权和沙箱得由宿主做，Claude Code、Codex 默认沙箱运行也是这个缘故。
- 去向：EP4 Q7

## EP1 手工 ReAct（2026-07-18 结课；2026-09-02 补记）

### #8 没有 tools 参数的年代，怎么让模型在要调工具时停下来，而不是自己把结果编下去？

- [x] `stop: ["\nObservation:"]`。模型刚要写 Observation 就被服务端掐断，宿主执行完再把真实 Observation 拼回 prompt。去掉 stop 就成了单口相声：模型一口气把 Observation 和 Final Answer 演完，hello.py 根本没落盘。新模型重测：llama 照旧，gpt-oss-120b 和 qwen 没有 stop 也自己停；stop 从唯一闸门退为最后保险。
- 去向：EP4 Q5

## EP2 Issue Loop（2026-08-19 结课；2026-09-02 补记）

### #9 批量跑任务，为什么每个 issue 都要开一个全新会话？裁判权为何必须留在宿主？

- [x] 会话隔离：上一个 issue 的代码和报错会污染下一个的判断；历史越滚越长，几轮就撞 TPM；每个 issue 有自己的失败边界，一个死循环不殃及其他。裁判权留宿主：坚决不给 agent 传 bash 工具防止全局 grep 打爆上下文，宿主通过对比 FAIL 行数减少作为硬裁判标准，绝不让模型既当运动员又当裁判。
- 去向：EP4 Q6

## EP3 生产 Harness（2026-09-01 结课；2026-09-02 补记）

### #10 长会话为了省 token，为什么不能 splice 删旧消息？

- [x] 删掉 assistant 或 tool 中的任意一条，配对就断了，下一次请求直接 400。正确做法是保骨架瘦内容：留 role 和 tool_call_id，把 content 换成占位符。代价是原地改写历史会让服务端前缀缓存失效，所以只在超预算时做一次。
- 去向：EP4 Q8

### #11 Steer 和 FollowUp 差在哪？为什么不能原地改历史？

- [x] Steer 在每个 turn 前的 Checkpoint 抢占注入；FollowUp 等模型停下来、不再发 tool_calls 时才消费。两者都只追加到尾部，改中间会打掉服务端的前缀缓存。修剪是唯一的例外。
- 去向：EP4 Q9

## 还没打勾的

（空。下一个卡住的词写在这里。）
