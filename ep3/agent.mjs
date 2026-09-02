import readline from "node:readline";
import { stdin, stdout } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// 和 EP0 一样只认 OpenAI 兼容协议:LLM_BASE_URL / LLM_API_KEY / LLM_MODEL,默认 Groq(见根目录 .env.example)
const API_KEY = process.env.LLM_API_KEY ?? process.env.GROQ_API_KEY;
if (!API_KEY) {
  console.error("请先设置 LLM_API_KEY(或 GROQ_API_KEY),见根目录 .env.example");
  process.exit(1);
}
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1";
const MODEL = process.env.LLM_MODEL ?? "openai/gpt-oss-120b";
const SANDBOX_DIR = path.resolve("./target");
const MAX_OUTPUT_LINES = 15;
const MAX_OUTPUT_CHARS = 800;
const CONTEXT_CHAR_LIMIT = 6000; // 模拟较紧凑的上下文预算，展示 Compaction

if (!fs.existsSync(SANDBOX_DIR)) {
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
}

// -------------------------------------------------------------
// 1. 护栏机制 1: 路径沙箱与输出熔断截断 (Tool Guardrails)
// -------------------------------------------------------------
function resolveSafePath(relPath = ".") {
  const targetPath = path.resolve(SANDBOX_DIR, relPath);
  // 不能用 startsWith 做前缀判断：../target-backup/x 解析出来同样以 .../target 开头。
  // 用 relative 看有没有跳出沙箱（Pi 的 read 工具用的是同一种写法）。
  const rel = path.relative(SANDBOX_DIR, targetPath);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`[Security Sandbox Violation] 禁止越界访问沙箱外部路径: ${relPath}`);
  }
  return targetPath;
}

function truncateOutput(text, maxLines = MAX_OUTPUT_LINES, maxChars = MAX_OUTPUT_CHARS) {
  const lines = text.split("\n");
  if (lines.length > maxLines || text.length > maxChars) {
    const sliced = lines.slice(0, maxLines).join("\n").slice(0, maxChars);
    return `${sliced}\n\n[Output Truncated: 已展示前 ${Math.min(lines.length, maxLines)}/${lines.length} 行 (${sliced.length}/${text.length} 字符)。避免上下文溢出。]`;
  }
  return text;
}

// replay 是我们自己加的标注，不是 OpenAI 协议字段，也不会发给 API（见 callModel）。
// 本课只把它打印出来；真正的 Harness 会在崩溃恢复/重试时读它：safe 的工具可以重跑，
// never 的工具只能补一条"已中断"的合成结果。
const tools = [
  {
    type: "function",
    replay: "safe", // 幂等只读：崩溃或重试时可安全重新执行
    function: {
      name: "read_file",
      description: "安全读取 target/ 目录下的文件，超大内容会自动截断",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对于 target/ 的文件路径" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    replay: "never", // 具副作用：崩溃后禁止盲目重跑，必须补合成中断记录
    function: {
      name: "write_file",
      description: "安全写入 target/ 目录下的文件",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对于 target/ 的文件路径" },
          content: { type: "string", description: "写入内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    replay: "safe",
    function: {
      name: "list_files",
      description: "安全列出 target/ 目录下的文件",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "子目录路径，默认根目录 ." },
        },
      },
    },
  },
  {
    // 注意：这个工具没有沙箱。它只是把工作目录设成 target/，cat ../../AGENTS.md 照样能读出来。
    // 留着它有两个用处：截断后模型可以用 sed/grep 分段读；读者可以亲手试出"cwd 不等于沙箱"。
    // Pi 的 bash 工具同样只设 cwd，真正的隔离要靠容器等外层手段。
    type: "function",
    replay: "never",
    function: {
      name: "bash",
      description: "在 target/ 工作目录下执行只读的检查命令（如 sed -n、grep、wc）",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
        },
        required: ["command"],
      },
    },
  },
];

