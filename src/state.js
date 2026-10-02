// 状态归约：把仅追加的事件流重放为当前状态。
// 归约器只做机械重放，不做业务判断；业务规则放在 service 层。
// 撤回（CONSENT_WITHDRAWN）表现为“在某一时间点之后生效的新决定”，
// 历史事件与历史影像记录仍然保留在流中。

import {
  CASE_STAGES,
  CONSENT_STATES,
  MEDIA_DISPOSAL_STEPS,
  MEDIA_STATUSES,
  VISITOR_STATUS,
} from "./childcare_open_day.js";

export function freshState() {
  return {
    openDay: null, // { id, name, summary, publishedAt, cancelled, closed, closedAt, accessibility, languages }
    areas: new Map(), // areaId -> { id, name, accessible, capacityNote }
    slots: new Map(), // slotId  -> { id, startsAt, endsAt, capacity, languages }
    childAreaAssignments: new Map(), // areaId -> Set(childId)
    childAreaLookup: new Map(), // childId -> areaId
    children: new Map(), // childId -> { id, consents: { scope: {state, at, withdrawn} } }
    visitors: new Map(), // registrationId -> 访客聚合
    areaPauses: new Map(), // areaId -> { reason, at, note, active }
    globalPause: null, // { reason, at, note } 或 null（消防全园封控）
    pauseLog: [], // 全部暂停/恢复历史（含已结束的全园封控），报告可追溯
    media: new Map(), // mediaId -> 影像聚合
    cases: new Map(), // caseId -> 案件聚合
    eventOrder: [], // 事件写入顺序的 event_id（便于报告排序）
  };
}

function ensureVisitor(state, id) {
  let visitor = state.visitors.get(id);
  if (!visitor) {
    visitor = {
      registrationId: id,
      status: VISITOR_STATUS.REGISTERED,
      onSite: false,
      pass: null,
      currentAreaId: null,
      areaVisits: [], // { areaId, enteredAt, exitedAt }
      movements: [], // { at, type }
      offers: [], // 改期邀约
      slotId: null,
      rescheduledFromSlotId: null,
    };
    state.visitors.set(id, visitor);
  }
  return visitor;
}

function ensureChild(state, id) {
  let child = state.children.get(id);
  if (!child) {
    child = { id, consents: {}, consentHistory: {} };
    state.children.set(id, child);
  }
  return child;
}

// 记录一次同意决定；当前值与按时间排列的历史同时保留，
// 这样撤回之后仍能回答“某历史时刻是否获授权”。
function applyConsentDecision(child, scope, decision) {
  child.consents[scope] = decision;
  (child.consentHistory[scope] ??= []).push(decision);
}

function leaveCurrentArea(visitor, at) {
  if (visitor.currentAreaId) {
    const visit = visitor.areaVisits.find((v) => v.areaId === visitor.currentAreaId && v.exitedAt === null);
    if (visit) visit.exitedAt = at;
    visitor.currentAreaId = null;
  }
}

