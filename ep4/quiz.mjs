#!/usr/bin/env node

/**
 * EP4: 《从零手写 Agent》十个我曾经答不上来的问题 —— 自测试验台
 * 零依赖，纯 Node.js 原生运行。十道题和 ep4/notes.md 的 Q1～Q10 一一对应，
 * "代码溯源"里的 questions.md #n 指根目录错题本的编号。
 *
 * 运行方式:
 *   node quiz.mjs
 */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const QUESTIONS = [
  {
    id: 1,
    topic: "Wire Format 契约",
    q: "模型返回带 tool_calls 的 assistant 消息，为什么必须原样塞回 messages？如果只塞工具结果，会发生什么？",
    options: [
      "A. 没有任何影响，模型可以直接理解孤立的 tool 结果",
      "B. 破坏了消息配对契约（每条 tool 结果要对应到前一条 assistant 的 tool_calls）：严格校验的服务端直接 400；不校验的服务端放行，但模型看不到自己调过工具，会重复调用",
      "C. 模型会自动在本地缓存中补齐上一次的 assistant 消息",
    ],
    answer: "B",
    explain:
      "OpenAI 协议规范要求每条 role: 'tool' 消息通过 tool_call_id 对应到前一条 assistant.tool_calls 里的某个调用，一批结果补齐后才能继续。实测两种后果都撞过：gpt-oss-120b 在模板渲染阶段直接 400；llama-3.3-70b 在 Groq 上没被拦，同一个文件连写三遍，直到输出畸形才 400。",
    source: "ep0/agent.mjs:95 & questions.md #1",
  },
  {
    id: 2,
    topic: "多工具并发调度",
    q: "一条回复里同时出现两个 tool_call（如 write_file 与 list_files），两个执行结果怎么和各自的调用对上号？",
    options: [
      "A. 靠工具在数组里的先后顺序（Index 下标）自动对应",
      "B. 靠每个 tool_call 自带的唯一标识 tool_call_id 进行严格配对",
      "C. 靠工具的函数名称（name）进行匹配",
    ],
    answer: "B",
    explain:
      "一条回复里的多个工具调用是并行的，每个调用都分配一个唯一的 tool_call_id（如 call_abc123）。返回结果时必须把 tool_call_id 原样带回 role: 'tool' 消息中，每个结果单独一条。",
    source: "ep0/agent.mjs:107 & questions.md #2",
  },
  {
    id: 3,
    topic: "两层错误与事务回滚",
    q: "工具执行报错（如 ENOENT）和 API 报错（如 400/500），两者的处理路径为什么完全不同？",
    options: [
      "A. 两者都应该把错误塞进 messages 数组让模型看",
      "B. 工具错误由内层 catch 捕获（是数据），塞回 messages 继续循环；API 错误内层不捕获、一路抛到外层 catch（是事务失败），必须整轮回滚（messages.length = mark）防止半截孤儿消息污染历史",
      "C. 两者都会直接导致 Agent 崩溃并清除所有对话",
    ],
    answer: "B",
    explain:
      "内层 catch（工具执行）把错误文本当普通 tool 消息塞回，OpenAI 格式没有 is_error 标志位（Anthropic 格式有），模型靠阅读文本决定下一步。外层 catch（API 边界）没法把错误告诉模型，因为告诉它恰恰需要一次成功的 API 调用，唯一干净的出路是回滚本轮。",
    source: "ep0/agent.mjs:105 & 128 & ep3/agent.mjs:212 & 341 & questions.md #3 #6",
  },
  {
    id: 4,
    topic: "Tool Call 的本质与调用计数",
    q: "我们从没在工具列表里定义过 brave_search，模型为什么能编出格式标准的调用？这说明了什么？",
    options: [
      "A. 模型内置了隐藏的联网模块",
      "B. 说明 Tool Call 本质上只是模型按 schema 续写生成的纯文本，模型没有内置执行力，所有动作全靠外部宿主",
      "C. API 服务端自动注入了默认搜索引擎",
    ],
    answer: "B",
    explain:
      "Tool call 不是什么神秘的远程过程调用（RPC）协议，本质只是模型在预训练或微调中学会了按特定 JSON/XML 语法输出文本，训练语料里见过 brave_search 这类名字就能凭空生成。真正的能力永远在外部宿主环境中。顺带一道计数题：用户问一句话，底层至少 1 次 API 调用，每执行完一批工具再加 1 次，直到模型不再返回工具调用（finish_reason 为 'stop'）。",
    source: "ep0/agent.mjs:87-109 & ep0 笔记「实验一」「实验二」& questions.md #4 #5",
  },
  {
    id: 5,
    topic: "ReAct 纯文本机制",
    q: "2022 年没有原生 tool_calls 时，ReAct 是如何防止模型把工具假结果直接自己编造输出下去的？",
    options: [
      "A. 靠模型自觉遵守 System Prompt 的约束",
      "B. 在 API 请求中配置 stop: ['\\nObservation:']，让模型在刚要输出观察结果的瞬间被服务端掐断，交由宿主执行",
      "C. 在本地用多线程强制 kill 模型的生成进程",
    ],
    answer: "B",
    explain:
      "早期模型（如 text-davinci-002）没有函数调用接口，必须通过 Stop Token（停止序列）在 Action Input 之后把控制权强行夺回宿主，执行完工具后再由宿主把真实 Observation 拼入 prompt。去掉 stop，llama-3.3-70b 会一口气把 Observation 和 Final Answer 都演完，文件根本不会落盘；2026 年的 gpt-oss-120b、qwen3.8 没有 stop 也会自己停，但闸门必须留在宿主手里，不能建立在模型会听话上。",
    source: "ep1/agent.mjs:103 & ep1 笔记「实验二」& questions.md #8",
  },
  {
    id: 6,
    topic: "会话生命周期",
    q: "批量跑任务队列时，为什么每个 issue 都要 createAgentSession 开一个全新会话，而不是丢进一个对话里一跑到底？",
    options: [
      "A. 因为 SDK 强制要求每次 prompt 之前都新建会话",
      "B. 防止上一个 issue 的代码和报错污染下一个的判断；防止历史越滚越长撞穿 TPM；给每个 issue 独立的失败与重试边界",
      "C. 因为短会话计费更便宜，纯粹是省钱",
    ],
    answer: "B",
    explain:
      "会话不隔离，到第三个 issue 时上下文早就脏了，而且每次请求都要重发前几个 issue 的全部历史，几轮就把免费档 TPM 撑爆。隔离之后单个 issue 的死循环或失败也不会殃及下一个。",
    source: "ep2/agent.ts:60 & questions.md #9",
  },
  {
    id: 7,
    topic: "安全沙箱与防御边界",
    q: "如果模型在参数里传入 path: '../../etc/passwd'，为什么说“模型碰不到执行层”并不足以保证安全？",
    options: [
      "A. 因为模型生成文本时可能受提示词注入或幻觉影响，不能信任模型做合规判断；宿主必须在执行前做路径规范化与沙箱拦截，而且要拿 ../ 实际去试",
      "B. 因为操作系统会自动禁止 Node.js 读取上级目录",
      "C. 只有在生产 Linux 服务器上才需要沙箱，本地开发环境无需防护",
    ],
    answer: "A",
    explain:
      "模型输出的任何参数都是未受信任的外部输入。EP3 的 resolveSafePath 第一版用 startsWith 比前缀，../target-backup/x 能穿过去，改用 path.relative 才堵上；bash 工具只设了 cwd，根本没有沙箱。宿主自己也会写错，护栏要实际拿越界输入去试。",
    source: "ep3/agent.mjs:27 & 97 & questions.md #7",
  },
  {
    id: 8,
    topic: "上下文修剪 vs 消息删除",
    q: "为什么在长会话中防止 Token 爆仓不能简单粗暴地用 splice 删掉旧消息？正确的 Pruning 怎么做？",
    options: [
      "A. 可以随意删除，模型没有任何记忆依赖",
      "B. 直接删除会破坏 assistant.tool_calls 与 tool 的成对契约导致 400；正确做法是保留骨架（role 和 id），仅将庞大的 content 替换为极简占位符",
      "C. 应该在每次调用前重新创建一个只有 system prompt 的新会话",
    ],
    answer: "B",
    explain:
      "保契约，瘦内容。Pruning 在保留消息结构合法性的同时压缩旧工具输出占的 Token。代价是原地改写历史会让服务端前缀缓存失效，所以只在超预算时做一次。",
    source: "ep3/agent.mjs:156 & questions.md #10",
  },
  {
    id: 9,
    topic: "Checkpoint 调度机制",
    q: "Steer（中途插话纠偏）和 FollowUp（顺手接力）在 Checkpoint 调度中的核心区别是什么？为什么不能暴力打断？",
    options: [
      "A. Steer 在每个 Turn 开始前抢占注入，FollowUp 在任务全部完成停下来后消费；两者均只追加到尾部（Append-only）以保护服务端 KV Cache",
      "B. Steer 会直接清空所有历史消息，FollowUp 会覆盖上一条用户输入",
      "C. 两者完全相同，只是命名不同的别名",
    ],
    answer: "A",
    explain:
      "原地改写历史会破坏 KV Cache 导致缓存失效与延迟上升；通过在 Checkpoint 处以只追加方式注入不同优先级的指令，实现了灵活而高效的多级调度。Pi 的 harness 里对应的就是 steerQueue 和 followUpQueue，默认 one-at-a-time 排空。",
    source: "ep3/agent.mjs:227 & 252 & questions.md #11",
  },
  {
    id: 10,
    topic: "Harness 的本质",
    q: "从 EP0 的裸循环到 EP3 的多护栏系统，一直在说的 Runtime / Harness 到底是什么？一个 Agent 系统的本质构成是什么？",
    options: [
      "A. Agent = 更大的模型 + 更长的提示词",
      "B. Agent = LLM（文本生成器）+ Wire Format（对话协议）+ Harness（宿主控制工程：循环、工具执行、消息历史、错误处理、护栏与调度）",
      "C. Agent = 某个框架（LangChain 等）+ 向量数据库",
    ],
    answer: "B",
    explain:
      "EP0 结课时错题本里的第一版答案是：围绕模型调用的一整圈东西（循环、工具执行、消息历史、错误处理），ep0/agent.mjs 就是一个 136 行的极简 runtime。走到 EP3 这圈东西又长出了沙箱、修剪和 Checkpoint 调度，但本质没变：模型只负责生成文本，剩下的全是宿主。",
    source: "questions.md #0 & ep4 笔记「五、什么是 Harness」",
  },
];

