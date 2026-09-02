#!/usr/bin/env node
// EP0 — 裸循环 agent:单文件、零依赖,直接 HTTP 调任意 OpenAI 兼容接口(LLM_BASE_URL/LLM_API_KEY/LLM_MODEL,默认 Groq)。
// 核心只有一件事:模型的回复里带 tool_calls,我们就本地执行,
// 把结果以 role:"tool" 消息塞回对话,再问它一次,直到它不再要工具。

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import readline from "node:readline/promises";

const API_KEY = process.env.LLM_API_KEY ?? process.env.GROQ_API_KEY;
if (!API_KEY) {
  console.error("请先设置 LLM_API_KEY(或 GROQ_API_KEY,在 console.groq.com/keys 免费注册),见根目录 .env.example");
  process.exit(1);
}
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1";
const MODEL = process.env.LLM_MODEL ?? "openai/gpt-oss-120b";

// ---- 工具 = 给模型看的 schema + 本地执行的函数,一一对应 ----
// 模型从头到尾只见过 name/description/parameters 这三样文本,
// 它"调用工具"只是按这个 schema 生成一段 JSON,真正干活的是这里的 run。

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

// ---- 唯一的 API 调用:POST /chat/completions,纯 HTTP,没有 SDK,谁家都一样 ----

async function callModel(messages) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      tools: TOOLS.map(({ name, description, input_schema }) => ({
        type: "function",
        function: { name, description, parameters: input_schema },
      })),
      messages,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---- agent 循环:一轮 = 反复调 API,直到模型不再要工具 ----

async function runTurn(messages) {
  while (true) {
    const reply = await callModel(messages);
    const msg = reply.choices[0].message;
    if (msg.content) console.log(`\nAI: ${msg.content}`);
    for (const call of msg.tool_calls ?? []) {
      console.log(`\n[tool] ${call.function.name} ${call.function.arguments}`);
    }
    // 模型的回复必须原样进历史——tool_calls 不能丢,后面的 role:"tool" 要和它的 id 配对
    messages.push({ ...msg, content: msg.content ?? "" }); // 唯一的改动:content 为 null 时补空串,Cloudflare 的兼容端点不收 null
    if (!msg.tool_calls?.length) return;
    // 一条回复里可能有多个 tool_call(并行调用),全部执行,每个结果单独一条 role:"tool" 消息
    for (const call of msg.tool_calls) {
      const tool = TOOLS.find((t) => t.name === call.function.name);
      let content;
      try {
        // 注意:arguments 是 JSON 字符串而不是对象,要自己 parse
        content = String(tool.run(JSON.parse(call.function.arguments)));
      } catch (err) {
        content = String(err); // 这套格式没有 is_error 标志,错误就是普通文本,模型自己看着办
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
}

// ---- REPL:读一行,跑一轮,直到 Ctrl-C / Ctrl-D ----

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("close", () => process.exit(0));
const messages = [
  {
    role: "system",
    content:
      "你是一个运行在用户终端里的编程助手,可以用工具读写当前目录下的文件。" +
      "你只能使用消息里列出的工具,没有联网能力;被问到需要联网的问题时,直接说明做不到即可。请用中文回复。",
  },
];
console.log(`模型:${MODEL}(Ctrl-C 退出)`);
while (true) {
  const line = (await rl.question("\n你: ")).trim();
  if (!line) continue;
  const mark = messages.length;
  messages.push({ role: "user", content: line });
  try {
    await runTurn(messages);
  } catch (err) {
    messages.length = mark; // 回滚这一轮,别让半截状态留在历史里
    console.error(`\n[error] ${err.message}`);
  }
}
