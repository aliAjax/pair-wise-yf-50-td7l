// @ts-nocheck  离线规则验证脚本：npx vite-node test-occupancy.ts
import { createPinia, setActivePinia } from "pinia";
import { useAssessmentStore } from "./stores/assessment";

let passed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (!cond) { console.error(`FAIL: ${name} ${extra}`); process.exitCode = 1; }
  else { passed++; console.log(`ok - ${name}`); }
}

setActivePinia(createPinia());
const store = useAssessmentStore();

const s1 = () => store.shelters.find((s) => s.id === "s1")!;
const occ1 = () => store.shelterStats("s1").occupied;
const a3 = () => store.allocations.find((a) => a.id === "a3")!;

// 初始：s1 核定 6 床，a1 已确认占 4 床，a3 待同步 4 人
check("初始核定容量 6", s1().capacity === 6);
check("初始已占 4 床", occ1() === 4);
check("a3 待同步", a3().status === "待同步" && a3().seq === 3);

// 规则1：按设备顺序合并，先排先得；a3 需 4 人，4+4>6 → 待调整，超 2 人
let r = store.syncStep();
check("a3 超员时转为待调整", r === "adjusted" && a3().status === "待调整", `got ${r}`);
check("超出 2 人", a3().overCount === 2, `overCount=${a3().overCount}`);
check("待调整不占床位", occ1() === 4);

// 规则2：同一家庭同一安置点重复申请不排队、不占床位
const dup = store.addAllocation({ householdId: "h3", shelterId: "s1", people: 4 });
check("重复申请幂等去重", dup?.id === "a3");

// 规则3：容量调小到 3：已确认超员项退回（最晚确认的先退），未确认项按新容量重算
store.changeCapacity("s1", 3);
const a1 = () => store.allocations.find((a) => a.id === "a1")!;
check("容量调小后 a1 退回待处理并重算", ["待同步", "待调整"].includes(a1().status), a1().status);
check("容量调小后已占床位不超 3", occ1() <= 3, `occ=${occ1()}`);
check("退回项重算后写明超出人数", a1().status === "待调整" && a1().overCount === 1, `overCount=${a1().overCount}`);

// 规则4：容量调大到 10：未确认项按顺序重算，能进正式名单的确认
store.changeCapacity("s1", 10);
check("容量调大后 a1 重新确认", a1().status === "已确认", a1().status);
check("容量调大后 a3 重新确认", a3().status === "已确认", a3().status);
check("容量调大后占用 8 床", occ1() === 8, `occ=${occ1()}`);

// 规则5：断网续传——造两条新待同步，中途断网，已确认保留、剩余不丢
store.changeCapacity("s1", 6); // 回到 6 床：a1 留(4)，a3 退回
const x = store.addAllocation({ householdId: "h2", shelterId: "s1", people: 2 }); // seq 4
check("新申请 seq=4 待同步", x?.status === "待同步" && x.seq === 4);
store.online = false;
const syncPromise = store.syncAll();
setTimeout(async () => {
  const res = await syncPromise;
  check("断网时同步返回 interrupted", res.interrupted === true, JSON.stringify(res));
  check("断网时队列项保留", store.pendingAllocations.length >= 1);
  // 恢复连接后只补做剩下的
  store.online = true;
  const res2 = await store.syncAll();
  check("恢复后同步完成", res2.done === true, JSON.stringify(res2));
  check("恢复后队列清空", store.pendingAllocations.length === 0);
  check("恢复后占用不超容量", occ1() <= s1().capacity, `occ=${occ1()} cap=${s1().capacity}`);
  // 规则6：同一份回传不重复占床位——手动构造一条已确认项的重复回传，syncStep 跳过
  const confirmedOne = store.allocations.find((a) => a.status === "已确认")!;
  const fake = { ...confirmedOne, id: "fake-dup", status: "待同步" as const, confirmedAt: undefined, overCount: undefined };
  store.allocations.push(fake);
  const before = occ1();
  store.syncStep();
  check("重复回传不重复占床位（幂等）", occ1() === before, `before=${before} after=${occ1()}`);
  check("重复回传项被跳过", store.allocations.find((a) => a.id === "fake-dup") === undefined);
  console.log(`\n${passed} checks passed`);
}, 3000);
