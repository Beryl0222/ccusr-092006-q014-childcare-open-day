// 开放日探访协调后端。
//
// 设计要点：
// - 仅追加事件是唯一事实来源；任何决定（撤回、吊销、删除、暂停）都写成新事件，
//   已发布材料不会从记录中消失，而是进入可跟踪的处置流程。
// - 所有命令在写入前先由投影重放校验：凭证时效、现场/区域容量、区域暂停、
//   授权现状都会被准确核对（入园 / 临时离场 / 再次进入 / 最终离园）。
// - 员工视图按角色做字段白名单（数据最小化）：接待、引导、协调、负责人
//   只能看到完成本职工作所需的资料。

import {
  validateEvent,
  CONSENT_SCOPES,
  PAUSE_REASONS,
  DISPOSAL_STATES,
  STAFF_ROLES,
} from "./childcare_open_day.js";

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    Object.assign(this, details);
  }
}

let eventSeq = 0;
function defaultEventId() {
  eventSeq += 1;
  return `evt-${Date.now().toString(36)}-${eventSeq}`;
}

function asInstant(at) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new DomainError("BAD_TIME", "无法识别的时间");
  return d;
}

function iso(d) {
  return asInstant(d).toISOString();
}

const TERMINAL_REQUEST_STATES = new Set(["TAKEN_DOWN", "RETAINED_JUSTIFIED", "REJECTED"]);

// ---------- 仅追加事件存储 ----------

export function createEventStore() {
  const events = [];
  const seen = new Set();
  return {
    append(record) {
      const problems = validateEvent(record);
      if (problems.length) throw new DomainError("BAD_EVENT", `事件缺少或含有非法字段：${problems.join(", ")}`);
      if (seen.has(record.event_id)) throw new DomainError("DUP_EVENT", "事件编号重复", { event_id: record.event_id });
      seen.add(record.event_id);
      events.push(Object.freeze(structuredClone(record)));
      return events[events.length - 1];
    },
    list() {
      return events.map((e) => structuredClone(e));
    },
  };
}

// ---------- 投影：从事件流重建当前状态 ----------

