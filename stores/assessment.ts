import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";
export type AllocationStatus = "待同步" | "已确认" | "待调整";

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

export interface Shelter {
  id: string;
  name: string;
  community: string;
  capacity: number;
}

export interface Allocation {
  id: string;
  /** 幂等键：同一份申请重连回传不重复占床位 */
  clientUuid: string;
  householdId: string;
  shelterId: string;
  /** 占用床位人数 */
  people: number;
  status: AllocationStatus;
  /** 设备顺序号：离线排队的先后，合并时先排的先算数 */
  seq: number;
  submittedAt: string;
  confirmedAt?: string;
  /** 待调整时超出核定容量的人数 */
  overCount?: number;
  taskId?: string;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
  allocationId?: string;
}

export interface PendingChange {
  id: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
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
  { id: "s1", name: "河湾安置点", community: "河湾社区", capacity: 6 },
  { id: "s2", name: "新城安置点", community: "新城社区", capacity: 12 }
];
const seedAllocations: Allocation[] = [
  { id: "a1", clientUuid: "seed-a1", householdId: "h1", shelterId: "s1", people: 4, status: "已确认", seq: 1, submittedAt: new Date(Date.now() - 60 * 60000).toISOString(), confirmedAt: new Date(Date.now() - 55 * 60000).toISOString() },
  { id: "a2", clientUuid: "seed-a2", householdId: "h2", shelterId: "s2", people: 2, status: "已确认", seq: 2, submittedAt: new Date(Date.now() - 50 * 60000).toISOString(), confirmedAt: new Date(Date.now() - 45 * 60000).toISOString() },
  { id: "a3", clientUuid: "seed-a3", householdId: "h3", shelterId: "s1", people: 4, status: "待同步", seq: 3, submittedAt: new Date().toISOString() }
];

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = typeof window !== "undefined" && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
  const households = ref<Household[]>(initial?.households ?? seedHouseholds);
  const tasks = ref<FieldTask[]>(initial?.tasks ?? seedTasks);
  const queue = ref<PendingChange[]>(initial?.queue ?? []);
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  const shelters = ref<Shelter[]>(initial?.shelters ?? seedShelters);
  const allocations = ref<Allocation[]>(initial?.allocations ?? seedAllocations);
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

  /** 待同步队列：按设备顺序号排列，先排的先算数 */
  const pendingAllocations = computed(() =>
    allocations.value
      .filter((item) => item.status === "待同步")
      .sort((a, b) => a.seq - b.seq)
  );

  /** 待调整名单：超核定容量，不占正式床位，等负责人处理 */
  const adjustingAllocations = computed(() =>
    allocations.value
      .filter((item) => item.status === "待调整")
      .sort((a, b) => a.seq - b.seq)
  );

  function householdById(id: string) {
    return households.value.find((item) => item.id === id);
  }

  function shelterById(id: string) {
    return shelters.value.find((item) => item.id === id);
  }

  /** 某安置点已确认占用的床位数（正式名单才占床位） */
  function confirmedOccupancy(shelterId: string) {
    return allocations.value
      .filter((item) => item.shelterId === shelterId && item.status === "已确认")
      .reduce((sum, item) => sum + item.people, 0);
  }

  function shelterStats(shelterId: string) {
    const shelter = shelterById(shelterId);
    const confirmed = allocations.value
      .filter((item) => item.shelterId === shelterId && item.status === "已确认")
      .sort((a, b) => (a.confirmedAt ?? "").localeCompare(b.confirmedAt ?? ""));
    const adjusting = allocations.value
      .filter((item) => item.shelterId === shelterId && item.status === "待调整")
      .sort((a, b) => a.seq - b.seq);
    const pendingCount = allocations.value.filter((item) => item.shelterId === shelterId && item.status === "待同步").length;
    const occupied = confirmed.reduce((sum, item) => sum + item.people, 0);
    return {
      shelter,
      capacity: shelter?.capacity ?? 0,
      confirmed,
      adjusting,
      pendingCount,
      occupied,
      available: Math.max(0, (shelter?.capacity ?? 0) - occupied)
    };
  }

  function enqueue(entity: string, action: string, detail: string) {
    queue.value.unshift({ id: crypto.randomUUID(), entity, action, detail, time: new Date().toISOString() });
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

  function nextSeq() {
    return allocations.value.reduce((max, item) => Math.max(max, item.seq), 0) + 1;
  }

  /** 离线排入待同步队列：带设备顺序号，联网后按提交先后合并 */
  function addAllocation(input: { householdId: string; shelterId: string; people: number }) {
    const household = householdById(input.householdId);
    const shelter = shelterById(input.shelterId);
    if (!household || !shelter) return;
    // 幂等：同一家庭在同一安置点已有未确认申请，不重复排队、不重复占床位
    const dup = allocations.value.find(
      (item) => item.householdId === input.householdId && item.shelterId === input.shelterId && item.status !== "已确认"
    );
    if (dup) return dup;
    const allocation: Allocation = {
      id: crypto.randomUUID(),
      clientUuid: crypto.randomUUID(),
      householdId: input.householdId,
      shelterId: input.shelterId,
      people: input.people,
      status: "待同步",
      seq: nextSeq(),
      submittedAt: new Date().toISOString()
    };
    allocations.value.push(allocation);
    // 安置分配同时生成派工任务，接成家庭需求 → 安置分配 → 派工任务一条账
    const task: FieldTask = {
      id: crypto.randomUUID(),
      householdId: input.householdId,
      title: `安置入住对接 · ${shelter.name}`,
      assignee: "安置对接组",
      priority: household.needLevel,
      status: "待接收",
      due: "2026-09-30 12:00",
      allocationId: allocation.id
    };
    tasks.value.unshift(task);
    allocation.taskId = task.id;
    if (household.status !== "已完成") household.status = "已分派";
    enqueue("安置分配", "离线排入", `${household.head} → ${shelter.name}（${input.people}人，序号 ${allocation.seq}）`);
    return allocation;
  }

  /**
   * 单步合并：按设备顺序处理最早一条待同步申请，先排的先算数。
   * 不超容量 → 进正式名单；超容量 → 转待调整并写明超出人数，不占床位。
   */
  function syncStep(): "confirmed" | "adjusted" | "done" | "offline" {
    if (!online.value) return "offline";
    const item = pendingAllocations.value[0];
    if (!item) return "done";
    // 幂等：同一份回传已确认过，跳过，不重复占床位
    const already = allocations.value.some(
      (a) => a.clientUuid === item.clientUuid && a.status === "已确认" && a.id !== item.id
    );
    if (already) {
      allocations.value = allocations.value.filter((a) => a.id !== item.id);
      return "confirmed";
    }
    const shelter = shelterById(item.shelterId);
    const occ = confirmedOccupancy(item.shelterId);
    if (shelter && occ + item.people <= shelter.capacity) {
      item.status = "已确认";
      item.confirmedAt = new Date().toISOString();
      item.overCount = undefined;
    } else {
      item.status = "待调整";
      item.overCount = shelter ? occ + item.people - shelter.capacity : item.people;
    }
    return item.status === "已确认" ? "confirmed" : "adjusted";
  }

  /** 连续同步：中途断网可停，已确认的和没合完的都留着，重连只补做剩下的 */
  async function syncAll(): Promise<{ done?: boolean; interrupted?: boolean; steps: number }> {
    if (syncing.value) return { steps: 0 };
    syncing.value = true;
    let steps = 0;
    while (true) {
      if (!online.value) {
        syncing.value = false;
        return { interrupted: true, steps };
      }
      const result = syncStep();
      if (result === "done") {
        syncing.value = false;
        lastSyncedAt.value = new Date().toISOString();
        return { done: true, steps };
      }
      if (result === "offline") {
        syncing.value = false;
        return { interrupted: true, steps };
      }
      steps += 1;
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
  }

  /**
   * 核定床位变更：未确认分配按新容量重算（先排先得，能进正式名单的确认）；
   * 已确认的超员项退回待处理（最晚确认的先退）。
   */
  function changeCapacity(shelterId: string, newCapacity: number) {
    const shelter = shelterById(shelterId);
    if (!shelter || newCapacity < 0) return;
    shelter.capacity = newCapacity;
    let occ = confirmedOccupancy(shelterId);
    if (occ > newCapacity) {
      const confirmed = allocations.value
        .filter((item) => item.shelterId === shelterId && item.status === "已确认")
        // 最晚确认的先退；确认次序与设备顺序一致，时间戳相同时按序号兜底
        .sort((a, b) => (b.confirmedAt ?? b.submittedAt).localeCompare(a.confirmedAt ?? a.submittedAt) || b.seq - a.seq);
      for (const item of confirmed) {
        if (occ <= newCapacity) break;
        item.status = "待同步";
        item.confirmedAt = undefined;
        item.overCount = undefined;
        occ -= item.people;
      }
    }
    recalcPending(shelterId);
    enqueue("安置点", "核定容量调整", `${shelter.name} → ${newCapacity} 床`);
  }

  /** 未确认分配按设备顺序重算：先排的先算数，不超容量的进正式名单 */
  function recalcPending(shelterId?: string) {
    const list = allocations.value
      .filter((item) => item.status === "待同步" || item.status === "待调整")
      .filter((item) => (shelterId ? item.shelterId === shelterId : true))
      .sort((a, b) => a.seq - b.seq);
    for (const item of list) {
      const shelter = shelterById(item.shelterId);
      if (!shelter) continue;
      const occ = confirmedOccupancy(item.shelterId);
      if (occ + item.people <= shelter.capacity) {
        item.status = "已确认";
        item.confirmedAt = new Date().toISOString();
        item.overCount = undefined;
      } else {
        item.status = "待调整";
        item.overCount = occ + item.people - shelter.capacity;
      }
    }
  }

  function cancelAllocation(id: string) {
    const item = allocations.value.find((a) => a.id === id);
    if (!item) return;
    const wasConfirmed = item.status === "已确认";
    allocations.value = allocations.value.filter((a) => a.id !== id);
    if (item.taskId) tasks.value = tasks.value.filter((task) => task.id !== item.taskId);
    if (wasConfirmed) recalcPending(item.shelterId);
    enqueue("安置分配", "撤销", `申请 ${item.clientUuid.slice(0, 8)} 已撤销`);
  }

  function simulateSync() {
    syncing.value = true;
    const first = households.value[0];
    setTimeout(() => {
      if (first) conflicts.value.unshift({ id: crypto.randomUUID(), householdId: first.id, field: "address", localValue: first.address, remoteValue: "河湾路18号2栋2单元", status: "待处理" });
      lastSyncedAt.value = new Date().toISOString();
      queue.value = [];
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
    watch([households, tasks, queue, conflicts, shelters, allocations, lastSyncedAt], () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          households: households.value,
          tasks: tasks.value,
          queue: queue.value,
          conflicts: conflicts.value,
          shelters: shelters.value,
          allocations: allocations.value,
          lastSyncedAt: lastSyncedAt.value
        })
      );
    }, { deep: true });
  }

  return {
    households,
    tasks,
    queue,
    conflicts,
    shelters,
    allocations,
    online,
    lastSyncedAt,
    syncing,
    metrics,
    duplicates,
    pendingAllocations,
    adjustingAllocations,
    shelterStats,
    addHousehold,
    updateHousehold,
    mergeDuplicate,
    addTask,
    advanceTask,
    addAllocation,
    syncStep,
    syncAll,
    changeCapacity,
    recalcPending,
    cancelAllocation,
    simulateSync,
    resolveConflict,
    enqueue
  };
});
