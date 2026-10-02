// childcare_open_day 领域资料的基础结构。
//
// 事件溯源：系统的全部状态都来自仅追加的事件流。撤回同意不会删除历史事件，
// 已发布的材料进入可跟踪的处置流程，因此记录从不消失，只追加新事实。

// ---------------------------------------------------------------------------
// 事件种类
// ---------------------------------------------------------------------------

export const EVENT_KINDS = Object.freeze([
  // 园方发布 / 调整 / 取消开放日目录（开放区域、时段、人数、讲解语言、无障碍）
  "VISIT_SLOT_PUBLISHED",
  "OPEN_DAY_UPDATED",
  "OPEN_DAY_CANCELLED",

  // 访客登记、同行人、限时凭证签发 / 作废
  "VISITOR_REGISTERED",
  "PASS_ISSUED",
  "PASS_REVOKED",

  // 在园儿童监护人的分项同意与撤回
  "CONSENT_RECORDED",
  "CONSENT_WITHDRAWN",

  // 访客动线：入园、临时离场、再次进入、最终离开、区域进出
  "VISITOR_CHECKED_IN",
  "VISITOR_TEMPORARILY_EXITED",
  "VISITOR_REENTERED",
  "VISITOR_CHECKED_OUT",
  "AREA_ENTERED",
  "AREA_EXITED",
  "ACCESS_REFUSED",

  // 突发照护 / 传染病 / 消防：局部路线暂停、恢复，改期邀约与回应
  "ROUTE_PAUSED",
  "ROUTE_RESUMED",
  "RESCHEDULE_OFFERED",
  "RESCHEDULE_ACCEPTED",
  "RESCHEDULE_DECLINED",

  // 影像资产登记、保留标记、处置步骤推进
  "MEDIA_LOGGED",
  "MEDIA_FLAGGED",
  "MEDIA_REQUEST_RESOLVED",
  "MEDIA_DISPOSAL_STEP_RECORDED",

  // 投诉 / 删除请求案件
  "CASE_OPENED",
  "CASE_STAGE_REACHED",
  "CASE_CLOSED",

  // 开放日结束
  "EVENT_CLOSED",
]);

// 既有约定保留：所有事件的必填字段
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// ---------------------------------------------------------------------------
// 员工角色与可接触资料范围
// ---------------------------------------------------------------------------

export const STAFF_ROLES = Object.freeze({
  RECEPTION: "reception",       // 前台接待：只能接触接待所需资料
  SAFETY: "safety",             // 安全/照护值班：路线暂停、封控所需
  CARE_OWNER: "care_owner",     // 负责人：全量协调与闭园报告
});

// 接待岗位完成登记、发凭证、出入登记所必需的字段（其余个人资料对其不可见）
export const RECEPTION_NEEDED_FIELDS = Object.freeze([
  "registration_id",
  "display_name",
  "contact_ref",
  "slot_id",
  "party_size",
  "accessibility_needs",
  "attention_notes",
  "language",
  "pass_code",
  "status",
]);

// ---------------------------------------------------------------------------
// 同意范围：三项彼此独立，分别由在园儿童监护人决定
// ---------------------------------------------------------------------------

export const CONSENT_SCOPES = Object.freeze({
  OBSERVATION: "observation",  // 访客可否在该儿童在场时观察
  PHOTOGRAPHY: "photography",  // 访客可否拍摄到该儿童
  PROMOTION: "promotion",      // 园方可否将含该儿童的影像用于宣传
});

// 同意状态：未作决定按最保守解释（默认拒绝观察/拍摄/宣传）
export const CONSENT_STATES = Object.freeze({
  GRANTED: "granted",
  DENIED: "denied",
});

// ---------------------------------------------------------------------------
// 路线暂停原因；消防为全园封控
// ---------------------------------------------------------------------------

export const PAUSE_REASONS = Object.freeze({
  CARE_INCIDENT: "care_incident",      // 突发照护
  INFECTION_RISK: "infection_risk",    // 传染病风险
  FIRE_SAFETY: "fire_safety",          // 消防要求
});

// 消防要求覆盖全部区域
export const GLOBAL_PAUSE_REASON = PAUSE_REASONS.FIRE_SAFETY;

// ---------------------------------------------------------------------------
// 影像处置流程（撤回授权后，已发布材料逐步走完该流程，可跟踪、不可消失）
// ---------------------------------------------------------------------------

export const MEDIA_DISPOSAL_STEPS = Object.freeze([
  "received",        // 处置请求已登记
  "located",         // 材料位置与副本已定位
  "restricted",      // 已限制继续展示/分发
  "taken_down",      // 已从对外渠道撤下
  "copies_purged",   // 缓存与副本已清除
  "documented",      // 处置结果归档备查
]);

// 影像资产当前保留状态
export const MEDIA_STATUSES = Object.freeze({
  LOGGED: "logged",       // 已登记，按授权决定可否保留
  RETAINED: "retained",   // 允许保留
  DISPOSING: "disposing", // 撤回后进入处置流程
  DISPOSED: "disposed",   // 处置流程完成
});

// 案件种类与阶段
export const CASE_KINDS = Object.freeze({
  COMPLAINT: "complaint", // 投诉
  DELETION: "deletion",   // 删除请求
});

export const CASE_STAGES = Object.freeze([
  "received",
  "triaged",
  "actioned",
  "responded",
  "closed",
]);

// 访客状态
export const VISITOR_STATUS = Object.freeze({
  REGISTERED: "registered", // 已登记，尚未入园
  ON_SITE: "on_site",       // 在园
  TEMP_OUT: "temp_out",     // 临时离场
  LEFT: "left",             // 最终离开
  CANCELLED: "cancelled",   // 登记/凭证作废
});

export function validateEvent(record) {
  const problems = [];
  if (record === null || typeof record !== "object") return ["record"];
  for (const name of REQUIRED_FIELDS) {
    if (!(name in record)) problems.push(name);
  }
  if ("kind" in record && !EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}

// 校验某个值属于给定枚举，返回 null 或问题描述
export function requireEnum(value, allowed, label) {
  if (!Object.values(allowed).includes(value)) {
    return `${label} 必须是以下之一：${Object.values(allowed).join("、")}`;
  }
  return null;
}
