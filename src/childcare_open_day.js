// childcare_open_day 领域资料的基础结构。
//
// 后端采用事件溯源：协调器不删除、不覆盖任何已发布事实，
// 授权撤回只产生新的「后续不允许」事件；已发布材料的移除
// 走可跟踪的处置流程（DISPOSAL_*），原始事件始终保留。

export const EVENT_KINDS = Object.freeze([
  // 开放配置
  "OPEN_DAY_SCHEDULED", // 园方发布开放日：区域、时段、人数、讲解语言、无障碍条件
  "AREA_CAPACITY_UPDATED", // 现场容量调整（仅影响后续入园）

  // 访客与限时凭证
  "VISITOR_REGISTERED", // 访客登记同行人及关注事项
  "CREDENTIAL_ISSUED", // 发放限时凭证（绑定登记）
  "CREDENTIAL_REVOKED", // 凭证吊销（安全原因；不擦除历史）

  // 现场出入
  "VISITOR_CHECKED_IN", // 入园
  "VISITOR_TEMP_EXITED", // 临时离场
  "VISITOR_REENTERED", // 再次进入（需凭证仍有效、未被标记、容量允许）
  "VISITOR_CHECKED_OUT", // 最终离园
  "AREA_ENTRY_LOGGED", // 进入某区域（日报中「到过哪些区域」的依据）
  "AREA_EXIT_LOGGED", // 离开某区域（与进入配对，用于区域实时容量）

  // 在园儿童监护人的三类授权（按儿童分别决定）
  "CHILD_AREA_ASSIGNED", // 在园儿童所在班级区域（用于观察授权提示，不向访客展示身份）
  "CONSENT_RECORDED", // 观察 / 摄影 / 园方宣传
  "CONSENT_WITHDRAWN", // 撤回：只改变后续活动

  // 路线与突发状况
  "ROUTE_PAUSED", // 突发照护 / 传染病风险 / 消防要求：暂停局部路线或区域
  "ROUTE_RESUMED", // 解除暂停
  "VISIT_RESCHEDULED", // 向受影响家庭提供改期

  // 影像与投诉
  "MEDIA_PUBLISHED", // 影像发布（发布时必须仍在授权范围内）
  "MEDIA_RETENTION_FLAGGED", // 撤回后：已发布材料进入处置流程（不删除记录）
  "MEDIA_REQUEST_RESOLVED", // 删除/保留请求的处置决定与结果
  "COMPLAINT_FILED", // 投诉登记
  "COMPLAINT_RESOLVED", // 投诉处理结果

  // 闭园
  "OPEN_DAY_CLOSED", // 开放日结束，生成日报：到访区域、允许保留的影像、请求进度
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 监护人可分别决定的授权范围
export const CONSENT_SCOPES = Object.freeze(["OBSERVATION", "PHOTOGRAPHY", "PROMOTION"]);

// 对每个范围的决定
export const CONSENT_DECISIONS = Object.freeze(["ALLOWED", "DENIED"]);

// 局部路线暂停原因
export const PAUSE_REASONS = Object.freeze(["CARE_EMERGENCY", "INFECTION_RISK", "FIRE_SAFETY"]);

// 处置流程状态（可跟踪，不允许跳回「无记录」）
export const DISPOSAL_STATES = Object.freeze(["PENDING", "TAKEDOWN_REQUESTED", "TAKEN_DOWN", "RETAINED_JUSTIFIED", "REJECTED"]);

// 员工角色：只能接触接待所需资料
export const STAFF_ROLES = Object.freeze(["RECEPTION", "GUIDE", "COORDINATOR", "DIRECTOR"]);

// 凭证状态机
export const CREDENTIAL_STATES = Object.freeze(["ISSUED", "EXPIRED", "REVOKED"]);

const ENUM_BY_KIND = Object.freeze({
  CONSENT_RECORDED: { scope: CONSENT_SCOPES, decision: CONSENT_DECISIONS },
  CONSENT_WITHDRAWN: { scope: CONSENT_SCOPES },
  ROUTE_PAUSED: { reason: PAUSE_REASONS },
  MEDIA_REQUEST_RESOLVED: { resolution: DISPOSAL_STATES },
});

function isIsoOffsetInstant(value) {
  if (typeof value !== "string") return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && /\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:\d{2}|Z)$/.test(value);
}

// 返回问题字段名数组；为空数组表示事件符合领域约定。
export function validateEvent(record) {
  const problems = [];
  for (const name of REQUIRED_FIELDS) {
    if (!(name in record)) problems.push(name);
  }
  if ("kind" in record && !EVENT_KINDS.includes(record.kind)) problems.push("kind");
  if ("occurred_at" in record && !isIsoOffsetInstant(record.occurred_at)) problems.push("occurred_at");
  if ("subject_id" in record && (typeof record.subject_id !== "string" || record.subject_id.length === 0)) {
    problems.push("subject_id");
  }
  if ("payload" in record && (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload))) {
    problems.push("payload");
  }
  const enums = ENUM_BY_KIND[record.kind];
  if (enums && record.payload && typeof record.payload === "object") {
    for (const [field, allowed] of Object.entries(enums)) {
      if (field in record.payload && !allowed.includes(record.payload[field])) problems.push(`payload.${field}`);
    }
  }
  return problems;
}
