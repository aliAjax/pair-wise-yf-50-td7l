import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";

export interface Household {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  status: HouseholdStatus;
  version: number;
  deviceUpdatedAt: string;
  note: string;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
}

export interface PendingChange {
  id: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
  refId?: string;
}

export type AllocationStatus = "待同步" | "已确认" | "超员待调整";

export interface Shelter {
  id: string;
  name: string;
  location: string;
  capacity: number; // 核定床位
}

export interface Allocation {
  id: string; // 客户端生成，作为幂等键：同一份回传不会重复占床
  shelterId: string;
  householdId: string;
  beds: number;
  deviceId: string;
  deviceSeq: number; // 设备本地顺序号
  submittedAt: string;
  status: AllocationStatus;
  overflow: number; // 超员待调整时写明超出几人
  appliedSeq: number | null; // 合并顺序，先排的先算数
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: keyof Household;
  localValue: string;
  remoteValue: string;
  status: "待处理" | "采用本地" | "采用远端";
}

const KEY = "pair-wise-yf-50/assessment";
const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];
const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" }
];
const seedShelters: Shelter[] = [
  { id: "s1", name: "河湾中学安置点", location: "河湾路36号", capacity: 12 },
  { id: "s2", name: "新城体育馆安置点", location: "新城一街2号", capacity: 6 }
];
const seedAllocations: Allocation[] = [
  { id: "a1", shelterId: "s2", householdId: "h2", beds: 2, deviceId: "seed-device", deviceSeq: 1, submittedAt: new Date(Date.now() - 20 * 60000).toISOString(), status: "已确认", overflow: 0, appliedSeq: 1 }
];

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = typeof window !== "undefined" && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
  const households = ref<Household[]>(initial?.households ?? seedHouseholds);
  const tasks = ref<FieldTask[]>(initial?.tasks ?? seedTasks);
  const queue = ref<PendingChange[]>(initial?.queue ?? []);
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  const shelters = ref<Shelter[]>(initial?.shelters ?? seedShelters);
  const allocations = ref<Allocation[]>(initial?.allocations ?? seedAllocations);
  const syncedAllocationIds = ref<string[]>(initial?.syncedAllocationIds ?? seedAllocations.filter((item) => item.status !== "待同步").map((item) => item.id));
  const deviceId = ref<string>(initial?.deviceId ?? crypto.randomUUID());
  const deviceSeq = ref<number>(initial?.deviceSeq ?? 1);
  const mergeSeq = ref<number>(initial?.mergeSeq ?? 1);
  const syncNote = ref("");
  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: queue.value.length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function enqueue(entity: string, action: string, detail: string, refId?: string) {
    queue.value.unshift({ id: crypto.randomUUID(), entity, action, detail, time: new Date().toISOString(), refId });
  }

  function confirmedBeds(shelterId: string) {
    return allocations.value.filter((item) => item.shelterId === shelterId && item.status === "已确认").reduce((sum, item) => sum + item.beds, 0);
  }

  function waitingBeds(shelterId: string) {
    return allocations.value.filter((item) => item.shelterId === shelterId && item.status === "超员待调整").reduce((sum, item) => sum + item.beds, 0);
  }

  const shelterLedger = computed(() => shelters.value.map((shelter) => {
    const list = allocations.value.filter((item) => item.shelterId === shelter.id);
    const waiting = list.filter((item) => item.status === "超员待调整");
    return {
      ...shelter,
      confirmed: confirmedBeds(shelter.id),
      waitingCount: waiting.length,
      overflowTotal: waiting.reduce((max, item) => Math.max(max, item.overflow), 0),
      queuedCount: list.filter((item) => item.status === "待同步").length,
      usage: shelter.capacity > 0 ? Math.min(100, Math.round((confirmedBeds(shelter.id) / shelter.capacity) * 100)) : 100
    };
  }));

  function addAllocation(input: { shelterId: string; householdId: string; beds: number }) {
    const shelter = shelters.value.find((item) => item.id === input.shelterId);
    const household = households.value.find((item) => item.id === input.householdId);
    if (!shelter || !household || input.beds < 1) return;
    allocations.value.unshift({ ...input, id: crypto.randomUUID(), deviceId: deviceId.value, deviceSeq: ++deviceSeq.value, submittedAt: new Date().toISOString(), status: "待同步", overflow: 0, appliedSeq: null });
    enqueue("安置分配", "新增", `${shelter.name} / ${household.head} ${input.beds}床`, allocations.value[0].id);
  }

  function removeAllocation(id: string) {
    const allocation = allocations.value.find((item) => item.id === id);
    if (!allocation) return;
    const household = households.value.find((item) => item.id === allocation.householdId);
    allocations.value = allocations.value.filter((item) => item.id !== id);
    queue.value = queue.value.filter((item) => item.refId !== id);
    enqueue("安置分配", "移出", household?.head ?? id);
  }

  // 联网合并：按提交先后逐条入账，先排的先算数；超核定容量的转入超员待调整并写明超出几人。
  // 中途断网直接停，已确认的保留、没合完的留在队列，重连后只补做剩下的；幂等键保证同一份回传不重复占床。
  async function syncAllocations() {
    if (syncing.value) return;
    syncing.value = true;
    try {
      const pending = allocations.value
        .filter((item) => item.status === "待同步")
        .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.deviceSeq - b.deviceSeq);
      let merged = 0;
      for (const allocation of pending) {
        if (!online.value) {
          syncNote.value = `同步中断：已合并 ${merged} 条，剩余 ${pending.length - merged} 条留在队列，重连后只补做剩下的。`;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 260));
        if (!online.value) { // 传输中途断网：本条不算入，留在队列等重连补做
          syncNote.value = `同步中断：已合并 ${merged} 条，剩余 ${pending.length - merged} 条留在队列，重连后只补做剩下的。`;
          return;
        }
        if (syncedAllocationIds.value.includes(allocation.id)) continue;
        const shelter = shelters.value.find((item) => item.id === allocation.shelterId);
        if (!shelter) continue;
        // 已确认 + 排队等待的床位都算在账上：排在后面的不能插队
        const used = confirmedBeds(shelter.id) + waitingBeds(shelter.id);
        if (used + allocation.beds <= shelter.capacity) {
          allocation.status = "已确认";
          allocation.overflow = 0;
        } else {
          allocation.status = "超员待调整";
          allocation.overflow = used + allocation.beds - shelter.capacity;
        }
        allocation.appliedSeq = ++mergeSeq.value;
        syncedAllocationIds.value.push(allocation.id);
        queue.value = queue.value.filter((item) => item.refId !== allocation.id);
        merged += 1;
      }
      lastSyncedAt.value = new Date().toISOString();
      syncNote.value = merged ? `已按提交先后合并 ${merged} 条安置分配。` : "没有待合并的安置分配。";
    } finally {
      syncing.value = false;
    }
  }

  function setShelterCapacity(shelterId: string, capacity: number) {
    const shelter = shelters.value.find((item) => item.id === shelterId);
    if (!shelter || !Number.isFinite(capacity) || capacity < 0 || capacity === shelter.capacity) return;
    shelter.capacity = Math.floor(capacity);
    recalcShelter(shelterId);
    enqueue("安置点", "核定床位调整", `${shelter.name} → ${shelter.capacity}床`);
  }

  // 核定床位变化后按合并顺序重算：没确认的按新容量重算，装不下的已确认项退回待处理；
  // 超出人数按排队顺序累计，排在前面的没着落，后面的不能插队
  function recalcShelter(shelterId: string) {
    const shelter = shelters.value.find((item) => item.id === shelterId);
    if (!shelter) return;
    const merged = allocations.value
      .filter((item) => item.shelterId === shelterId && item.status !== "待同步")
      .sort((a, b) => (a.appliedSeq ?? 0) - (b.appliedSeq ?? 0));
    let used = 0;
    let waiting = 0;
    for (const allocation of merged) {
      if (waiting === 0 && used + allocation.beds <= shelter.capacity) {
        allocation.status = "已确认";
        allocation.overflow = 0;
        used += allocation.beds;
      } else {
        allocation.status = "超员待调整";
        allocation.overflow = used + waiting + allocation.beds - shelter.capacity;
        waiting += allocation.beds;
      }
    }
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt">) {
    households.value.unshift({ ...input, id: crypto.randomUUID(), status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString() });
    enqueue("家庭需求记录", "新增", input.head);
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: new Date().toISOString() });
    enqueue("家庭需求记录", "修改", `${household.head}：${Object.keys(patch).join("、")}`);
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;
    target.needs = Array.from(new Set([...target.needs, ...source.needs]));
    target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    target.note = `${target.note}；已合并重复记录 ${source.address}`;
    target.version += 1;
    households.value = households.value.filter((item) => item.id !== sourceId);
    enqueue("重复记录", "合并", `${source.head} → ${target.address}`);
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    tasks.value.unshift({ ...input, id: crypto.randomUUID(), status: "待接收" });
    const household = households.value.find((item) => item.id === input.householdId);
    if (household && household.status !== "已完成") household.status = "已分派";
    enqueue("任务", "分派", `${input.title} / ${input.assignee}`);
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return;
    task.status = task.status === "待接收" ? "进行中" : "已完成";
    if (task.status === "已完成") {
      const open = tasks.value.some((item) => item.householdId === task.householdId && item.status !== "已完成");
      const household = households.value.find((item) => item.id === task.householdId);
      if (household && !open) household.status = "已完成";
    }
    enqueue("任务", "状态流转", `${task.title} → ${task.status}`);
  }

  function simulateSync() {
    syncing.value = true;
    const first = households.value[0];
    setTimeout(() => {
      if (first) conflicts.value.unshift({ id: crypto.randomUUID(), householdId: first.id, field: "address", localValue: first.address, remoteValue: "河湾路18号2栋2单元", status: "待处理" });
      lastSyncedAt.value = new Date().toISOString();
      queue.value = queue.value.filter((item) => item.entity.startsWith("安置"));
      syncing.value = false;
    }, 650);
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict) return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    if (household && resolution === "采用远端") (household as unknown as Record<string, unknown>)[conflict.field] = conflict.remoteValue;
    conflict.status = resolution;
    if (household) household.version += 1;
  }

  if (typeof window !== "undefined") {
    watch([households, tasks, queue, conflicts, lastSyncedAt, shelters, allocations, syncedAllocationIds, deviceSeq, mergeSeq], () => {
      localStorage.setItem(KEY, JSON.stringify({ households: households.value, tasks: tasks.value, queue: queue.value, conflicts: conflicts.value, lastSyncedAt: lastSyncedAt.value, shelters: shelters.value, allocations: allocations.value, syncedAllocationIds: syncedAllocationIds.value, deviceId: deviceId.value, deviceSeq: deviceSeq.value, mergeSeq: mergeSeq.value }));
    }, { deep: true });
  }

  return { households, tasks, queue, conflicts, shelters, allocations, shelterLedger, syncNote, online, lastSyncedAt, syncing, metrics, duplicates, addHousehold, updateHousehold, mergeDuplicate, addTask, advanceTask, simulateSync, resolveConflict, enqueue, addAllocation, removeAllocation, syncAllocations, setShelterCapacity };
});