async function executeTool(name, argsJson) {
  const toolDef = tools.find((t) => t.function.name === name);
  const replayMode = toolDef?.replay || "never";

  try {
    const args = JSON.parse(argsJson);
    console.log(`[tool execution] ${name} (replay: ${replayMode})`);

    if (name === "read_file") {
      const safePath = resolveSafePath(args.path);
      const content = fs.readFileSync(safePath, "utf-8");
      return truncateOutput(content);
    }
    if (name === "write_file") {
      const safePath = resolveSafePath(args.path);
      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      fs.writeFileSync(safePath, args.content, "utf-8");
      return `Successfully written ${args.content.length} chars to ${args.path}`;
    }
    if (name === "list_files") {
      const safePath = resolveSafePath(args.path || ".");
      const entries = fs.readdirSync(safePath, { withFileTypes: true });
      const list = entries.map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`).join("\n");
      return truncateOutput(list || "(empty directory)");
    }
    if (name === "bash") {
      const out = execSync(args.command, { cwd: SANDBOX_DIR, timeout: 5000, encoding: "utf-8" });
      return truncateOutput(out || "(empty output)");
    }
    return `[error] Unknown tool: ${name}`;
  } catch (err) {
    return `[Tool Error] ${err.message}`;
  }
}

// -------------------------------------------------------------
// 2. 护栏机制 2: 上下文治理与旧工具修剪 (Context Compaction)
// -------------------------------------------------------------
// 注意：修剪是原地改写历史，会让服务端的前缀缓存失效。这是有意的取舍：
// 只在上下文超过预算时才做一次，换来后面每一轮都更小的请求。
function pruneContext(messages) {
  let prunedCount = 0;
  // 保留最近 2 轮对话的完整 tool_result，将更早的 tool_result 裁剪为摘要
  // 关键：保留 tool_call_id 和消息骨架，避免破坏 API 校验格式！
  for (let i = 0; i < messages.length - 4; i++) {
    const msg = messages[i];
    if (msg.role === "tool" && msg.content && msg.content.length > 80) {
      msg.content = `[Pruned old tool result: ${msg.content.slice(0, 40)}... (historical)]`;
      prunedCount++;
    }
  }
  return prunedCount;
}

// -------------------------------------------------------------
// 3. 护栏机制 3: 检查点 (Checkpoint) 与多级队列 (Steer & FollowUp)
// -------------------------------------------------------------
const steeringQueue = []; // Steer: 当前 Run 的 Turn 之间立即插话纠偏
const followUpQueue = []; // FollowUp: 等当前任务自然完成后自动接力

function steer(instruction) {
  steeringQueue.push(instruction);
  console.log(`\n[Steer Enqueued] 中途干预指令已入队: "${instruction}"`);
}

function followUp(instruction) {
  followUpQueue.push(instruction);
  console.log(`\n[FollowUp Enqueued] 顺手接力任务已入队: "${instruction}"`);
}

async function callModel(messages, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        // replay 是本地标注，发给 API 前剥掉
        tools: tools.map(({ replay, ...t }) => t),
        temperature: 0.2,
        max_tokens: 512,
      }),
    });

    if (res.status === 429 && attempt < retries) {
      console.log(`[Rate Limit 429] 触发限流，等待 7 秒后自动重试 (第 ${attempt}/${retries} 次)...`);
      await new Promise((r) => setTimeout(r, 7000));
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    return data.choices[0].message;
  }
}

// 单次 Run 的执行循环，每个 Turn 前经过 Checkpoint
async function runHarnessTurn(messages) {
  let turnIndex = 0;
  while (true) {
    turnIndex++;

    // === CHECKPOINT 检查点 ===
    // 1. 消耗 Steering 队列（Append-only Context 保护）
    if (steeringQueue.length > 0) {
      while (steeringQueue.length > 0) {
        const injected = steeringQueue.shift();
        console.log(`\n[Checkpoint] 注入中途干预指令到尾部: "${injected}"`);
        messages.push({
          role: "user",
          content: `[Steering Notice / Human Interruption]: ${injected}`,
        });
      }
    }

    // 2. 检查上下文压力 (Compaction 检查)
    const contextSize = JSON.stringify(messages).length;
    if (contextSize > CONTEXT_CHAR_LIMIT) {
      const pruned = pruneContext(messages);
      console.log(`\n[Checkpoint] 触发 Context Pruning: 压缩了 ${pruned} 条旧工具结果 (历史体积: ${contextSize} 字符)`);
    }

    // === STEP: 调用模型 ===
    const msg = await callModel(messages);
    messages.push({ ...msg, content: msg.content ?? "" }); // 同 EP0:Cloudflare 兼容端点不收 content: null

    // 如果模型没有发起 tool_calls
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Checkpoint: 只有当 Tool 和 Steer 全部耗尽时，才消费 FollowUp 接力任务
      if (followUpQueue.length > 0) {
        const nextTask = followUpQueue.shift();
        console.log(`\nAI: ${msg.content || "(阶段完成)"}`);
        console.log(`\n[Checkpoint] 消费 FollowUp 接力任务: "${nextTask}"`);
        messages.push({
          role: "user",
          content: `[Follow-up Task]: ${nextTask}`,
        });
        continue; // 顺手接力开启下一阶段
      }

      console.log(`\nAI: ${msg.content || "(完成)"}\n`);
      break;
    }

    // === STEP: 执行 Tool Batch ===
    for (const call of msg.tool_calls) {
      console.log(`\n[tool] ${call.function.name} ${call.function.arguments}`);
      const result = await executeTool(call.function.name, call.function.arguments);
      console.log(`[result preview] ${result.split("\n")[0]}...`);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }

    // 模拟生产环境的断点干预：在多步循环中展示 Steering 机制
    if (turnIndex === 1 && process.env.DEMO_STEER) {
      steer("请不要继续详细分析了，直接给出一句话精简结论！");
    }
  }
}

// -------------------------------------------------------------
// REPL 交互入口
// -------------------------------------------------------------
// 不用 for await 逐行读：那样在 await runHarnessTurn 期间读不到输入，
// /steer 只能在两次 run 之间生效。改用 line 事件，模型跑的时候敲 /steer、/followup
// 会立刻入队，在下一个 Checkpoint 被消费——这才是"中途插话"。
const rl = readline.createInterface({ input: stdin, output: stdout, prompt: "你: " });

const systemPrompt = {
  role: "system",
  content:
    "你是一个在沙箱 target/ 目录中工作的助手。你可以读取、编写文件或列出目录。" +
    "遇到 [Steering Notice] 时必须立即调整策略并服从最新指示。" +
    "遇到 [Follow-up Task] 时作为新任务继续执行。",
};
const sessionMessages = [systemPrompt];
let busy = false;

console.log(`=================================================`);
console.log(`EP3 — 生产级 Harness 护栏与调度试验台 (模型: ${MODEL})`);
console.log(`沙箱根目录: ${SANDBOX_DIR}`);
console.log(`特色功能: 路径沙箱 | 输出熔断 | Checkpoint Steer & FollowUp | 上下文 Pruning`);
console.log(`指令: /steer <指令> (中途插话) | /followup <指令> (顺手接力)，模型跑的时候也可以敲`);
console.log(`=================================================\n`);

rl.on("close", () => process.exit(0));
rl.on("line", async (rawLine) => {
  const line = rawLine.trim();
  if (!line) {
    if (!busy) rl.prompt();
    return;
  }

  if (line.startsWith("/steer ")) {
    steer(line.slice(7).trim());
    if (!busy) rl.prompt();
    return;
  }
  if (line.startsWith("/followup ")) {
    followUp(line.slice(10).trim());
    if (!busy) rl.prompt();
    return;
  }
  if (busy) {
    console.log(`\n[busy] 当前任务还在跑，中途只接受 /steer 或 /followup`);
    return;
  }

  busy = true;
  const mark = sessionMessages.length;
  sessionMessages.push({ role: "user", content: line });

  try {
    await runHarnessTurn(sessionMessages);
  } catch (err) {
    sessionMessages.length = mark; // 事务失败回滚
    console.error(`\n[Harness Error] ${err.message}\n`);
  }

  busy = false;
  rl.prompt();
});

rl.prompt();
