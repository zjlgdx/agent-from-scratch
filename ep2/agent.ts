// EP2:issue loop —— 从 issues.md 逐条取 open issue,起一个 agent 会话修 target/ 里的代码,
// 再由本脚本(不是 agent)跑检查脚本验证,FAIL 数变少才标记 [x]。
// 运行(在 ep2/ 目录):node --env-file=../.env agent.ts

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const base = modelRuntime.getModel(process.env.LLM_PROVIDER ?? "groq", process.env.LLM_MODEL ?? "openai/gpt-oss-120b");
if (!base) {
  console.error("模型不在注册表里,或者没配对应的 API key(先跑 hello.ts 看可用模型)");
  process.exit(1);
}
// 同 hello.ts:免费档 TPM 按"输入 + maxTokens"每分钟累计,输出预算必须压小,
// 否则一个 issue 的几轮工具调用就烧穿 8k 限额。
const model = { ...base, maxTokens: 512 };

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TODO = "- [ ] ";

// 裁判：跑检查脚本，数 FAIL 行。宿主只认这个数字，不认 agent 说"修好了"。
function runChecks(): { out: string; failed: number } {
  const out = execSync("node target/app.ts", { encoding: "utf8" });
  return { out, failed: (out.match(/^FAIL/gm) ?? []).length };
}

function nextIssue(): string | null {
  const line = readFileSync("issues.md", "utf8")
    .split("\n")
    .find((l) => l.startsWith(TODO));
  return line ? line.slice(TODO.length) : null;
}

function markDone(issue: string): void {
  const md = readFileSync("issues.md", "utf8");
  writeFileSync("issues.md", md.replace(TODO + issue, "- [x] " + issue));
}

// 每个 issue 一个全新会话。pi 不抛 API 错误,得自己盯 stopReason。
async function fixIssue(issue: string): Promise<boolean> {
  const { session } = await createAgentSession({
    model,
    thinkingLevel: "low",
    tools: ["read", "edit"], // 不给 bash:验证归主循环管,agent 只负责改代码
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

let issue: string | null;
while ((issue = nextIssue())) {
  console.log(`\n=== 修:${issue} ===`);
  const before = runChecks().failed;
  let ok = await fixIssue(issue);
  if (!ok) {
    console.log("… 等 65 秒让限流窗口过去,重试一次");
    await sleep(65_000);
    ok = await fixIssue(issue);
  }
  if (!ok) {
    console.error("重试仍失败,停下来人工看看。");
    process.exit(1);
  }
  console.log("\n[验证] node target/app.ts");
  const { out, failed: after } = runChecks();
  console.log(out);
  // 一个 issue 修完不可能全绿(别的 bug 还在),裁判标准是 FAIL 数必须变少;没变少就不打勾
  if (after >= before) {
    console.error(`[验证] FAIL ${before} -> ${after},没有变少。不打勾,停下来人工看看。`);
    process.exit(1);
  }
  console.log(`[验证] FAIL ${before} -> ${after},打勾`);
  markDone(issue);
  if (nextIssue()) await sleep(65_000); // 免费档的节奏:一分钟修一个 issue
}
console.log("issues.md 里没有 open issue 了。");