function buildProjection(store) {
  const model = new Map();

  function openDay(id) {
    let od = model.get(id);
    if (!od) {
      od = {
        id,
        scheduledAt: null,
        siteCapacity: 0,
        areas: new Map(),
        slots: new Map(),
        visitors: new Map(),
        children: new Map(),
        credentials: new Map(),
        media: new Map(),
        complaints: new Map(),
        reschedules: [],
        insidePeople: 0,
        peakInside: 0,
        closedAt: null,
      };
      model.set(id, od);
    }
    return od;
  }

  function child(od, id) {
    let c = od.children.get(id);
    if (!c) {
      c = { id, scopes: new Map() };
      od.children.set(id, c);
    }
    return c;
  }

  for (const e of store.list()) {
    const p = e.payload;
    const od = openDay(p.open_day_id ?? e.subject_id);

    switch (e.kind) {
      case "OPEN_DAY_SCHEDULED": {
        od.scheduledAt = e.occurred_at;
        od.siteCapacity = p.site_capacity;
        for (const a of p.areas) {
          od.areas.set(a.area_id, {
            id: a.area_id,
            name: a.name,
            capacity: a.capacity,
            occupancy: 0,
            peakOccupancy: 0,
            totalEntries: 0,
            paused: null,
          });
        }
        for (const s of p.slots) {
          od.slots.set(s.slot_id, {
            id: s.slot_id,
            start: s.start_at,
            end: s.end_at,
            capacity: s.capacity,
            areaIds: [...s.area_ids],
            peopleBooked: 0,
          });
        }
        break;
      }
      case "AREA_CAPACITY_UPDATED": {
        const area = od.areas.get(p.area_id);
        if (area) area.capacity = p.capacity;
        break;
      }
      case "VISITOR_REGISTERED": {
        const slot = od.slots.get(p.slot_id);
        const party = 1 + (p.companions?.length ?? 0);
        od.visitors.set(e.subject_id, {
          id: e.subject_id,
          displayName: p.display_name,
          slotId: p.slot_id,
          partySize: party,
          companions: structuredClone(p.companions ?? []),
          accessNeeds: p.access_needs ?? "",
          focusAreas: [...(p.focus_areas ?? [])],
          languages: [...(p.languages ?? [])],
          credentialCode: null,
          state: "PLANNED",
          currentArea: null,
          segments: [],
          reschedule: null,
          registeredAt: e.occurred_at,
        });
        if (slot) slot.peopleBooked += party;
        break;
      }
      case "CREDENTIAL_ISSUED": {
        od.credentials.set(p.code, {
          code: p.code,
          visitorId: e.subject_id,
          slotId: p.slot_id,
          validFrom: p.valid_from,
          validUntil: p.valid_until,
          status: "ISSUED",
          languages: [...(p.languages ?? [])],
        });
        const v = od.visitors.get(e.subject_id);
        if (v) v.credentialCode = p.code;
        break;
      }
      case "CREDENTIAL_REVOKED": {
        const c = od.credentials.get(p.code);
        if (c) c.status = "REVOKED";
        break;
      }
      case "CHILD_AREA_ASSIGNED": {
        child(od, e.subject_id).areaId = p.area_id;
        break;
      }
      case "CONSENT_RECORDED": {
        const c = child(od, e.subject_id);
        const entry = c.scopes.get(p.scope) ?? { current: null, history: [] };
        entry.current = p.decision;
        entry.history.push({ at: e.occurred_at, decision: p.decision });
        c.scopes.set(p.scope, entry);
        break;
      }
      case "CONSENT_WITHDRAWN": {
        const c = child(od, e.subject_id);
        const entry = c.scopes.get(p.scope) ?? { current: null, history: [] };
        entry.current = "WITHDRAWN";
        entry.history.push({ at: e.occurred_at, decision: "WITHDRAWN" });
        c.scopes.set(p.scope, entry);
        break;
      }
      case "VISITOR_CHECKED_IN": {
        const v = od.visitors.get(e.subject_id);
        if (v) {
          v.state = "INSIDE";
          v.checkInAt = e.occurred_at;
          od.insidePeople += v.partySize;
          od.peakInside = Math.max(od.peakInside, od.insidePeople);
        }
        break;
      }
      case "VISITOR_TEMP_EXITED": {
        const v = od.visitors.get(e.subject_id);
        if (v) {
          v.state = "TEMP_OUT";
          v.tempExitedAt = e.occurred_at;
          od.insidePeople -= v.partySize;
          if (v.currentArea) closeSegment(od, v, e.occurred_at);
        }
        break;
      }
      case "VISITOR_REENTERED": {
        const v = od.visitors.get(e.subject_id);
        if (v) {
          v.state = "INSIDE";
          od.insidePeople += v.partySize;
          od.peakInside = Math.max(od.peakInside, od.insidePeople);
        }
        break;
      }
      case "VISITOR_CHECKED_OUT": {
        const v = od.visitors.get(e.subject_id);
        if (v) {
          if (v.currentArea) closeSegment(od, v, e.occurred_at);
          if (v.state === "INSIDE") od.insidePeople -= v.partySize;
          // 因改期触发的离园不是终局：访客将凭新凭证在新时段入园。
          v.state = typeof p.reason === "string" && p.reason.startsWith("RESCHEDULED_TO_") ? "RESCHEDULED" : "CHECKED_OUT";
          v.checkedOutAt = e.occurred_at;
        }
        break;
      }
      case "AREA_ENTRY_LOGGED": {
        const area = od.areas.get(p.area_id);
        const v = od.visitors.get(e.subject_id);
        if (area && v) {
          if (v.currentArea) closeSegment(od, v, e.occurred_at);
          v.segments.push({ areaId: p.area_id, enteredAt: e.occurred_at, exitedAt: null });
          v.currentArea = p.area_id;
          area.occupancy += v.partySize;
          area.peakOccupancy = Math.max(area.peakOccupancy, area.occupancy);
          area.totalEntries += 1;
        }
        break;
      }
      case "AREA_EXIT_LOGGED": {
        const v = od.visitors.get(e.subject_id);
        if (v && v.currentArea === p.area_id) closeSegment(od, v, e.occurred_at);
        break;
      }
      case "ROUTE_PAUSED": {
        const area = od.areas.get(p.area_id);
        if (area) area.paused = { at: e.occurred_at, reason: p.reason, note: p.note ?? "" };
        break;
      }
      case "ROUTE_RESUMED": {
        const area = od.areas.get(p.area_id);
        if (area) area.paused = null;
        break;
      }
      case "VISIT_RESCHEDULED": {
        const v = od.visitors.get(e.subject_id);
        const record = {
          visitorId: e.subject_id,
          reason: p.reason,
          areaId: p.area_id ?? null,
          fromSlotId: p.from_slot_id,
          toSlotId: p.to_slot_id,
          status: p.status,
          at: e.occurred_at,
        };
        od.reschedules.push(record);
        if (v) v.reschedule = record;
        if (p.status === "ACCEPTED" && v) {
          const from = od.slots.get(p.from_slot_id);
          const to = od.slots.get(p.to_slot_id);
          if (from) from.peopleBooked -= v.partySize;
          if (to) to.peopleBooked += v.partySize;
          v.slotId = p.to_slot_id;
        }
        break;
      }
      case "MEDIA_PUBLISHED": {
        od.media.set(e.subject_id, {
          id: e.subject_id,
          scope: p.scope,
          childIds: [...p.child_ids],
          areaId: p.area_id ?? null,
          publishedAt: e.occurred_at,
          requests: [],
        });
        break;
      }
      case "MEDIA_RETENTION_FLAGGED": {
        const m = od.media.get(e.subject_id);
        if (m) m.requests.push({ requestId: p.request_id, reason: p.reason, note: p.note ?? "", flaggedAt: e.occurred_at, stage: "PENDING", resolvedAt: null });
        break;
      }
      case "MEDIA_REQUEST_RESOLVED": {
        const m = od.media.get(e.subject_id);
        if (m) {
          const req = m.requests.find((r) => r.requestId === p.request_id);
          if (req) {
            req.stage = p.resolution;
            req.resolvedAt = TERMINAL_REQUEST_STATES.has(p.resolution) ? e.occurred_at : null;
            req.note = p.note ?? req.note;
          }
        }
        break;
      }
      case "COMPLAINT_FILED": {
        od.complaints.set(e.subject_id, {
          id: e.subject_id,
          reporterRef: p.reporter_ref,
          category: p.category,
          summary: p.summary,
          relatedMediaIds: [...(p.related_media_ids ?? [])],
          openedAt: e.occurred_at,
          status: "OPEN",
          resolvedAt: null,
          resolution: null,
        });
        break;
      }
      case "COMPLAINT_RESOLVED": {
        const c = od.complaints.get(e.subject_id);
        if (c) {
          c.status = "RESOLVED";
          c.resolvedAt = e.occurred_at;
          c.resolution = p.resolution;
        }
        break;
      }
      case "OPEN_DAY_CLOSED": {
        od.closedAt = e.occurred_at;
        break;
      }
      default:
        break;
    }
  }

  function closeSegment(od, v, at) {
    const area = od.areas.get(v.currentArea);
    const seg = v.segments.find((s) => s.areaId === v.currentArea && s.exitedAt === null);
    if (seg) seg.exitedAt = at;
    if (area) area.occupancy -= v.partySize;
    v.currentArea = null;
  }

  return model;
}