const handlers = {
  VISIT_SLOT_PUBLISHED(state, event) {
    const p = event.payload;
    state.openDay = {
      id: event.subject_id,
      name: p.name ?? "",
      summary: p.summary ?? "",
      publishedAt: event.occurred_at,
      accessibility: p.accessibility ?? {},
      languages: p.languages ?? [],
      cancelled: false,
      closed: false,
      closedAt: null,
    };
    for (const area of p.areas ?? []) {
      state.areas.set(area.id, { ...area });
      if (!state.childAreaAssignments.has(area.id)) state.childAreaAssignments.set(area.id, new Set());
    }
    for (const slot of p.slots ?? []) {
      state.slots.set(slot.id, { ...slot });
    }
    for (const assignment of p.childAssignments ?? []) {
      assignChild(state, assignment.childId, assignment.areaId);
    }
  },

  OPEN_DAY_UPDATED(state, event) {
    const p = event.payload;
    if (state.openDay) {
      for (const key of ["name", "summary", "accessibility", "languages"]) {
        if (key in p) state.openDay[key] = p[key];
      }
    }
    for (const area of p.areas ?? []) {
      state.areas.set(area.id, { ...state.areas.get(area.id), ...area });
      if (!state.childAreaAssignments.has(area.id)) state.childAreaAssignments.set(area.id, new Set());
    }
    for (const slot of p.slots ?? []) {
      state.slots.set(slot.id, { ...state.slots.get(slot.id), ...slot });
    }
    for (const assignment of p.childAssignments ?? []) {
      assignChild(state, assignment.childId, assignment.areaId);
    }
  },

  OPEN_DAY_CANCELLED(state, event) {
    if (state.openDay) state.openDay.cancelled = true;
  },

  VISITOR_REGISTERED(state, event) {
    const visitor = ensureVisitor(state, event.subject_id);
    Object.assign(visitor, {
      displayName: event.payload.display_name,
      contactRef: event.payload.contact_ref ?? null,
      slotId: event.payload.slot_id,
      partySize: event.payload.party_size ?? 1,
      companions: event.payload.companions ?? [],
      accessibilityNeeds: event.payload.accessibility_needs ?? [],
      attentionNotes: event.payload.attention_notes ?? [],
      language: event.payload.language ?? null,
      plannedAreaIds: event.payload.planned_route ?? [],
      registeredAt: event.occurred_at,
    });
  },

  PASS_ISSUED(state, event) {
    const visitor = ensureVisitor(state, event.subject_id);
    visitor.pass = {
      code: event.payload.code,
      issuedAt: event.occurred_at,
      expiresAt: event.payload.expires_at,
      revoked: false,
      slotId: event.payload.slot_id ?? visitor.slotId,
    };
  },

  PASS_REVOKED(state, event) {
    const visitor = state.visitors.get(event.subject_id);
    if (visitor?.pass) {
      visitor.pass.revoked = true;
      visitor.pass.revokedAt = event.occurred_at;
      visitor.pass.revokeReason = event.payload.reason ?? null;
    }
    // 改期或换发导致的旧凭证作废不算登记取消（新凭证随即签发）
    if (
      visitor &&
      visitor.status === VISITOR_STATUS.REGISTERED &&
      event.payload.reason !== "rescheduled" &&
      event.payload.reason !== "replaced"
    ) {
      visitor.status = VISITOR_STATUS.CANCELLED;
    }
  },

  CONSENT_RECORDED(state, event) {
    const child = ensureChild(state, event.subject_id);
    applyConsentDecision(child, event.payload.scope, {
      state: event.payload.state ?? CONSENT_STATES.GRANTED,
      at: event.occurred_at,
      guardianRef: event.payload.guardian_ref ?? null,
      note: event.payload.note ?? null,
      withdrawn: false,
    });
  },

  CONSENT_WITHDRAWN(state, event) {
    const child = ensureChild(state, event.subject_id);
    applyConsentDecision(child, event.payload.scope, {
      state: CONSENT_STATES.DENIED,
      at: event.occurred_at,
      guardianRef: event.payload.guardian_ref ?? null,
      withdrawn: true,
      note: event.payload.note ?? null,
    });
  },

  VISITOR_CHECKED_IN(state, event) {
    const visitor = ensureVisitor(state, event.subject_id);
    visitor.status = VISITOR_STATUS.ON_SITE;
    visitor.onSite = true;
    visitor.movements.push({ at: event.occurred_at, type: "entry", via: event.payload.via ?? "main" });
  },

  VISITOR_TEMPORARILY_EXITED(state, event) {
    const visitor = ensureVisitor(state, event.subject_id);
    visitor.status = VISITOR_STATUS.TEMP_OUT;
    visitor.onSite = false;
    visitor.expectedReturnBy = event.payload.expected_return_by ?? null;
    visitor.movements.push({ at: event.occurred_at, type: "temp_exit", reason: event.payload.reason ?? null });
    leaveCurrentArea(visitor, event.occurred_at);
  },

  VISITOR_REENTERED(state, event) {
    const visitor = ensureVisitor(state, event.subject_id);
    visitor.status = VISITOR_STATUS.ON_SITE;
    visitor.onSite = true;
    visitor.expectedReturnBy = null;
    visitor.movements.push({ at: event.occurred_at, type: "reentry" });
  },

  VISITOR_CHECKED_OUT(state, event) {
    const visitor = ensureVisitor(state, event.subject_id);
    visitor.status = VISITOR_STATUS.LEFT;
    visitor.onSite = false;
    visitor.movements.push({ at: event.occurred_at, type: "final_exit" });
    leaveCurrentArea(visitor, event.occurred_at);
  },

  AREA_ENTERED(state, event) {
    const visitor = ensureVisitor(state, event.subject_id);
    visitor.currentAreaId = event.payload.area_id;
    visitor.areaVisits.push({ areaId: event.payload.area_id, enteredAt: event.occurred_at, exitedAt: null });
  },

  AREA_EXITED(state, event) {
    const visitor = ensureVisitor(state, event.subject_id);
    const areaId = event.payload.area_id ?? visitor.currentAreaId;
    const visit = visitor.areaVisits.find((v) => v.areaId === areaId && v.exitedAt === null);
    if (visit) visit.exitedAt = event.occurred_at;
    if (visitor.currentAreaId === areaId) visitor.currentAreaId = null;
  },

  ACCESS_REFUSED(state, event) {
    const visitor = ensureVisitor(state, event.subject_id);
    visitor.accessRefusals ??= [];
    visitor.accessRefusals.push({
      at: event.occurred_at,
      areaId: event.payload.area_id ?? null,
      reason: event.payload.reason,
      detail: event.payload.detail ?? null,
    });
  },

  ROUTE_PAUSED(state, event) {
    const pause = { reason: event.payload.reason, at: event.occurred_at, note: event.payload.note ?? null, active: true };
    const global = !event.payload.area_ids || event.payload.area_ids.length === 0;
    const entry = {
      id: event.event_id,
      global,
      areaIds: global ? [...state.areas.keys()] : [...event.payload.area_ids],
      reason: event.payload.reason,
      at: event.occurred_at,
      note: event.payload.note ?? null,
      active: true,
      resumedAt: null,
    };
    if (global) {
      state.globalPause = pause;
    } else {
      for (const areaId of event.payload.area_ids) state.areaPauses.set(areaId, { ...pause });
    }
    state.pauseLog.push(entry);
  },

  ROUTE_RESUMED(state, event) {
    const global = event.payload.global === true;
    const areaIds = event.payload.area_ids ?? [];
    if (global) state.globalPause = null;
    for (const areaId of areaIds) {
      const pause = state.areaPauses.get(areaId);
      if (pause) {
        pause.active = false;
        pause.resumedAt = event.occurred_at;
      }
    }
    // 在暂停日志中关闭匹配的未决条目
    for (const entry of [...state.pauseLog].reverse()) {
      if (!entry.active) continue;
      if (global) {
        entry.active = false;
        entry.resumedAt = event.occurred_at;
        break;
      }
      if (entry.areaIds.some((a) => areaIds.includes(a))) {
        const remaining = entry.areaIds.filter((a) => !areaIds.includes(a));
        entry.areaIds = remaining;
        if (remaining.length === 0) {
          entry.active = false;
          entry.resumedAt = event.occurred_at;
        }
      }
    }
  },

  RESCHEDULE_OFFERED(state, event) {
    const visitor = ensureVisitor(state, event.subject_id);
    visitor.offers.push({
      id: event.payload.offer_id,
      at: event.occurred_at,
      reason: event.payload.reason,
      areaIds: event.payload.area_ids ?? [],
      newSlotId: event.payload.new_slot_id,
      status: "pending",
    });
  },

  RESCHEDULE_ACCEPTED(state, event) {
    const visitor = state.visitors.get(event.subject_id);
    if (!visitor) return;
    const offer = visitor.offers.find((o) => o.id === event.payload.offer_id);
    if (offer) {
      offer.status = "accepted";
      offer.decidedAt = event.occurred_at;
      visitor.rescheduledFromSlotId = visitor.slotId;
      visitor.slotId = offer.newSlotId;
      // 命令层保证接受时访客已离场：在新时段重新处于“已登记待入园”
      visitor.status = VISITOR_STATUS.REGISTERED;
      visitor.onSite = false;
    }
  },

  RESCHEDULE_DECLINED(state, event) {
    const visitor = state.visitors.get(event.subject_id);
    const offer = visitor?.offers.find((o) => o.id === event.payload.offer_id);
    if (offer) {
      offer.status = "declined";
      offer.decidedAt = event.occurred_at;
    }
  },

  MEDIA_LOGGED(state, event) {
    state.media.set(event.subject_id, {
      id: event.subject_id,
      capturedAt: event.payload.captured_at ?? event.occurred_at,
      loggedAt: event.occurred_at,
      areaId: event.payload.area_id ?? null,
      visitorId: event.payload.visitor_id ?? null,
      capturedBy: event.payload.captured_by ?? "visitor", // visitor | center
      purpose: event.payload.purpose ?? "personal", // personal | promotion
      childIds: event.payload.child_ids ?? [],
      channels: event.payload.channels ?? [], // 已发布渠道
      descriptor: event.payload.descriptor ?? "",
      status: event.payload.initial_status ?? MEDIA_STATUSES.LOGGED,
      disposalSteps: [],
      flagReason: null,
    });
  },

  MEDIA_FLAGGED(state, event) {
    const item = state.media.get(event.subject_id);
    if (!item) return;
    if (item.status !== MEDIA_STATUSES.DISPOSED) item.status = MEDIA_STATUSES.DISPOSING;
    item.flagReason = event.payload.reason ?? item.flagReason;
    item.flaggedAt = event.occurred_at;
  },

  MEDIA_REQUEST_RESOLVED(state, event) {
    const item = state.media.get(event.subject_id);
    if (!item) return;
    if (event.payload.decision === "retain") item.status = MEDIA_STATUSES.RETAINED;
    if (event.payload.decision === "dispose") item.status = MEDIA_STATUSES.DISPOSING;
    item.resolvedAt = event.occurred_at;
    item.resolutionNote = event.payload.note ?? null;
  },

  MEDIA_DISPOSAL_STEP_RECORDED(state, event) {
    const item = state.media.get(event.subject_id);
    if (!item) return;
    item.disposalSteps.push({
      step: event.payload.step,
      at: event.occurred_at,
      by: event.payload.by ?? null,
      note: event.payload.note ?? null,
    });
    if (event.payload.step === MEDIA_DISPOSAL_STEPS[MEDIA_DISPOSAL_STEPS.length - 1]) {
      item.status = MEDIA_STATUSES.DISPOSED;
    }
  },

  CASE_OPENED(state, event) {
    state.cases.set(event.subject_id, {
      id: event.subject_id,
      kind: event.payload.kind,
      openedAt: event.occurred_at,
      stage: CASE_STAGES[0],
      subject: event.payload.subject ?? null,
      mediaIds: event.payload.media_ids ?? [],
      summary: event.payload.summary ?? "",
      history: [{ at: event.occurred_at, stage: CASE_STAGES[0] }],
      closedAt: null,
      resolution: null,
    });
  },

  CASE_STAGE_REACHED(state, event) {
    const kase = state.cases.get(event.subject_id);
    if (!kase) return;
    kase.stage = event.payload.stage;
    kase.history.push({ at: event.occurred_at, stage: event.payload.stage, note: event.payload.note ?? null });
  },

  CASE_CLOSED(state, event) {
    const kase = state.cases.get(event.subject_id);
    if (!kase) return;
    kase.stage = "closed";
    kase.closedAt = event.occurred_at;
    kase.resolution = event.payload.resolution ?? null;
    kase.history.push({ at: event.occurred_at, stage: "closed", note: event.payload.resolution ?? null });
  },

  EVENT_CLOSED(state, event) {
    if (state.openDay) {
      state.openDay.closed = true;
      state.openDay.closedAt = event.occurred_at;
    }
  },
};

function assignChild(state, childId, areaId) {
  if (!childId || !areaId) return;
  ensureChild(state, childId);
  const prev = state.childAreaLookup.get(childId);
  if (prev) state.childAreaAssignments.get(prev)?.delete(childId);
  if (!state.childAreaAssignments.has(areaId)) state.childAreaAssignments.set(areaId, new Set());
  state.childAreaAssignments.get(areaId).add(childId);
  state.childAreaLookup.set(childId, areaId);
}

export function buildState(events) {
  const state = freshState();
  // 稳定排序：仅按时间比较，时间戳相同时保持追加顺序（V8 的 sort 稳定）。
  // 不能用 event_id 做次序裁决——base36 序号会让 "10" 排在 "2" 之前。
  const ordered = [...events].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  for (const event of ordered) {
    const handler = handlers[event.kind];
    if (handler) handler(state, event);
    state.eventOrder.push(event.event_id);
  }
  return state;
}
