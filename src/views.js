// 员工视图与负责人报告：同一事件流，按岗位只暴露“完成职责所必需”的资料。
// - 公开目录：任何准备入托的家庭可见，不含在园儿童与访客信息
// - 接待视图：仅 RECEPTION_NEEDED_FIELDS
// - 安全视图：只含处置突发所需的在场与动线信息
// - 负责人闭园报告：每位访客到过的区域、影像允许保留情况、案件/删除进度

import {
  MEDIA_DISPOSAL_STEPS,
  MEDIA_STATUSES,
  RECEPTION_NEEDED_FIELDS,
  STAFF_ROLES,
  VISITOR_STATUS,
} from "./childcare_open_day.js";
import { areaPauseState, currentObservationConflicts, slotOccupancy } from "./policies.js";
// ---------------------------------------------------------------------------
// 公开目录：园方先行发布的开放区域、时段、人数、讲解语言、无障碍条件
// ---------------------------------------------------------------------------
export function publicCatalogView(state, atIso = new Date().toISOString()) {
  if (!state.openDay) return null;
  return {
    open_day_id: state.openDay.id,
    name: state.openDay.name,
    summary: state.openDay.summary,
    languages: state.openDay.languages,
    accessibility: state.openDay.accessibility,
    cancelled: state.openDay.cancelled,
    closed: state.openDay.closed,
    areas: [...state.areas.values()].map((area) => ({
      id: area.id,
      name: area.name,
      accessible: area.accessible,
      capacity_note: area.capacityNote,
      paused: areaPauseState(state, area.id, atIso).paused,
    })),
    slots: [...state.slots.values()].map((slot) => ({
      id: slot.id,
      starts_at: slot.startsAt,
      ends_at: slot.endsAt,
      capacity: slot.capacity,
      languages: slot.languages,
    })),
  };
}

// ---------------------------------------------------------------------------
// 接待视图：逐字段白名单，杜绝接触接待以外的资料
// ---------------------------------------------------------------------------
function receptionVisitor(visitor) {
  const slotId = visitor.pass?.slotId ?? visitor.slotId;
  // status 融合凭证状态，方便前台判断能否放行
  let status = visitor.status;
  if (visitor.pass?.revoked) status = VISITOR_STATUS.CANCELLED;
  const out = {
    registration_id: visitor.registrationId,
    display_name: visitor.displayName ?? null,
    contact_ref: visitor.contactRef ?? null,
    slot_id: slotId,
    party_size: visitor.partySize,
    accessibility_needs: visitor.accessibilityNeeds ?? [],
    attention_notes: visitor.attentionNotes ?? [],
    language: visitor.language ?? null,
    pass_code: visitor.pass?.code ?? null,
    status,
  };
  // 防御性保证：只可能出现白名单字段
  for (const key of Object.keys(out)) {
    if (!RECEPTION_NEEDED_FIELDS.includes(key)) delete out[key];
  }
  return out;
}

export function receptionView(state, options = {}) {
  const visitors = [...state.visitors.values()]
    .filter((v) => (options.slotId ? (v.pass?.slotId ?? v.slotId) === options.slotId : true))
    .filter((v) => v.status !== VISITOR_STATUS.CANCELLED || options.includeCancelled)
    .map(receptionVisitor);
  return {
    scope: "reception",
    open_day_id: state.openDay?.id ?? null,
    global_lockdown: state.globalPause !== null,
    paused_area_ids: [...state.areaPauses.entries()].filter(([, p]) => p.active).map(([id]) => id),
    visitors,
  };
}

// ---------------------------------------------------------------------------
// 安全/照护值班视图：处置突发所需，不含联系方式与关注事项等接待资料
// ---------------------------------------------------------------------------
export function safetyView(state, atIso = new Date().toISOString()) {
  const onSite = [...state.visitors.values()]
    .filter((v) => v.onSite)
    .map((v) => ({
      registration_id: v.registrationId,
      display_name: v.displayName ?? null,
      party_size: v.partySize,
      current_area_id: v.currentAreaId,
      accessibility_needs: v.accessibilityNeeds ?? [],
    }));

  const perArea = {};
  for (const areaId of state.areas.keys()) {
    perArea[areaId] = {
      people: onSite.filter((v) => v.current_area_id === areaId).reduce((n, v) => n + v.party_size, 0),
      pause: state.areaPauses.get(areaId)?.active
        ? { reason: state.areaPauses.get(areaId).reason, since: state.areaPauses.get(areaId).at }
        : null,
    };
  }

  return {
    scope: "safety",
    global_lockdown: state.globalPause
      ? { reason: state.globalPause.reason, since: state.globalPause.at, note: state.globalPause.note }
      : null,
    observation_conflicts: currentObservationConflicts(state, atIso),
    areas: perArea,
    on_site: onSite,
    slots: [...state.slots.keys()].map((slotId) => ({ slot_id: slotId, ...slotOccupancy(state, slotId) })),
  };
}

// 按角色分发的员工视图
export function staffView(state, actor, options = {}) {
  if (!actor) throw new Error("缺少员工身份");
  switch (actor.role) {
    case STAFF_ROLES.RECEPTION:
      return receptionView(state, options);
    case STAFF_ROLES.SAFETY:
      return safetyView(state);
    case STAFF_ROLES.CARE_OWNER:
      return { scope: "care_owner", catalog: publicCatalogView(state), reception: receptionView(state), safety: safetyView(state) };
    default:
      throw new Error(`未知角色：${actor.role}`);
  }
}

