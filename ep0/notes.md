# 《从零手写Agent》EP0 136 行裸循环: Tool Call 到底是什么

每天在终端里用 Claude Code，看着它读代码、建文件、跑测试，用多了难免琢磨几个问题：

- Agent 到底是怎么读写我本地文件的？
- 模型是真的在“主动执行”代码，还是另有机关？
- 如果把 Agent 接进多租户系统（比如电商 ERP），怎么做权限隔离，确保它不会串到别人的店铺数据？

抛开框架与 SDK 的封装，底层的调用链其实很朴素：**大模型从头到尾没有执行过一行本地代码**，它只是个根据 Prompt 预测下一个 Token 的文本补全器。工具执行、文件读写和权限校验，全都发生在宿主本地。

这里用 136 行零依赖的原生 Node.js 代码直接调用 HTTP 接口，理清工具调用（Tool Call）与底层传输格式（Wire Format）。

---

## 拆开来看：Agent 循环就这 5 步

一个最简的 Agent 循环，就是一个 `while (true)` 状态机：

1. **定义工具契约**：在本地写一个工具数组，包含给模型看的 Schema（名称、描述、入参 JSON Schema），以及本地真正执行的函数 `run`。
2. **构建消息历史**：初始化一个消息数组 `messages`，塞入系统提示词和用户的提问。
3. **发 HTTP 请求**：把 `messages` 和 `tools` 列表一起 POST 给大模型接口。
4. **拿回生成意图**：模型根据 Schema 生成一条带 `tool_calls` 数组的回复，每个调用的 `arguments` 是一段 JSON 字符串。
5. **本地分发与回填**：本地宿主遍历 `tool_calls`，按名字调用对应的本地 `run` 函数；把模型的回复和本地执行结果（`role: "tool"` 并带上对应的 `tool_call_id`）按顺序塞进 `messages`，接着进入下一轮循环。

当模型拿到了所有工具执行结果、觉得不需要再调工具时，它会返回一段不带 `tool_calls` 的纯文本回复，此时退出循环，一轮任务结束。

```js
const messages = [
  {
    role: "system",
    content:
      "你是一个运行在用户终端里的编程助手,可以用工具读写当前目录下的文件。"
  },
];
```

---

## 实验一：故意调一个不存在的工具，看它到底输出了什么

下面的实验都跑在 2026-07 当时的默认模型 `llama-3.3-70b-versatile` 上，Groq 已于 2026-09 下线它。代码现在默认 `openai/gpt-oss-120b`，它工具调用更稳，也更老实，不会编 `brave_search`；想复现原实验，走 Cloudflare Workers AI 或 NVIDIA 上还在的 llama-3.3-70b（配置见仓库 `.env.example`）。

为了验证“模型根本没有执行权，只是在吐文本”，我做了一个反向实验：故意把系统提示词里“只能用列出的工具、没有联网能力”的约束删掉，然后问它今天天气：

```text
node ep0/agent.mjs                               10:01
模型:llama-3.3-70b-versatile(Ctrl-C 退出)

你: 今天天气如何？

[error] API 400: {"error":{"message":"tool call validation failed: attempted to call tool 'brave_search' which was not in request.tools","type":"invalid_request_error","code":"tool_use_failed","failed_generation":"\u003cfunction=brave_search\u003e{\"query\": \"今天天气如何\"}\u003c/function\u003e"}}
```

这个 400 报错里的 `failed_generation` 字段把底层的真相暴露得一清二楚：模型遇到未知问题，只是按预训练学到的格式凭空续写出一段 `<function=brave_search>{"query": "今天天气如何"}</function>` 文本；Groq 收到后对照请求传入的 `tools` 清单，发现没有 `brave_search`，直接拒绝。模型绝不可能背着宿主偷偷连网，本地不注册进 Schema 并提供执行函数，它什么都干不了。

---

## 实验二：正常的写诗任务，底层到底跑了几次 API？

当我们给出一个在工具能力范围内的需求时，终端看到的轨迹是这样的：

```text
> node ep0/agent.mjs                               17:45
模型:llama-3.3-70b-versatile(Ctrl-C 退出)

你: 写一首诗

[tool] write_file {"content":"月亮沉默地流尽\n星星寂静地闪烁\n夜晚安静地降临\n世界静谧地休息","path":"poem.txt"}

[tool] list_files {"path":"."}

AI: 已在当前目录下创建 poem.txt 文件，并成功写入一首关于夜晚的诗。同时，查看了当前目录下的文件和子目录，确认 poem.txt 文件存在。
```

你在终端只敲了一句话（`你: 写一首诗`），但如果去数底层的网络请求，Agent 循环一共发起了 **3 次 API 调用**：

