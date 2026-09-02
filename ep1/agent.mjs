#!/usr/bin/env node
// EP1 — 手工 ReAct:回到 2023 年 6 月 function calling 出现之前,API 只有"文本进文本出"。
// 工具清单写进 prompt,输出格式由我们发明并逼模型遵守,正则解析,
// stop 参数在模型刚要编造 Observation 的瞬间掐断生成。
// EP0 的 tool_calls 字段,就是这一整套被 provider 收进服务端的样子
// (证据:EP0 那次 400 报错漏出的 failed_generation)。

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import readline from "node:readline/promises";

const API_KEY = process.env.LLM_API_KEY ?? process.env.GROQ_API_KEY;
if (!API_KEY) {
  console.error("请先设置 LLM_API_KEY(或 GROQ_API_KEY,在 console.groq.com/keys 免费注册),见根目录 .env.example");
  process.exit(1);
}
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1";
const MODEL = process.env.LLM_MODEL ?? "openai/gpt-oss-120b"; // llama-3.3-70b 已下线;gpt-oss-20b 跑不了本课(强行吐原生 tool call)
const MAX_STEPS = 10; // 轨迹步数上限,防模型绕圈(论文同样设了上限)

// ---- 工具:和 EP0 完全相同的三个,原样复制(课间允许复制粘贴)----

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

// ---- 系统提示词:EP1 的全部"魔法"就是这段文本 ----
// EP0 里工具清单走 tools 参数、输出格式是 provider 训练进模型的;
// 现在这两件事都落回 prompt:清单自己渲染,格式自己规定。

const SYSTEM = `你是一个运行在用户终端里的助手,通过工具读写当前工作目录下的文件。
你没有联网能力;被问到需要联网的问题,直接在 Final Answer 里说明做不到。

可用工具:
${TOOLS.map(
  (t) => `- ${t.name}: ${t.description} 参数(JSON Schema): ${JSON.stringify(t.input_schema)}`,
).join("\n")}

严格按下面的格式输出,标签逐字照抄,不要输出格式之外的内容:

Thought: 对下一步做什么的简短思考
Action: 工具名,必须是上面列出的一个
Action Input: 工具参数,单行 JSON

Observation 一行由系统执行工具后填入,你绝对不要自己写这一行。
Thought/Action/Action Input/Observation 可以重复多次。
不需要工具、或任务已完成时,改为输出:

Thought: 我已经知道最终答案
Final Answer: 给用户的最终回复,用中文`;

// ---- 唯一的 API 调用:和 EP0 同一个接口,三处不同 ----
// 1. 不传 tools —— 模型对"原生工具调用"一无所知;
// 2. stop: ["\nObservation:"] —— 本课的机关,模型刚要编造工具结果就被服务端掐断;
// 3. temperature: 0 —— 论文用贪心解码,格式遵守率高得多(可改回默认感受区别)。

async function callModel(scratchpad) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      stop: ["\nObservation:"],
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: scratchpad },
      ],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content ?? "";
}

// ---- 解析:全部家当就是两个行首正则。模型不守格式,这里就抓空 ----

function parseAction(text) {
  const name = text.match(/^Action:\s*(.+)$/m);
  const input = text.match(/^Action Input:\s*(.+)$/m);
  return name && input ? { name: name[1].trim(), input: input[1].trim() } : null;
}

// ---- ReAct 循环:生成被掐断 → 解析 → 执行 → 拼回 Observation → 再生成 ----
// 对话状态就是一个不断变长的字符串(scratchpad),没有 messages 数组。
// 和 EP0 一样,每次都把全部历史重发一遍——API 本身从不记得你。

async function runTask(question) {
  let scratchpad = `Question: ${question}\n`;
  for (let step = 0; step < MAX_STEPS; step++) {
    const text = await callModel(scratchpad);
    console.log(`\n${text.trim()}`);
    scratchpad += text;
    if (/^Final Answer:/m.test(text)) return; // 轨迹原文已打印,任务结束
    const call = parseAction(text);
    let observation;
    if (!call) {
      // 2022 年的错误处理:把"你格式错了"当 Observation 塞回去,让模型重来
      observation = "无法解析。请严格按格式输出 Action 和 Action Input,或输出 Final Answer。";
    } else {
      try {
        const tool = TOOLS.find((t) => t.name === call.name);
        if (!tool) throw new Error(`没有名为 ${call.name} 的工具`);
        // Action Input 是模型生成的一行文本,和 EP0 的 arguments 一样要自己 parse
        observation = String(tool.run(JSON.parse(call.input)));
      } catch (err) {
        observation = String(err); // 工具失败是数据,喂给模型——和 EP0 同一条哲学
      }
    }
    console.log(`\nObservation: ${observation}`);
    scratchpad += `\nObservation: ${observation}\n`;
  }
  console.log(`\n[中止] ${MAX_STEPS} 步内没有给出 Final Answer`);
}

// ---- REPL:一行 = 一个独立任务,轨迹从零开始,没有跨轮记忆 ----
// ReAct 是任务式而不是聊天式;对话记忆是后来 chat 时代补上的东西。

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("close", () => process.exit(0));
console.log(`模型:${MODEL}(Ctrl-C 退出;每个问题是独立任务,无跨轮记忆)`);
while (true) {
  const line = (await rl.question("\n你: ")).trim();
  if (!line) continue;
  try {
    await runTask(line);
  } catch (err) {
    console.error(`\n[error] ${err.message}`);
  }
}