async function runQuiz() {
  const rl = readline.createInterface({ input, output });

  console.log("\n=======================================================");
  console.log("  EP4: 《从零手写 Agent》十个我曾经答不上来的问题");
  console.log("  —— 10 问本质自测与代码溯源");
  console.log("=======================================================\n");

  let correctCount = 0;

  for (const item of QUESTIONS) {
    console.log(`\n-------------------------------------------------------`);
    console.log(`【第 ${item.id} 题】[${item.topic}]`);
    console.log(item.q);
    console.log("");
    for (const opt of item.options) {
      console.log(`  ${opt}`);
    }
    console.log("");

    const answer = (await rl.question("你的选择 (A/B/C，按回车直接看解析，q 退出): ")).trim().toUpperCase();

    if (answer === "Q") {
      console.log("\n已退出自测试验台。");
      rl.close();
      return;
    }

    if (answer === item.answer) {
      console.log("\n[正确]");
      correctCount++;
    } else if (answer === "") {
      console.log(`\n[答案] ${item.answer}`);
    } else {
      console.log(`\n[错误] 正确答案: ${item.answer}`);
    }

    console.log(`[核心原理] ${item.explain}`);
    console.log(`[代码溯源] ${item.source}`);
  }

  console.log("\n=======================================================");
  console.log(`自测完成！得分: ${correctCount} / ${QUESTIONS.length}`);
  console.log("=======================================================\n");

  rl.close();
}

runQuiz().catch(console.error);