1. **第 1 次 API 请求**：模型拿到写诗需求，返回 `write_file` 意图；宿主在本地执行 `writeFileSync`，把文件落盘；
2. **第 2 次 API 请求**：宿主把写入成功的结果塞进上下文传回，模型看到后，返回 `list_files` 意图；宿主在本地执行 `readdirSync` 列出目录；
3. **第 3 次 API 请求**：宿主把目录列表塞进上下文传回，模型确认文件存在，不再发起工具调用，输出最终的纯文本回复。

这就是 Turn 和 Step 的区别：用户说一句话是一个 Turn，Agent 在幕后为了达成目标，可以自动走多个 Step。

---

## 踩坑记录：两条必须遵守的底层契约

### 1. Assistant 消息一行都不能少（Wire Format 协议配对）

```js
// 模型的回复必须原样进历史——tool_calls 不能丢，后面的 role: "tool" 要和它的 id 配对
messages.push({ ...msg, content: msg.content ?? "" }); // 唯一的改动:content 为 null 时补空串
```

在 OpenAI / Groq 的 Wire Format 规范里，每一条 `role: "tool"` 消息都要通过 `tool_call_id` 对应到前面那条 `assistant` 消息 `tool_calls` 里的某一个调用；一条回复里有几个调用，就得补齐几条结果，才能接着往下问。

如果注释掉这行 `messages.push(...)`，上下文里就会出现“只有执行结果、没有前置意图”的孤儿消息。后果有两种，在 EP4 中均有记录：在 Groq 上跑 `llama-3.3-70b`，服务端没拦。模型看不到自己调过工具，同一个文件连写三遍，直到第四次输出格式畸变才报 400；那个 400 是 `tool_use_failed`，拒的是畸形输出，不是孤儿消息本身。换成 `gpt-oss-120b`，服务端在渲染对话模板时就直接拒绝，400 里写着 `Tools should have a name!`。不管哪种，会话都直接报错中断。

“原样塞回”在换提供商时还撞出了一个例外：Cloudflare Workers AI 的兼容端点上，模型发起调用时返回的 `assistant` 消息 `content` 是 `null`，可它自己的请求校验只收字符串，原样发回去就 400。Groq 收 `null`，Cloudflare 不收，所以代码里补了一句 `content: msg.content ?? ""`。契约是协议层面的，各家实现有出入，这就是 Wire Format 落到地面的样子。

### 2. 出错时一行代码把这轮消息截掉

```js
const mark = messages.length;
messages.push({ role: "user", content: line });
try {
  await runTurn(messages);
} catch (err) {
  messages.length = mark; // 回滚这一轮，别让半截状态留在历史里
  console.error(`\n[error] ${err.message}`);
}
```

如果在跑某一步时网络超时、工具抛异常或者 API 报错，这半截未闭合的消息（比如发了 user 却没有 assistant，或者发了 assistant 却没补齐 tool）就会留在 `messages` 数组里，污染后续对话。

不需要设计复杂的状态快照，只需在每轮开始前记下 `mark = messages.length`，catch 到了异常直接将 `messages.length = mark` 截断，就能把会话恢复到本轮之前的状态。

---

## 换用新模型重测：底层机制与行为漂移

我把同一套代码在三个现在能用的模型上重跑了一遍：Cloudflare Workers AI 上的 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`（同一个 llama，换了家提供商），以及 Groq 上的 `openai/gpt-oss-120b` 和 `qwen/qwen3.8-27b`。

| 实验 | 2026-07 llama（Groq） | 2026-09 llama（Cloudflare） | 2026-09 gpt-oss-120b / qwen3.8 |
| :--- | :--- | :--- | :--- |
| 实验一：去掉约束问天气 | 编出 `brave_search`，400 | 不编工具了，改去 `read_file` 一个不存在的 `weather.txt`，读不到就承认做不到 | 直接说做不到，不碰任何工具 |
| 实验二：“写一首诗” | 写文件、列目录、回答，3 次 | 写文件、回答，2 次 | 一次直接回答，根本不写文件 |
| 实验二改问“存到 poem.txt 并确认” | 未测 | 写、列、答，3 次 | gpt-oss 4 次（多列了一次目录），qwen 3 次 |
| 契约一：注释掉 `push(msg)` | 连写三遍后 400 | **死循环**，40 秒内把 `word.txt` 写了 21 遍，Cloudflare 从不报 400 | gpt-oss 在模板渲染阶段直接 400 |

这几组对照跑下来，看清了三件事。

底层机制一个没变：工具调用还是文本，`role: "tool"` 还得和 `tool_calls` 配对，执行还是全在宿主。契约一在 Cloudflare 上的表现更加极端：服务端根本不校验历史结构，孤儿消息一路放行，模型看不到自己写过，就一直写：

```text
模型:@cf/meta/llama-3.3-70b-instruct-fp8-fast(Ctrl-C 退出)

