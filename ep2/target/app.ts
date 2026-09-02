// 检查脚本:跑一遍统计函数,和期望值对账。agent 不许改这个文件。
import { mean, median, range } from "./stats.ts";

const checks: Array<[string, number, number]> = [
  ["mean([1,2,3,4])", mean([1, 2, 3, 4]), 2.5],
  ["median([3,1,2])", median([3, 1, 2]), 2],
  ["median([1,2,3,4])", median([1, 2, 3, 4]), 2.5],
  ["range([1,5,3])", range([1, 5, 3]), 4],
];

let failed = 0;
for (const [name, got, want] of checks) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} = ${got}(期望 ${want})`);
}
console.log(failed ? `${failed} 个没过` : "全部通过");
