// EP2 第一步:用 pi 的 SDK 起一个最小 agent 会话,看它替我们做了 EP0/EP1 手写的哪些事。
// 运行(在 ep2/ 目录):node --env-file=../.env hello.ts

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
// llama-3.3-70b 免费档 TPM 更高(12k vs 8k)但工具调用格式老出错(Groq 报 failed_generation);
// gpt-oss-120b 是为工具调用设计的,稳定性优先。
// 换提供商:LLM_PROVIDER=cerebras|cloudflare-workers-ai|nvidia|openrouter…(pi 自带),配对应的 *_API_KEY,见根目录 .env.example
const model = modelRuntime.getModel(process.env.LLM_PROVIDER ?? "groq", process.env.LLM_MODEL ?? "openai/gpt-oss-120b");
if (!model) {
  console.error("pi 的模型注册表里没有这个 id。当前有 key 可用的模型:");
  for (const m of await modelRuntime.getAvailable()) {
    console.error(`  ${m.provider}/${m.id}`);
  }
  process.exit(1);
}

// 不关掉自动发现的话,pi 会把本机所有 skills/extensions/context files 塞进系统提示词
// (这台机器上是 31 个 skill,一次请求 38k tokens),直接超出 Groq 免费档 8k TPM 的限制。
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  noSkills: true,
  noExtensions: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();

// Groq 免费档限流按"输入 + max_tokens"计算请求量,且 TPM 是每分钟累计:
// agent 每轮工具调用都重发全部上下文。模型默认 maxTokens=32768 一发就超 8k TPM,
// 压到 1024 才够跑一个几轮的循环。
const { session } = await createAgentSession({
  model: { ...model, maxTokens: 1024 },
  thinkingLevel: "low", // gpt-oss 的推理 token 也占输出预算,压低
  tools: ["read"], // 只给读文件;给了 bash 它会 ls -R 把 node_modules 灌进上下文,一轮就爆 TPM
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(), // 会话只存内存,不往 ~/.pi 落盘
});

try {
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      console.log(`\n[工具] ${event.toolName} ${JSON.stringify(event.args)}`);
    }
    if (event.type === "tool_execution_end") {
      console.log(event.isError ? "[工具] 出错" : "[工具] 完成");
    }
    // pi 不抛 API 错误,只把它记在消息的 stopReason/errorMessage 里;不打出来就是静默失败
    if (event.type === "message_end" && event.message.stopReason === "error") {
      console.error("\n[API 错误]", event.message.errorMessage);
    }
  });

  await session.prompt("读一下 package.json,用一句话告诉我这个项目依赖了什么。");
  console.log();
} finally {
  session.dispose();
}