你: 写一首词

[tool] write_file {"content":"和家和家和家","path":"word.txt"}

[tool] write_file {"content":"和小友一身水。","path":"word.txt"}

[tool] write_file {"content":"和家的一个世界","path":"word.txt"}

[tool] write_file {"content":"和世界一般","path":"word.txt"}
（……21 次之后被我 Ctrl-C，Cloudflare 一次 400 都没报……）
```

变的是现象。编造未定义工具的行为，这次试的三个模型都不做了；至少从外面看，护栏挪到了模型那一侧，至于是训练、服务端模板还是约束解码在起作用，从 API 外面分不清。但漂移不只朝好的方向走：同一个 llama 换了一家提供商，异常模式就发生了变化，从“无中生有”变成“滥用手头现有的工具”。
还有一件：`failed_generation` 依然抓得到，只是触发条件变了。给 gpt-oss-120b 的系统提示词里加一句“你还可以调用 `web_search` 工具”，`tools` 参数里不放它，它立刻按训练进去的格式生成调用，Groq 照样 400：

```text
{"error":{"message":"Tool call validation failed: tool call validation failed: attempted to call tool 'web_search' which was not in request.tools","type":"invalid_request_error","code":"tool_use_failed","failed_generation":"{\"name\": \"web_search\", \"arguments\": {\n  \"query\": \"上海 今天天气\"\n}}"}}
```

两个月前靠模型自己犯错才能看到的 `failed_generation` 字段，现在用一句提示词注入就能稳定复现。这比原实验更能说明问题：模型调工具只是在按格式续写文本，提示词里出现的名字它就敢写，能不能执行它管不着。

---

## 回头解答开篇的困惑

### 1. 工具调用到底是什么？模型在主动执行代码吗？

在代码实现中，工具由结构定义与执行函数共同组成：

```js
const TOOLS = [
  {
    name: "read_file",
    description: "读取一个文本文件的内容。路径相对于当前工作目录。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径" } },
      required: ["path"],
    },
    run: ({ path }) => readFileSync(path, "utf8"),
  },
  {
    name: "list_files",
    description: "列出目录下的文件和子目录。不传 path 时列出当前目录。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "目录路径,默认 '.'" } },
      required: [],
    },
    run: ({ path = "." }) =>
      readdirSync(path, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .join("\n"),
  },
  {
    name: "write_file",
    description: "把内容写入文件(覆盖写)。父目录不存在时自动创建。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    run: ({ path, content }) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return `已写入 ${path}(${content.length} 字符)`;
    },
  },
];
```

**工具 = 给模型看的结构定义（Schema，纯文本） + 宿主本地执行的函数（`run`）。**

模型自始至终没有主动执行代码的特权，它只看到文本描述；所谓“调用工具”，只是按格式输出了一段 JSON 字符串。真正的文件读写，全是宿主里的 `run` 在干。

### 2. 多租户系统怎么做权限隔离、防止串号？

**鉴权属于宿主，绝不属于模型。**

模型只负责从用户输入中提取业务参数（比如“查昨天的订单” -> `time_range: "yesterday"`）。真正的执行函数里，必须像传统后端接口一样，从当前会话上下文中拿登录用户的 `shopId`，在查数据库时做硬隔离：

```js
// 鉴权边界永远留在本地宿主，绝不能相信模型传过来的 shopId
run: async ({ time_range }, sessionContext) => {
  const currentShopId = sessionContext.user.shopId;
  return await db.orders.find({ shopId: currentShopId, time_range });
}
```

大模型没有任何越过宿主鉴权机制的特权。后端原来怎么做多租户隔离，给 Agent 做工具时就怎么做。

---

## 小结

- 模型只是文本补全器，负责把自然语言翻成结构化的调用参数。
- 宿主才是执行方，负责维护消息契约、调用本地函数、守住权限边界。
- 后面几课的 Harness、调度和自主 Agent，都是从这 136 行长出来的。

---

代码：[agent-from-scratch/ep0](https://github.com/zjlgdx/agent-from-scratch/tree/main/ep0)（[agent.mjs](https://github.com/zjlgdx/agent-from-scratch/blob/main/ep0/agent.mjs)，136 行，零依赖）

运行：

```sh
export GROQ_API_KEY=gsk_...
node ep0/agent.mjs
# 换提供商或模型:LLM_BASE_URL / LLM_API_KEY / LLM_MODEL,各家配置见仓库 .env.example
# 复现 2026-07 的实验(llama-3.3-70b,Groq 已下线):LLM_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast 走 Cloudflare
```