// ---------- 协调器：命令 + 查询 ----------

export class OpenDayCoordinator {
  #store;
  #clock;

  constructor(store, { clock = () => new Date() } = {}) {
    this.#store = store;
    this.#clock = clock;
  }

  #at(at) {
    return iso(at ?? this.#clock());
  }

  #model() {
    return buildProjection(this.#store);
  }

  #od(model, openDayId) {
    const od = model.get(openDayId);
    if (!od) throw new DomainError("OPEN_DAY_NOT_FOUND", "开放日不存在");
    return od;
  }

  #emit(kind, subjectId, payload, at) {
    return this.#store.append({
      event_id: payload.event_id ?? defaultEventId(),
      kind,
      occurred_at: this.#at(at),
      subject_id: subjectId,
      payload: Object.fromEntries(Object.entries(payload).filter(([k]) => k !== "event_id")),
    });
  }

  #assertOpen(od) {
    if (od.closedAt) throw new DomainError("OPEN_DAY_CLOSED", "开放日已结束，现场操作不再受理");
  }

  // ===== 园方发布开放配置 =====

  scheduleOpenDay(input, at) {
    const required = ["open_day_id", "site_capacity", "areas", "slots", "languages"];
    for (const k of required) {
      if (input[k] === undefined || input[k] === null) throw new DomainError("BAD_INPUT", `缺少发布字段：${k}`);
    }
    if (!Array.isArray(input.areas) || input.areas.length === 0) throw new DomainError("BAD_INPUT", "至少发布一个开放区域");
    for (const a of input.areas) {
      if (!a.area_id || !Number.isInteger(a.capacity) || a.capacity <= 0) throw new DomainError("BAD_AREA", "区域缺少编号或容量");
      if (a.accessible === undefined) throw new DomainError("BAD_AREA", "区域必须说明无障碍条件");
    }
    for (const s of input.slots) {
      if (!s.slot_id || !s.start_at || !s.end_at || !Number.isInteger(s.capacity) || s.capacity <= 0) {
        throw new DomainError("BAD_SLOT", "时段缺少编号、起止时间或容量");
      }
      if (Date.parse(s.end_at) <= Date.parse(s.start_at)) throw new DomainError("BAD_SLOT", "时段结束必须晚于开始");
      for (const areaId of s.area_ids ?? []) {
        if (!input.areas.some((a) => a.area_id === areaId)) throw new DomainError("BAD_SLOT", "时段引用了未发布区域");
      }
    }
    const model = this.#model();
    if (model.has(input.open_day_id)) throw new DomainError("OPEN_DAY_EXISTS", "开放日已发布");

    this.#emit(
      "OPEN_DAY_SCHEDULED",
      input.open_day_id,
      {
        open_day_id: input.open_day_id,
        site_capacity: input.site_capacity,
        languages: [...input.languages],
        accessibility: input.accessibility ?? "",
        areas: input.areas.map((a) => ({
          area_id: a.area_id,
          name: a.name ?? a.area_id,
          capacity: a.capacity,
          accessible: a.accessible,
          accessibility_note: a.accessibility_note ?? "",
          photography_default: a.photography_default ?? "DENIED",
        })),
        slots: input.slots.map((s) => ({
          slot_id: s.slot_id,
          start_at: iso(s.start_at),
          end_at: iso(s.end_at),
          capacity: s.capacity,
          area_ids: [...(s.area_ids ?? [])],
        })),
        event_id: input.event_id,
      },
      at,
    );
    return input.open_day_id;
  }

  updateAreaCapacity(openDayId, areaId, capacity, at) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new DomainError("BAD_INPUT", "容量必须是非负整数");
    const od = this.#od(this.#model(), openDayId);
    if (!od.areas.has(areaId)) throw new DomainError("AREA_NOT_FOUND", "区域不存在");
    this.#emit("AREA_CAPACITY_UPDATED", openDayId, { open_day_id: openDayId, area_id: areaId, capacity }, at);
  }

  // ===== 访客登记与限时凭证 =====

  registerVisitor(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    this.#assertOpen(od);
    const slot = od.slots.get(input.slot_id);
    if (!slot) throw new DomainError("SLOT_NOT_FOUND", "所选时段不存在或未发布");
    if (od.visitors.has(input.visitor_id)) throw new DomainError("VISITOR_EXISTS", "访客已登记");
    const companions = Array.isArray(input.companions) ? input.companions : [];
    const partySize = 1 + companions.length;
    if (slot.peopleBooked + partySize > slot.capacity) {
      throw new DomainError("SLOT_FULL", "该时段接待人数已满", { slot_id: slot.id, capacity: slot.capacity });
    }
    for (const areaId of input.focus_areas ?? []) {
      if (!od.areas.has(areaId)) throw new DomainError("AREA_NOT_FOUND", "关注的区域不存在");
    }
    this.#emit(
      "VISITOR_REGISTERED",
      input.visitor_id,
      {
        open_day_id: input.open_day_id,
        slot_id: input.slot_id,
        display_name: input.display_name ?? input.visitor_id,
        companions: companions.map((c) => ({ kind: c.kind ?? "ADULT", note: c.note ?? "" })),
        access_needs: input.access_needs ?? "",
        focus_areas: [...(input.focus_areas ?? [])],
        contact: input.contact ?? null, // 登记，接待视图默认不展示
        languages: [...(input.languages ?? [])],
        event_id: input.event_id,
      },
      at,
    );
    return input.visitor_id;
  }

  issueCredential(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    const v = od.visitors.get(input.visitor_id);
    if (!v) throw new DomainError("VISITOR_NOT_FOUND", "访客尚未登记");
    const slot = od.slots.get(v.slotId);
    if (!slot) throw new DomainError("SLOT_NOT_FOUND", "登记时段不存在");
    if (v.credentialCode && od.credentials.get(v.credentialCode)?.status === "ISSUED") {
      throw new DomainError("CREDENTIAL_ACTIVE", "限时凭证已有效，请勿重复发放");
    }
    const validFrom = input.valid_from ? iso(input.valid_from) : slot.start;
    const validUntil = input.valid_until ? iso(input.valid_until) : slot.end;
    if (Date.parse(validUntil) <= Date.parse(validFrom)) throw new DomainError("BAD_INPUT", "凭证失效时间必须晚于生效时间");
    let code = input.code ?? `PASS-${input.open_day_id}-${input.visitor_id}`.toUpperCase();
    if (!input.code) {
      let n = 2;
      const base = code;
      while (od.credentials.has(code)) code = `${base}-R${n++}`;
    }
    if (od.credentials.has(code)) throw new DomainError("CREDENTIAL_CODE_EXISTS", "凭证编号已存在");

    this.#emit(
      "CREDENTIAL_ISSUED",
      input.visitor_id,
      {
        open_day_id: input.open_day_id,
        slot_id: v.slotId,
        code,
        valid_from: validFrom,
        valid_until: validUntil,
        languages: [...(input.languages ?? [])],
        event_id: input.event_id,
      },
      at,
    );
    return code;
  }

  revokeCredential(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    const cred = od.credentials.get(input.code);
    if (!cred) throw new DomainError("CREDENTIAL_NOT_FOUND", "凭证不存在");
    if (cred.status !== "ISSUED") throw new DomainError("CREDENTIAL_NOT_ACTIVE", "凭证已失效，无需吊销");
    this.#emit(
      "CREDENTIAL_REVOKED",
      cred.visitorId,
      { open_day_id: input.open_day_id, code: input.code, reason: input.reason ?? "SECURITY", note: input.note ?? "" },
      at,
    );
  }

  // ===== 现场出入与容量 =====

  #admission(od, visitorId, atIso) {
    const v = od.visitors.get(visitorId);
    if (!v) throw new DomainError("VISITOR_NOT_FOUND", "访客尚未登记");
    const cred = v.credentialCode ? od.credentials.get(v.credentialCode) : null;
    if (!cred) throw new DomainError("NO_CREDENTIAL", "未取得限时凭证");
    if (cred.status === "REVOKED") throw new DomainError("CREDENTIAL_REVOKED", "凭证已吊销");
    const t = Date.parse(atIso);
    if (t < Date.parse(cred.validFrom)) throw new DomainError("CREDENTIAL_NOT_VALID_YET", "凭证尚未生效");
    if (t > Date.parse(cred.validUntil)) throw new DomainError("CREDENTIAL_EXPIRED", "凭证已超过有效时段");
    const slot = od.slots.get(v.slotId);
    if (slot && (t < Date.parse(slot.start) - 15 * 60_000 || t > Date.parse(slot.end) + 15 * 60_000)) {
      throw new DomainError("OUTSIDE_SLOT", "不在所预约时段内");
    }
    return v;
  }

  checkIn(input, at) {
    const atIso = this.#at(at);
    const od = this.#od(this.#model(), input.open_day_id);
    this.#assertOpen(od);
    const v = this.#admission(od, input.visitor_id, atIso);
    if (v.state === "INSIDE") throw new DomainError("ALREADY_INSIDE", "访客已在园内");
    if (v.state === "CHECKED_OUT") throw new DomainError("ALREADY_CHECKED_OUT", "访客已最终离园，不能再次入园");
    if (od.insidePeople + v.partySize > od.siteCapacity) {
      throw new DomainError("SITE_FULL", "现场容量已满，请稍后再试", { capacity: od.siteCapacity, inside: od.insidePeople });
    }
    this.#emit("VISITOR_CHECKED_IN", input.visitor_id, { open_day_id: input.open_day_id, party_size: v.partySize }, atIso);
  }

  tempExit(input, at) {
    const atIso = this.#at(at);
    const od = this.#od(this.#model(), input.open_day_id);
    this.#assertOpen(od);
    const v = od.visitors.get(input.visitor_id);
    if (!v) throw new DomainError("VISITOR_NOT_FOUND", "访客尚未登记");
    if (v.state !== "INSIDE") throw new DomainError("NOT_INSIDE", "只有在园访客可以临时离场");
    this.#emit(
      "VISITOR_TEMP_EXITED",
      input.visitor_id,
      { open_day_id: input.open_day_id, expected_return_by: input.expected_return_by ? iso(input.expected_return_by) : null },
      atIso,
    );
  }

  reenter(input, at) {
    const atIso = this.#at(at);
    const od = this.#od(this.#model(), input.open_day_id);
    this.#assertOpen(od);
    const v = this.#admission(od, input.visitor_id, atIso);
    if (v.state !== "TEMP_OUT") throw new DomainError("NOT_TEMP_OUT", "只有临时离场的访客可以再次进入");
    if (od.insidePeople + v.partySize > od.siteCapacity) {
      throw new DomainError("SITE_FULL", "现场容量已满，暂时无法再次进入", { capacity: od.siteCapacity, inside: od.insidePeople });
    }
    this.#emit("VISITOR_REENTERED", input.visitor_id, { open_day_id: input.open_day_id, party_size: v.partySize }, atIso);
  }

  checkOut(input, at) {
    const atIso = this.#at(at);
    const od = this.#od(this.#model(), input.open_day_id);
    const v = od.visitors.get(input.visitor_id);
    if (!v) throw new DomainError("VISITOR_NOT_FOUND", "访客尚未登记");
    if (v.state === "CHECKED_OUT") throw new DomainError("ALREADY_CHECKED_OUT", "访客已最终离园");
    if (v.state === "PLANNED") throw new DomainError("NOT_CHECKED_IN", "访客尚未入园");
    this.#emit("VISITOR_CHECKED_OUT", input.visitor_id, { open_day_id: input.open_day_id }, atIso);
  }

  logAreaEntry(input, at) {
    const atIso = this.#at(at);
    const od = this.#od(this.#model(), input.open_day_id);
    this.#assertOpen(od);
    const v = od.visitors.get(input.visitor_id);
    if (!v || v.state !== "INSIDE") throw new DomainError("NOT_INSIDE", "只有在园访客可以进入区域");
    const area = od.areas.get(input.area_id);
    if (!area) throw new DomainError("AREA_NOT_FOUND", "区域不存在");
    if (area.paused) throw new DomainError("ROUTE_PAUSED", "该区域路线已暂停", { reason: area.paused.reason });
    if (area.occupancy + v.partySize > area.capacity) {
      throw new DomainError("AREA_FULL", "该区域人数已满", { capacity: area.capacity, occupancy: area.occupancy });
    }
    this.#emit("AREA_ENTRY_LOGGED", input.visitor_id, { open_day_id: input.open_day_id, area_id: input.area_id }, atIso);
  }

  logAreaExit(input, at) {
    const atIso = this.#at(at);
    const od = this.#od(this.#model(), input.open_day_id);
    const v = od.visitors.get(input.visitor_id);
    if (!v) throw new DomainError("VISITOR_NOT_FOUND", "访客尚未登记");
    if (v.currentArea !== input.area_id) throw new DomainError("NOT_IN_AREA", "访客当前不在该区域");
    this.#emit("AREA_EXIT_LOGGED", input.visitor_id, { open_day_id: input.open_day_id, area_id: input.area_id }, atIso);
  }

  // ===== 在园儿童监护人：三类授权分别决定 =====

  assignChildArea(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    if (!od.areas.has(input.area_id)) throw new DomainError("AREA_NOT_FOUND", "区域不存在");
    this.#emit(
      "CHILD_AREA_ASSIGNED",
      input.child_id,
      { open_day_id: input.open_day_id, area_id: input.area_id },
      at,
    );
  }

  recordConsent(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    if (!CONSENT_SCOPES.includes(input.scope)) throw new DomainError("BAD_SCOPE", "授权范围必须是观察、摄影或宣传之一");
    if (!["ALLOWED", "DENIED"].includes(input.decision)) throw new DomainError("BAD_DECISION", "决定必须是 ALLOWED 或 DENIED");
    if (!input.child_id) throw new DomainError("BAD_INPUT", "缺少在园儿童标识");
    this.#emit(
      "CONSENT_RECORDED",
      input.child_id,
      {
        open_day_id: input.open_day_id,
        scope: input.scope,
        decision: input.decision,
        guardian_ref: input.guardian_ref ?? "guardian",
        note: input.note ?? "",
        event_id: input.event_id,
      },
      at,
    );
  }

  // 撤回只改变后续活动；已发布材料自动进入处置流程（事件保留）。
  withdrawConsent(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    if (!CONSENT_SCOPES.includes(input.scope)) throw new DomainError("BAD_SCOPE", "授权范围必须是观察、摄影或宣传之一");
    if (!od.children.has(input.child_id)) throw new DomainError("CHILD_NOT_FOUND", "尚无该儿童的授权记录");
    this.#emit(
      "CONSENT_WITHDRAWN",
      input.child_id,
      { open_day_id: input.open_day_id, scope: input.scope, guardian_ref: input.guardian_ref ?? "guardian", note: input.note ?? "" },
      at,
    );
    // 自动标记此前已发布、且仍在展示的相关影像。
    for (const m of od.media.values()) {
      if (m.scope !== input.scope || !m.childIds.includes(input.child_id)) continue;
      const takenDown = m.requests.some((r) => r.stage === "TAKEN_DOWN");
      const pending = m.requests.some((r) => !TERMINAL_REQUEST_STATES.has(r.stage));
      if (takenDown || pending) continue;
      this.#emit(
        "MEDIA_RETENTION_FLAGGED",
        m.id,
        {
          open_day_id: input.open_day_id,
          request_id: `rr-${m.id}-${input.scope}-withdraw-${input.child_id}`.toLowerCase(),
          reason: "CONSENT_WITHDRAWN",
          note: `监护人撤回 ${input.scope} 授权，已发布材料进入处置流程`,
          triggered_by_child: input.child_id,
        },
        at,
      );
    }
  }

  consentStatus(openDayId, childId) {
    const od = this.#od(this.#model(), openDayId);
    const c = od.children.get(childId);
    if (!c) return null;
    const out = {};
    for (const scope of CONSENT_SCOPES) out[scope] = c.scopes.get(scope)?.current ?? "UNDECIDED";
    return out;
  }

  // ===== 突发状况：局部路线暂停与改期 =====

  pauseArea(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    this.#assertOpen(od);
    if (!od.areas.has(input.area_id)) throw new DomainError("AREA_NOT_FOUND", "区域不存在");
    if (!PAUSE_REASONS.includes(input.reason)) throw new DomainError("BAD_REASON", "暂停原因必须是突发照护、传染病风险或消防要求之一");
    this.#emit(
      "ROUTE_PAUSED",
      input.open_day_id,
      { open_day_id: input.open_day_id, area_id: input.area_id, reason: input.reason, note: input.note ?? "" },
      at,
    );
  }

  resumeArea(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    if (!od.areas.get(input.area_id)?.paused) throw new DomainError("NOT_PAUSED", "该区域当前未暂停");
    this.#emit("ROUTE_RESUMED", input.open_day_id, { open_day_id: input.open_day_id, area_id: input.area_id, note: input.note ?? "" }, at);
  }

  // 受影响家庭 = 此刻在该区域内的访客，以及路线包含该区域、且时段尚未结束的登记家庭。
  #affectedByPause(od, areaId, atIso) {
    const t = Date.parse(atIso);
    const affected = new Map();
    for (const v of od.visitors.values()) {
      if (v.state === "CHECKED_OUT") continue;
      if (v.currentArea === areaId) affected.set(v.id, v);
      const slot = od.slots.get(v.slotId);
      if (slot && slot.areaIds.includes(areaId) && t <= Date.parse(slot.end)) affected.set(v.id, v);
    }
    return [...affected.values()];
  }

  offerReschedule(input, at) {
    const atIso = this.#at(at);
    const od = this.#od(this.#model(), input.open_day_id);
    const area = od.areas.get(input.area_id);
    if (!area?.paused) throw new DomainError("NOT_PAUSED", "只能为已暂停的路线安排改期");
    const target = od.slots.get(input.to_slot_id);
    if (!target) throw new DomainError("SLOT_NOT_FOUND", "改期目标时段不存在");
    const affected = this.#affectedByPause(od, input.area_id, atIso).filter(
      (v) => v.slotId !== target.id && v.reschedule?.status !== "OFFERED",
    );
    const offered = [];
    const skippedDueToCapacity = [];
    for (const v of affected) {
      if (target.capacity - target.peopleBooked < v.partySize) {
        skippedDueToCapacity.push(v.id); // 容量不足，保留人工处理
        continue;
      }
      this.#emit(
        "VISIT_RESCHEDULED",
        v.id,
        {
          open_day_id: input.open_day_id,
          area_id: input.area_id,
          reason: area.paused.reason,
          from_slot_id: v.slotId,
          to_slot_id: input.to_slot_id,
          status: "OFFERED",
        },
        atIso,
      );
      offered.push(v.id);
    }
    return { offered, skipped_due_to_capacity: skippedDueToCapacity, affected: affected.map((v) => v.id) };
  }

  respondReschedule(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    const v = od.visitors.get(input.visitor_id);
    if (!v?.reschedule || v.reschedule.status !== "OFFERED") throw new DomainError("NO_OFFER", "没有待回复的改期提议");
    if (!["ACCEPTED", "DECLINED"].includes(input.status)) throw new DomainError("BAD_INPUT", "请选择接受或拒绝");
    const target = od.slots.get(v.reschedule.toSlotId);
    if (input.status === "ACCEPTED") {
      if (target.peopleBooked + v.partySize > target.capacity) throw new DomainError("SLOT_FULL", "目标时段容量不足");
      this.#emit(
        "VISIT_RESCHEDULED",
        v.id,
        {
          open_day_id: input.open_day_id,
          area_id: v.reschedule.areaId,
          reason: v.reschedule.reason,
          from_slot_id: v.slotId,
          to_slot_id: target.id,
          status: "ACCEPTED",
        },
        at,
      );
      // 仍在园内（含临时离场）即接受改期：当前到访随旧预约一并结束，
      // 凭新凭证在新时段入园；容量在离园事件中释放。
      if (v.state === "INSIDE" || v.state === "TEMP_OUT") {
        this.#emit(
          "VISITOR_CHECKED_OUT",
          v.id,
          { open_day_id: input.open_day_id, reason: "RESCHEDULED_TO_" + target.id },
          at,
        );
      }
      // 原限时凭证随预约一并更换，旧凭证吊销留痕。
      if (v.credentialCode) {
        this.#emit(
          "CREDENTIAL_REVOKED",
          v.id,
          { open_day_id: input.open_day_id, code: v.credentialCode, reason: "SUPERSEDED_BY_RESCHEDULE" },
          at,
        );
      }
      this.issueCredential({ open_day_id: input.open_day_id, visitor_id: v.id }, at);
    } else {
      this.#emit(
        "VISIT_RESCHEDULED",
        v.id,
        {
          open_day_id: input.open_day_id,
          area_id: v.reschedule.areaId,
          reason: v.reschedule.reason,
          from_slot_id: v.slotId,
          to_slot_id: v.reschedule.toSlotId,
          status: "DECLINED",
        },
        at,
      );
    }
  }

  // ===== 影像：发布门控与处置流程 =====

  publishMedia(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    this.#assertOpen(od);
    if (!["PHOTOGRAPHY", "PROMOTION"].includes(input.scope)) throw new DomainError("BAD_SCOPE", "影像用途必须是摄影或宣传");
    if (od.media.has(input.media_id)) throw new DomainError("MEDIA_EXISTS", "影像编号已存在");
    for (const childId of input.child_ids ?? []) {
      const current = od.children.get(childId)?.scopes.get(input.scope)?.current;
      if (current !== "ALLOWED") {
        throw new DomainError("CONSENT_MISSING", `儿童 ${childId} 未就 ${input.scope} 授权或授权已撤回`, {
          child_id: childId,
          scope: input.scope,
          status: current ?? "UNDECIDED",
        });
      }
    }
    const basis = {};
    for (const childId of input.child_ids ?? []) {
      const hist = od.children.get(childId).scopes.get(input.scope).history;
      basis[childId] = hist[hist.length - 1].at;
    }
    this.#emit(
      "MEDIA_PUBLISHED",
      input.media_id,
      {
        open_day_id: input.open_day_id,
        scope: input.scope,
        child_ids: [...(input.child_ids ?? [])],
        area_id: input.area_id ?? null,
        consent_basis: basis,
        note: input.note ?? "",
        event_id: input.event_id,
      },
      at,
    );
  }

  // 删除/保留请求：材料进入处置流程；记录本身不删除。
  flagMedia(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    const m = od.media.get(input.media_id);
    if (!m) throw new DomainError("MEDIA_NOT_FOUND", "影像不存在");
    if (m.requests.some((r) => r.requestId === input.request_id)) {
      throw new DomainError("REQUEST_EXISTS", "处置请求编号已存在");
    }
    if (m.requests.some((r) => !TERMINAL_REQUEST_STATES.has(r.stage))) {
      throw new DomainError("REQUEST_OPEN", "该影像已有进行中的处置请求");
    }
    this.#emit(
      "MEDIA_RETENTION_FLAGGED",
      input.media_id,
      {
        open_day_id: input.open_day_id,
        request_id: input.request_id,
        reason: input.reason ?? "DELETE_REQUEST",
        note: input.note ?? "",
        requester_ref: input.requester_ref ?? null,
      },
      at,
    );
  }

  resolveMediaRequest(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    const m = od.media.get(input.media_id);
    if (!m) throw new DomainError("MEDIA_NOT_FOUND", "影像不存在");
    const req = m.requests.find((r) => r.requestId === input.request_id);
    if (!req) throw new DomainError("REQUEST_NOT_FOUND", "处置请求不存在");
    if (TERMINAL_REQUEST_STATES.has(req.stage)) throw new DomainError("REQUEST_CLOSED", "处置请求已有终局决定");
    if (!DISPOSAL_STATES.includes(input.resolution) || input.resolution === "PENDING") {
      throw new DomainError("BAD_RESOLUTION", "处置决定必须是已要求下架、已下架、有据保留或拒绝之一");
    }
    this.#emit(
      "MEDIA_REQUEST_RESOLVED",
      input.media_id,
      {
        open_day_id: input.open_day_id,
        request_id: input.request_id,
        resolution: input.resolution,
        note: input.note ?? "",
        actor_ref: input.actor_ref ?? "coordinator",
      },
      at,
    );
  }

  // ===== 投诉 =====

  fileComplaint(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    if (od.complaints.has(input.complaint_id)) throw new DomainError("COMPLAINT_EXISTS", "投诉编号已存在");
    for (const mediaId of input.related_media_ids ?? []) {
      if (!od.media.has(mediaId)) throw new DomainError("MEDIA_NOT_FOUND", "关联影像不存在");
    }
    this.#emit(
      "COMPLAINT_FILED",
      input.complaint_id,
      {
        open_day_id: input.open_day_id,
        reporter_ref: input.reporter_ref ?? input.complaint_id,
        category: input.category ?? "OTHER",
        summary: input.summary ?? "",
        related_media_ids: [...(input.related_media_ids ?? [])],
      },
      at,
    );
  }

  resolveComplaint(input, at) {
    const od = this.#od(this.#model(), input.open_day_id);
    const c = od.complaints.get(input.complaint_id);
    if (!c) throw new DomainError("COMPLAINT_NOT_FOUND", "投诉不存在");
    if (c.status === "RESOLVED") throw new DomainError("COMPLAINT_CLOSED", "投诉已处理完成");
    this.#emit(
      "COMPLAINT_RESOLVED",
      input.complaint_id,
      { open_day_id: input.open_day_id, resolution: input.resolution, note: input.note ?? "" },
      at,
    );
  }

  // ===== 闭园与负责人日报 =====

  closeOpenDay(openDayId, at) {
    const od = this.#od(this.#model(), openDayId);
    if (od.closedAt) throw new DomainError("OPEN_DAY_CLOSED", "开放日已结束");
    const report = this.dailyReport(openDayId);
    this.#emit(
      "OPEN_DAY_CLOSED",
      openDayId,
      {
        open_day_id: openDayId,
        visitors_total: report.visitors.length,
        media_published: report.media.length,
        media_pending_requests: report.media.filter((m) => m.stage === "IN_PROCESS").length,
        complaints_open: report.complaints.filter((c) => c.status === "OPEN").length,
        summary: "闭园快照；删除请求与投诉可在闭园后继续流转，事件流不删除",
      },
      at,
    );
  }

  dailyReport(openDayId) {
    const od = this.#od(this.#model(), openDayId);
    const visitors = [...od.visitors.values()].map((v) => {
      const byArea = new Map();
      for (const seg of v.segments) {
        const a = byArea.get(seg.areaId) ?? { area_id: seg.areaId, visits: 0, first_entry_at: seg.enteredAt, last_exit_at: null };
        a.visits += 1;
        a.last_exit_at = seg.exitedAt;
        byArea.set(seg.areaId, a);
      }
      const cred = v.credentialCode ? od.credentials.get(v.credentialCode) : null;
      return {
        visitor_id: v.id,
        slot_id: v.slotId,
        party_size: v.partySize,
        status: v.state,
        credential: cred ? { code: cred.code, status: cred.status, valid_from: cred.validFrom, valid_until: cred.validUntil } : null,
        areas_visited: [...byArea.values()],
        reschedule: v.reschedule
          ? { from_slot_id: v.reschedule.fromSlotId, to_slot_id: v.reschedule.toSlotId, status: v.reschedule.status }
          : null,
      };
    });

    const media = [...od.media.values()].map((m) => {
      const takenDown = m.requests.some((r) => r.stage === "TAKEN_DOWN");
      const open = m.requests.filter((r) => !TERMINAL_REQUEST_STATES.has(r.stage));
      const stage = takenDown ? "TAKEN_DOWN" : open.length ? "IN_PROCESS" : "RETAINED";
      return {
        media_id: m.id,
        scope: m.scope,
        child_ids: m.childIds,
        published_at: m.publishedAt,
        stage, // RETAINED 允许保留；IN_PROCESS 处置中；TAKEN_DOWN 已下架（记录仍在）
        retained: !takenDown,
        requests: m.requests.map((r) => ({
          request_id: r.requestId,
          reason: r.reason,
          stage: r.stage,
          flagged_at: r.flaggedAt,
          resolved_at: r.resolvedAt,
        })),
      };
    });

    const complaints = [...od.complaints.values()].map((c) => ({
      complaint_id: c.id,
      status: c.status,
      category: c.category,
      opened_at: c.openedAt,
      resolved_at: c.resolvedAt,
      resolution: c.resolution,
      related_media_ids: c.relatedMediaIds,
    }));

    return {
      open_day_id: openDayId,
      closed_at: od.closedAt,
      site: {
        capacity: od.siteCapacity,
        peak_inside: od.peakInside,
        inside_now: od.insidePeople,
      },
      paused_areas: [...od.areas.values()].filter((a) => a.paused).map((a) => ({ area_id: a.id, reason: a.paused.reason, since: a.paused.at })),
      visitors,
      media,
      complaints,
    };
  }

  // ===== 员工视图：字段白名单，数据最小化 =====

  staffView(openDayId, role) {
    if (!STAFF_ROLES.includes(role)) throw new DomainError("BAD_ROLE", "未知员工角色");
    const od = this.#od(this.#model(), openDayId);

    if (role === "DIRECTOR") {
      return { role, open_day_id: openDayId, report: this.dailyReport(openDayId) };
    }

    if (role === "RECEPTION") {
      return {
        role,
        open_day_id: openDayId,
        site: { capacity: od.siteCapacity, inside_now: od.insidePeople },
        visitors: [...od.visitors.values()].map((v) => {
          const cred = v.credentialCode ? od.credentials.get(v.credentialCode) : null;
          return {
            visitor_id: v.id,
            display_name: v.displayName,
            slot_id: v.slotId,
            party_size: v.partySize,
            status: v.state,
            access_needs: v.accessNeeds, // 接待需要据此安排无障碍
            credential: cred ? { code: cred.code, status: cred.status, valid_from: cred.validFrom, valid_until: cred.validUntil } : null,
          };
        }),
      };
    }

    if (role === "GUIDE") {
      // 各区域观察受限儿童计数：引导员据此缩短停留、调整观察角度，
      // 不暴露具体儿童身份；摄影/宣传由发布门控另行强制。
      const observationBlockedByArea = new Map();
      for (const ch of od.children.values()) {
        if (!ch.areaId) continue;
        if (ch.scopes.get("OBSERVATION")?.current !== "ALLOWED") {
          observationBlockedByArea.set(ch.areaId, (observationBlockedByArea.get(ch.areaId) ?? 0) + 1);
        }
      }
      return {
        role,
        open_day_id: openDayId,
        paused_areas: [...od.areas.values()].filter((a) => a.paused).map((a) => ({ area_id: a.id, reason: a.paused.reason })),
        areas: [...od.areas.values()].map((a) => ({
          area_id: a.id,
          name: a.name,
          occupancy: a.occupancy,
          capacity: a.capacity,
          paused: Boolean(a.paused),
          observation_restricted_children: observationBlockedByArea.get(a.id) ?? 0,
        })),
        visitors: [...od.visitors.values()].filter((v) => v.state === "INSIDE").map((v) => ({
          visitor_id: v.id,
          current_area: v.currentArea,
          focus_areas: v.focusAreas, // 讲解引导所需
          languages: v.languages,
          access_needs: v.accessNeeds,
        })),
      };
    }

    // COORDINATOR：运营总览，不含授权细节、投诉正文与联系方式
    return {
      role,
      open_day_id: openDayId,
      site: { capacity: od.siteCapacity, inside_now: od.insidePeople, peak_inside: od.peakInside },
      paused_areas: [...od.areas.values()].filter((a) => a.paused).map((a) => ({ area_id: a.id, reason: a.paused.reason, since: a.paused.at })),
      pending_reschedules: od.reschedules.filter((r) => r.status === "OFFERED").map((r) => ({
        visitor_id: r.visitorId,
        from_slot_id: r.fromSlotId,
        to_slot_id: r.toSlotId,
      })),
      media_in_process: [...od.media.values()]
        .filter((m) => m.requests.some((r) => !TERMINAL_REQUEST_STATES.has(r.stage)))
        .map((m) => ({ media_id: m.id, requests: m.requests.filter((r) => !TERMINAL_REQUEST_STATES.has(r.stage)).map((r) => r.requestId) })),
      open_complaints: [...od.complaints.values()].filter((c) => c.status === "OPEN").map((c) => c.id),
    };
  }

  // 只读事件流（审计 / 负责人核查）
  events() {
    return this.#store.list();
  }
}
