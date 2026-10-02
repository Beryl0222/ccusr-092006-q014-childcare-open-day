// 纯函数策略层：回答“在某一时间点，谁可以观察/拍摄/宣传、容量是否已满、
// 哪些区域被暂停”。不追加事件，供命令层与员工视图共用。

import {
  CONSENT_SCOPES,
  CONSENT_STATES,
  GLOBAL_PAUSE_REASON,
  VISITOR_STATUS,
} from "./childcare_open_day.js";

// 某儿童在指定时间点对某范围的同意：未作决定默认按最保守（拒绝）处理。
// 依据按时间排列的决定史求值——撤回只在撤回时刻之后生效，
// 撤回前的授权事实仍然成立，因此历史进入/拍摄记录不被重写。
export function consentAt(child, scope, atIso) {
  const history = child?.consentHistory?.[scope];
  if (!history || history.length === 0) return { state: CONSENT_STATES.DENIED, decided: false };
  const at = Date.parse(atIso);
  let effective = null;
  for (const record of history) {
    if (Date.parse(record.at) <= at) effective = record;
    else break;
  }
  if (!effective) return { state: CONSENT_STATES.DENIED, decided: false };
  return { state: effective.state, decided: true, at: effective.at, withdrawn: effective.withdrawn === true };
}

// 某区域内在 atIso 时刻的在园儿童
export function childrenInArea(state, areaId, atIso) {
  const ids = state.childAreaAssignments.get(areaId);
  return ids ? [...ids].map((id) => state.children.get(id)).filter(Boolean) : [];
}

// 区域访问政策：只要有一名在园儿童的监护人拒绝，该活动即受限（最保守聚合）。
export function areaPolicy(state, areaId, atIso) {
  const children = childrenInArea(state, areaId, atIso);
  const denies = (scope) => children.filter((c) => consentAt(c, scope, atIso).state === CONSENT_STATES.DENIED);
  return {
    areaId,
    children: children.map((c) => c.id),
    observationAllowed: denies(CONSENT_SCOPES.OBSERVATION).length === 0,
    photographyAllowed: denies(CONSENT_SCOPES.PHOTOGRAPHY).length === 0,
    promotionAllowed: denies(CONSENT_SCOPES.PROMOTION).length === 0,
    denyingChildren: {
      observation: denies(CONSENT_SCOPES.OBSERVATION).map((c) => c.id),
      photography: denies(CONSENT_SCOPES.PHOTOGRAPHY).map((c) => c.id),
      promotion: denies(CONSENT_SCOPES.PROMOTION).map((c) => c.id),
    },
  };
}

// 当前正停留在某区域、但按最新同意政策已不再被允许观察的访客。
// 撤回只改变后续活动：撤回前的进入合法保留，但继续停留属于撤回后的活动，
// 值班人员据此引导其结束观察，且该情况在闭园报告中可追溯。
export function currentObservationConflicts(state, atIso) {
  const conflicts = [];
  for (const visitor of state.visitors.values()) {
    if (visitor.status !== VISITOR_STATUS.ON_SITE || !visitor.currentAreaId) continue;
    const policy = areaPolicy(state, visitor.currentAreaId, atIso);
    if (!policy.observationAllowed) {
      conflicts.push({
        registration_id: visitor.registrationId,
        area_id: visitor.currentAreaId,
        denying_children: policy.denyingChildren.observation,
      });
    }
  }
  return conflicts;
}

// 一张凭证在指定时间点是否可用于入园
export function passUsableAt(visitor, atIso) {
  const pass = visitor?.pass;
  if (!pass) return { usable: false, reason: "no_pass" };
  if (pass.revoked) return { usable: false, reason: "pass_revoked" };
  if (Date.parse(pass.expiresAt) < Date.parse(atIso)) return { usable: false, reason: "pass_expired" };
  if (visitor.status === VISITOR_STATUS.CANCELLED) return { usable: false, reason: "registration_cancelled" };
  return { usable: true, pass };
}

