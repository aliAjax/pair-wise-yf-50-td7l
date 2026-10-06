<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NInputNumber, NProgress, NSelect, NStatistic, NSwitch, NTag, useMessage } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore, type Household, type NeedLevel } from "~/stores/assessment";
import { probeCache } from "~/utils/api";

const store = useAssessmentStore();
const message = useMessage();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const syncMessage = ref("");
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.coerce.number().min(1).max(30), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: 1, needLevel: "一般" as NeedLevel, needs: "", note: "" } });
const [head] = defineField("head");
const [community] = defineField("community");
const [address] = defineField("address");
const [members] = defineField("members");
const [needLevel] = defineField("needLevel");
const [needs] = defineField("needs");
const [note] = defineField("note");
const selected = computed(() => store.households.find((item) => item.id === selectedId.value) ?? store.households[0]);
const taskAssignee = ref("救援一组");
const taskTitle = ref("现场复核");

// 安置分配表单
const allocForm = reactive<{ householdId: string; shelterId: string; people: number }>({
  householdId: store.households[0]?.id ?? "",
  shelterId: store.shelters[0]?.id ?? "",
  people: store.households[0]?.members ?? 1
});
const capDraft = reactive<Record<string, number>>({});

onMounted(async () => {
  cacheProbe.value = await probeCache();
  store.online = browserOnline.value;
  store.shelters.forEach((shelter) => { capDraft[shelter.id] = shelter.capacity; });
});

const householdOptions = computed(() =>
  store.households.map((item) => ({ label: `${item.head} · ${item.members}人 · ${item.community}`, value: item.id }))
);
const shelterOptions = computed(() =>
  store.shelters.map((item) => ({ label: `${item.name}（核定 ${item.capacity} 床）`, value: item.id }))
);
const pendingQueue = computed(() => store.pendingAllocations);

function householdName(id: string) {
  return store.households.find((item) => item.id === id)?.head ?? "—";
}
function shelterName(id: string) {
  return store.shelters.find((item) => item.id === id)?.name ?? "—";
}
function fmt(iso?: string) {
  return iso ? new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
}

const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });
  resetForm();
});
function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-09-30 18:00" });
}

function submitAllocation() {
  if (!allocForm.householdId || !allocForm.shelterId) return;
  const target = store.households.find((item) => item.id === allocForm.householdId);
  const allocation = store.addAllocation({ householdId: allocForm.householdId, shelterId: allocForm.shelterId, people: Number(allocForm.people) || target?.members || 1 });
  if (!allocation) {
    message.warning("该家庭在这个安置点已有未确认申请，不重复排队、不重复占床位");
    return;
  }
  syncMessage.value = "已离线排入待同步队列（设备顺序号已生成），联网后按提交先后合并，先排的先算数。";
  message.success("已排入待同步队列");
}

async function runSync() {
  if (!store.online) {
    syncMessage.value = "仍在弱网状态，队列保留在设备中，恢复连接后可接着合并。";
    return;
  }
  syncMessage.value = "正在按设备顺序合并离线分配…";
  const result = await store.syncAll();
  if (result.done) {
    syncMessage.value = `同步完成：本次合并 ${result.steps} 项，已确认安置全部入正式名单，超员项已转待调整。`;
    message.success("同步完成");
  } else if (result.interrupted) {
    syncMessage.value = `同步中途断网：已确认的 ${result.steps} 项已入账，剩余 ${store.pendingAllocations.length} 项留在队列，恢复连接后只补做剩下的。`;
    message.warning("同步中断，已确认内容已保留");
  }
}

function runStep() {
  const result = store.syncStep();
  if (result === "offline") syncMessage.value = "当前离线，队列保留在设备中，不占床位。";
  else if (result === "done") syncMessage.value = "待同步队列已全部合并。";
  else if (result === "confirmed") syncMessage.value = "已按顺序确认 1 项，正式名单床位已入账。";
  else syncMessage.value = "该项超出核定容量，未进正式名单，已转待调整并写明超出人数。";
}

function applyCapacity(shelterId: string) {
  const next = Number(capDraft[shelterId]);
  if (!Number.isFinite(next) || next < 0) return;
  store.changeCapacity(shelterId, next);
  syncMessage.value = `核定床位已调整为 ${next} 床：未确认分配已按新容量重算，已确认的超员项已退回待处理。`;
  message.info("容量变更已重算占用账");
}
</script>