// ---------------------------------------------------------------------------
// 负责人闭园报告
// ---------------------------------------------------------------------------
// 计算某次区域访问期间，区域内儿童发生的撤回（撤回后仍停留的部分需可追溯）
function overlapsWithWithdrawals(state, visit) {
  const overlaps = [];
  const entered = Date.parse(visit.enteredAt);
  const exited = visit.exitedAt ? Date.parse(visit.exitedAt) : null;
  if (exited === null) return overlaps;
  for (const childId of state.childAreaAssignments.get(visit.areaId) ?? []) {
    const child = state.children.get(childId);
    if (!child) continue;
    for (const [scope, history] of Object.entries(child.consentHistory ?? {})) {
      for (const decision of history) {
        if (!decision.withdrawn) continue;
        const at = Date.parse(decision.at);
        if (at >= entered && at < exited) {
          overlaps.push({ child_id: childId, scope, withdrawn_at: decision.at });
        }
      }
    }
  }
  return overlaps;
}

function mediaReportItem(item) {
  const currentStep = item.disposalSteps.length
    ? item.disposalSteps[item.disposalSteps.length - 1].step
    : null;
  const nextStep =
    item.status === MEDIA_STATUSES.DISPOSING
      ? MEDIA_DISPOSAL_STEPS[item.disposalSteps.length] ?? null
      : null;
  return {
    media_id: item.id,
    descriptor: item.descriptor,
    captured_at: item.capturedAt,
    area_id: item.areaId,
    captured_by: item.capturedBy,
    purpose: item.purpose,
    child_ids: item.childIds,
    channels: item.channels,
    status: item.status,
    retention_allowed: item.status === MEDIA_STATUSES.RETAINED,
    disposal: {
      steps: item.disposalSteps,
      current_step: currentStep,
      next_step: nextStep,
      completed: item.status === MEDIA_STATUSES.DISPOSED,
    },
  };
}

export function ownerClosingReport(state) {
  if (!state.openDay) return null;

  const visitors = [...state.visitors.values()].map((v) => ({
    registration_id: v.registrationId,
    display_name: v.displayName ?? null,
    slot_id: v.slotId,
    final_status: v.status,
    movements: v.movements,
    // 到过哪些区域（去重，保持首次进入顺序）及每次进出时间
    areas_visited: [...new Set(v.areaVisits.map((x) => x.areaId))],
    area_visits: v.areaVisits.map((x) => ({
      area_id: x.areaId,
      entered_at: x.enteredAt,
      exited_at: x.exitedAt,
      withdrawals_during_visit: overlapsWithWithdrawals(state, x),
    })),
    reschedule_offers: v.offers.map((o) => ({
      offer_id: o.id,
      reason: o.reason,
      area_ids: o.areaIds,
      new_slot_id: o.newSlotId,
      status: o.status,
      decided_at: o.decidedAt ?? null,
    })),
    access_refusals: v.accessRefusals ?? [],
  }));

  const media = [...state.media.values()].map(mediaReportItem);

  const cases = [...state.cases.values()].map((c) => ({
    case_id: c.id,
    kind: c.kind,
    opened_at: c.openedAt,
    stage: c.stage,
    subject: c.subject,
    media_ids: c.mediaIds,
    summary: c.summary,
    closed_at: c.closedAt,
    resolution: c.resolution,
    history: c.history,
  }));

  const consents = [...state.children.values()].map((child) => ({
    child_id: child.id,
    scopes: Object.fromEntries(
      Object.entries(child.consents).map(([scope, r]) => [
        scope,
        { state: r.state, decided_at: r.at, withdrawn: r.withdrawn === true },
      ]),
    ),
  }));

  const pauses = state.pauseLog.map((p) => ({
    scope: p.global ? "global" : "area",
    area_ids: p.global ? null : p.areaIds,
    reason: p.reason,
    paused_at: p.at,
    resumed_at: p.resumedAt,
    active: p.active,
    note: p.note,
  }));

  return {
    open_day_id: state.openDay.id,
    name: state.openDay.name,
    published_at: state.openDay.publishedAt,
    closed_at: state.openDay.closedAt,
    summary: {
      registrations: state.visitors.size,
      visitors_on_site_at_report: [...state.visitors.values()].filter((v) => v.onSite).length,
      distinct_areas_visited: new Set(
        [...state.visitors.values()].flatMap((v) => v.areaVisits.map((x) => x.areaId)),
      ).size,
      media_total: media.length,
      media_retained: media.filter((m) => m.retention_allowed).length,
      media_disposing: media.filter((m) => m.status === MEDIA_STATUSES.DISPOSING).length,
      media_disposed: media.filter((m) => m.status === MEDIA_STATUSES.DISPOSED).length,
      cases_open: cases.filter((c) => c.stage !== "closed").length,
      cases_closed: cases.filter((c) => c.stage === "closed").length,
      pauses: pauses.length,
    },
    visitors,
    media,
    cases,
    consents,
    pauses,
  };
}