// 某时段在某时间点的在场人数（在园状态者，按团体人数计），用于现场容量控制
export function slotOccupancy(state, slotId) {
  let people = 0;
  const registrations = [];
  for (const visitor of state.visitors.values()) {
    if ((visitor.pass?.slotId ?? visitor.slotId) !== slotId) continue;
    if (visitor.onSite) {
      people += visitor.partySize || 1;
      registrations.push(visitor.registrationId);
    }
  }
  return { slotId, people, registrations };
}

export function slotCapacity(state, slotId) {
  return state.slots.get(slotId)?.capacity ?? null;
}

// 已占用名额的预约（未取消、未最终离开），用于登记阶段控制名额
export function slotReserved(state, slotId) {
  let people = 0;
  const registrations = [];
  for (const visitor of state.visitors.values()) {
    if ((visitor.pass?.slotId ?? visitor.slotId) !== slotId) continue;
    if (visitor.status === VISITOR_STATUS.LEFT || visitor.status === VISITOR_STATUS.CANCELLED) continue;
    people += visitor.partySize || 1;
    registrations.push(visitor.registrationId);
  }
  return { slotId, people, registrations };
}

// 剩余可预约名额（null 表示该时段未设置容量上限）
export function slotReservationRemaining(state, slotId) {
  const cap = slotCapacity(state, slotId);
  if (cap === null) return null;
  return Math.max(0, cap - slotReserved(state, slotId).people);
}

// 剩余容量（null 表示该时段未设置容量上限）
export function slotCapacityRemaining(state, slotId) {
  const cap = slotCapacity(state, slotId);
  if (cap === null) return null;
  return Math.max(0, cap - slotOccupancy(state, slotId).people);
}

// 某区域在指定时间点是否暂停
export function areaPauseState(state, areaId, atIso) {
  const at = Date.parse(atIso);
  const local = state.areaPauses.get(areaId);
  if (local && local.active) return { paused: true, scope: "area", reason: local.reason, since: local.at };
  if (state.globalPause) return { paused: true, scope: "global", reason: state.globalPause.reason, since: state.globalPause.at };
  // 已恢复的暂停：历史可查但当前不阻拦
  if (local && local.resumedAt && Date.parse(local.resumedAt) <= at) {
    return { paused: false, wasPaused: true, reason: local.reason };
  }
  return { paused: false };
}

// 当前是否处于全园封控（消防）
export function isGlobalLockdown(state) {
  return state.globalPause !== null && state.globalPause.reason === GLOBAL_PAUSE_REASON;
}

// 找出暂停影响到的、应收到改期邀约的访客：
// - 当时在园/临时离场，且当前位于受影响区域；
// - 已登记、到访时段在暂停时刻正在进行，且计划路线涉及受影响区域。
// 尚未开始的更晚时段不纳入（暂停大概率已解除）。
export function affectedVisitorIds(state, areaIds, options = {}) {
  const areas = new Set(areaIds);
  const at = options.atIso ? Date.parse(options.atIso) : null;
  const ids = new Set();
  for (const visitor of state.visitors.values()) {
    if (options.slotId && (visitor.pass?.slotId ?? visitor.slotId) !== options.slotId) continue;
    if (visitor.status === VISITOR_STATUS.LEFT || visitor.status === VISITOR_STATUS.CANCELLED) continue;

    const inAffectedArea =
      (visitor.currentAreaId && areas.has(visitor.currentAreaId)) ||
      visitor.areaVisits.some((v) => !v.exitedAt && areas.has(v.areaId));
    if (inAffectedArea) {
      ids.add(visitor.registrationId);
      continue;
    }

    const plansAffected = options.includePlanned && visitor.plannedAreaIds?.some((a) => areas.has(a));
    if (!plansAffected) continue;

    // 仅计划受影响还不够：其时段须在暂停时刻正在进行（或无法判断时间）
    if (at === null) {
      ids.add(visitor.registrationId);
      continue;
    }
    const slotId = visitor.pass?.slotId ?? visitor.slotId;
    const slot = state.slots.get(slotId);
    if (slot && Date.parse(slot.startsAt) <= at && at <= Date.parse(slot.endsAt)) {
      ids.add(visitor.registrationId);
    }
  }
  return [...ids];
}