<template>
  <div class="shell">
    <aside class="side"><div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div><nav><button v-for="item in ['需求记录', '安置占用', '任务分派', '同步队列', '冲突处理']" :key="item" :class="{ active: panel === item }" @click="panel = item">{{ item }} <span v-if="item === '同步队列' && store.pendingAllocations.length">({{ store.pendingAllocations.length }})</span></button></nav><div class="network"><small>设备与网络</small><b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b><NSwitch v-model:value="store.online" /><small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small></div></aside>
    <main>
      <header><div><small>评估批次 2026-09-29 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>家庭需求、安置分配与派工任务共用一本占用账；离线可排队，联网按顺序合并，超容量不进正式名单。</p></div><div class="status-chip"><NProgress type="circle" :percentage="100 - store.pendingAllocations.length * 8" :stroke-width="8" :width="42" /><span>{{ store.pendingAllocations.length ? `${store.pendingAllocations.length} 项待同步` : '数据已同步' }}</span></div></header>
      <section class="metrics"><NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard><NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard><NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard><NCard><NStatistic label="本地变更记录" :value="store.metrics.queued" /></NCard></section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。新增记录、安置分配与派工仍可离线操作，分配带设备顺序号写入待同步队列，恢复连接后按提交先后合并。</NAlert>

      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录" :bordered="false"><div class="households"><article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id"><div><b>{{ item.head }} · {{ item.members }}人</b><small>{{ item.community }} / {{ item.address }}</small><p>{{ item.needs.join('、') }} · {{ item.note }}</p></div><div><NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag><small>{{ item.status }} · v{{ item.version }}</small></div></article></div></NCard>
        <NCard title="新增需求记录"><form class="field-grid" @submit.prevent="submit"><label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label><label class="field"><span>社区</span><NInput v-model:value="community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="不使用地图坐标时可描述楼栋与单元" /><small>{{ errors.address }}</small></label><label class="field"><span>家庭人数</span><NInputNumber :value="members" :min="1" :max="30" @update:value="(v) => (members = v ?? 1)" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label><label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="panel = '安置占用'">去安置分配</NButton></div></form></NCard>
      </div>

      <div v-if="panel === '安置占用'" class="side-stack">
        <NCard title="安置点核定容量与占用账" :bordered="false">
          <div class="shelters">
            <article v-for="shelter in store.shelters" :key="shelter.id" class="shelter">
              <div class="shelter-head">
                <div><b>{{ shelter.name }}</b><small>{{ shelter.community }}</small></div>
                <NTag :type="store.shelterStats(shelter.id).available > 0 ? 'success' : 'error'">核定 {{ shelter.capacity }} 床</NTag>
              </div>
              <div class="shelter-cap">
                <span>已占 <b>{{ store.shelterStats(shelter.id).occupied }}</b> 床</span>
                <span>可用 <b>{{ store.shelterStats(shelter.id).available }}</b> 床</span>
                <small>待同步 {{ store.shelterStats(shelter.id).pendingCount }} · 待调整 {{ store.shelterStats(shelter.id).adjusting.length }}</small>
              </div>
              <NProgress type="line" :percentage="Math.min(100, store.shelterStats(shelter.id).capacity ? Math.round((store.shelterStats(shelter.id).occupied / store.shelterStats(shelter.id).capacity) * 100) : 0)" :stroke-width="10" :indicator-placement="'inside'" />
              <div class="cap-edit">
                <span>负责人调整核定床位</span>
                <NInputNumber v-model:value="capDraft[shelter.id]" :min="0" :max="300" size="small" />
                <NButton size="small" @click="applyCapacity(shelter.id)">重算占用账</NButton>
              </div>
              <div class="alloc-list">
                <small>正式名单（已确认，占床位）</small>
                <div v-for="item in store.shelterStats(shelter.id).confirmed" :key="item.id" class="alloc-row confirmed">
                  <span>{{ householdName(item.householdId) }} · {{ item.people }}人</span>
                  <small>确认于 {{ fmt(item.confirmedAt) }}</small>
                </div>
                <p v-if="!store.shelterStats(shelter.id).confirmed.length" class="empty">暂无已确认安置。</p>
                <small>待调整（超容量，不占床位，等负责人处理）</small>
                <div v-for="item in store.shelterStats(shelter.id).adjusting" :key="item.id" class="alloc-row adjusting">
                  <span>{{ householdName(item.householdId) }} · {{ item.people }}人</span>
                  <NTag type="warning">超出 {{ item.overCount }} 人</NTag>
                  <NButton size="tiny" @click="store.cancelAllocation(item.id)">撤销</NButton>
                </div>
                <p v-if="!store.shelterStats(shelter.id).adjusting.length" class="empty">没有待调整项。</p>
              </div>
            </article>
          </div>
        </NCard>
        <NCard title="离线排入安置队列">
          <form class="field-grid" @submit.prevent="submitAllocation">
            <label class="field wide"><span>安置家庭</span><NSelect v-model:value="allocForm.householdId" :options="householdOptions" /></label>
            <label class="field"><span>安置点</span><NSelect v-model:value="allocForm.shelterId" :options="shelterOptions" /></label>
            <label class="field"><span>占用床位人数</span><NInputNumber v-model:value="allocForm.people" :min="1" :max="30" /> <small>默认按家庭人数，可由负责人拆分调整</small></label>
            <div class="actions wide"><NButton attr-type="submit" type="primary">离线排入待同步队列</NButton></div>
          </form>
        </NCard>
      </div>

      <div v-if="panel === '任务分派'" class="page-grid"><NCard title="任务列表"><div v-for="task in store.tasks" :key="task.id" class="task-row"><div><b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b><small>{{ store.households.find((item) => item.id === task.householdId)?.head }}<template v-if="task.allocationId"> · 安置派工</template> · {{ task.due }}</small></div><NTag>{{ task.priority }}</NTag><span>{{ task.assignee }} · {{ task.status }}</span><NButton size="small" :disabled="task.status === '已完成'" @click="store.advanceTask(task.id)">推进状态</NButton></div></NCard><NCard title="分派新任务"><p>当前家庭：<b>{{ selected?.head }}</b></p><label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label><label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label><NButton type="primary" block :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton></NCard></div>

      <div v-if="panel === '同步队列'" class="side-stack">
        <NCard title="安置分配待同步队列（按设备顺序，先排的先算数）">
          <p>{{ syncMessage || '离线分配带设备顺序号排队；恢复连接后按提交先后合并，超容量的不进正式名单。' }}</p>
          <div v-for="item in pendingQueue" :key="item.id" class="queue-row">
            <NTag :type="item.status === '待同步' ? 'info' : 'warning'">序号 {{ item.seq }}</NTag>
            <span>{{ householdName(item.householdId) }} → {{ shelterName(item.shelterId) }} · {{ item.people }}人<template v-if="item.status === '待调整'"> · <b class="over">超出 {{ item.overCount }} 人</b></template></span>
            <NTag :type="item.status === '待同步' ? 'info' : 'warning'">{{ item.status }}</NTag>
            <small>{{ fmt(item.submittedAt) }}</small>
            <NButton size="tiny" @click="store.cancelAllocation(item.id)">撤销</NButton>
          </div>
          <p v-if="!pendingQueue.length" class="empty">待同步队列为空。</p>
          <div class="actions">
            <NButton type="primary" :loading="store.syncing" @click="runSync">按顺序同步合并</NButton>
            <NButton @click="runStep">只提交下一项</NButton>
            <NSwitch v-model:value="store.online" />
            <small>{{ store.online ? '在线，可随时断网' : '离线，队列保留在设备中' }}</small>
          </div>
          <small class="rule">合并规则：按提交序号先后确认，先排的先算数；超出核定容量的不进正式名单，标记“待调整”并写明超出人数；同一份申请重连后凭申请编号去重，不会重复占床位；容量变更后未确认项按新容量重算，已确认的超员项退回待处理。</small>
        </NCard>
        <NCard title="其他离线变更记录">
          <div v-for="item in store.queue" :key="item.id" class="queue-row"><NTag>{{ item.action }}</NTag><span>{{ item.entity }} · {{ item.detail }}</span><small>{{ new Date(item.time).toLocaleTimeString('zh-CN') }}</small></div>
          <p v-if="!store.queue.length" class="empty">暂无离线变更记录。</p>
          <small v-if="cacheProbe"> 数据缓存时间：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }}</small>
        </NCard>
      </div>

      <NCard v-if="panel === '冲突处理'" title="字段级冲突"><div v-for="item in store.conflicts" :key="item.id" class="conflict"><b>{{ store.households.find((household) => household.id === item.householdId)?.head }} · {{ item.field }}</b><div class="conflict-values"><div><small>本机记录</small><span>{{ item.localValue }}</span></div><div><small>远端记录</small><span>{{ item.remoteValue }}</span></div></div><div class="actions"><NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用本地')">采用本机</NButton><NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用远端')">采用远端</NButton><NTag>{{ item.status }}</NTag></div></div><p v-if="!store.conflicts.length" class="empty">暂无字段冲突。联网合并家庭记录时如遇多人修改同一字段，会在此列出并人工确认，不静默覆盖。</p></NCard>
    </main>
  </div>
</template>
