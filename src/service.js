// OpenDayService：开放日探访协调的命令模型。
// 所有方法都先校验“员工角色是否可接触该操作所需资料”，再把事实作为事件追加。
// 任何撤回/撤销都不删除历史，只追加新事件并驱动可跟踪的处置流程。

import {
  CASE_KINDS,
  CASE_STAGES,
  CONSENT_SCOPES,
  CONSENT_STATES,
  GLOBAL_PAUSE_REASON,
  MEDIA_DISPOSAL_STEPS,
  MEDIA_STATUSES,
  PAUSE_REASONS,
  STAFF_ROLES,
  VISITOR_STATUS,
  requireEnum,
} from "./childcare_open_day.js";
import { EventStore, generateEventId } from "./store.js";
import { buildState } from "./state.js";
import {
  affectedVisitorIds,
  areaPauseState,
  areaPolicy,
  consentAt,
  isGlobalLockdown,
  passUsableAt,
  slotOccupancy,
  slotReservationRemaining,
} from "./policies.js";
import { DomainError, ERROR_CODES } from "./errors.js";

const ROLE = STAFF_ROLES;

// 每个命令允许的角色（最小授权）
const PERMISSIONS = Object.freeze({
  publish: [ROLE.CARE_OWNER],
  registerVisitor: [ROLE.RECEPTION, ROLE.CARE_OWNER],
  issuePass: [ROLE.RECEPTION, ROLE.CARE_OWNER],
  revokePass: [ROLE.RECEPTION, ROLE.CARE_OWNER],
  recordConsent: [ROLE.CARE_OWNER],
  movement: [ROLE.RECEPTION, ROLE.CARE_OWNER],
  pauseRoute: [ROLE.SAFETY, ROLE.CARE_OWNER],
  resumeRoute: [ROLE.SAFETY, ROLE.CARE_OWNER],
  reschedule: [ROLE.RECEPTION, ROLE.SAFETY, ROLE.CARE_OWNER],
  logMedia: [ROLE.RECEPTION, ROLE.CARE_OWNER],
  disposal: [ROLE.CARE_OWNER],
  case: [ROLE.CARE_OWNER],
  close: [ROLE.CARE_OWNER],
});

let idCounter = 0;
function localId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export class OpenDayService {
  constructor(store = new EventStore(), clock = () => new Date()) {
    this.store = store;
    this.clock = clock;
  }

  get state() {
    return buildState(this.store.all());
  }

  now() {
    return this.clock().toISOString();
  }

  #append(kind, subjectId, payload, at = this.now()) {
    return this.store.append({
      event_id: generateEventId(new Date(at)),
      kind,
      occurred_at: at,
      subject_id: subjectId,
      payload,
    });
  }

  #require(actor, permission) {
    if (!actor || !PERMISSIONS[permission].includes(actor.role)) {
      throw new DomainError(
        ERROR_CODES.PERMISSION_DENIED,
        `角色 ${actor?.role ?? "未知"}无权执行该操作`,
        { required: PERMISSIONS[permission] },
      );
    }
  }

  #requireOpen(state = this.state) {
    if (!state.openDay) throw new DomainError(ERROR_CODES.NOT_FOUND, "尚未发布开放日");
    if (state.openDay.cancelled) throw new DomainError(ERROR_CODES.CANCELLED, "开放日已取消");
    if (state.openDay.closed) throw new DomainError(ERROR_CODES.ALREADY_CLOSED, "开放日已结束");
  }

  #requireVisitor(state, registrationId) {
    const visitor = state.visitors.get(registrationId);
    if (!visitor) throw new DomainError(ERROR_CODES.NOT_FOUND, `访客不存在：${registrationId}`);
    return visitor;
  }

  // -------------------------------------------------------------------------
  // 1. 园方发布目录：开放区域、时段、人数、讲解语言、无障碍条件
  // -------------------------------------------------------------------------
  publishOpenDay(actor, openDayId, input) {
    this.#require(actor, "publish");
    const state = this.state;
    if (state.openDay && !state.openDay.cancelled) {
      throw new DomainError(ERROR_CODES.INVALID_STATE, "开放日已发布，请使用更新");
    }
    const problems = [];
    for (const slot of input.slots ?? []) {
      if (!slot.id || !slot.starts_at || !slot.ends_at) problems.push("slot 缺少 id/starts_at/ends_at");
      if (slot.capacity !== undefined && (!Number.isInteger(slot.capacity) || slot.capacity < 0)) {
        problems.push(`时段 ${slot.id} 容量必须是非负整数`);
      }
      if (slot.starts_at && slot.ends_at && Date.parse(slot.starts_at) >= Date.parse(slot.ends_at)) {
        problems.push(`时段 ${slot.id} 开始时间必须早于结束时间`);
      }
    }
    if (problems.length) throw new DomainError(ERROR_CODES.VALIDATION, "目录不合法", { problems });

    const payload = {
      name: input.name ?? "",
      summary: input.summary ?? "",
      languages: input.languages ?? [],
      accessibility: input.accessibility ?? {},
      areas: (input.areas ?? []).map((a) => ({
        id: a.id,
        name: a.name ?? a.id,
        accessible: a.accessible ?? true,
        capacityNote: a.capacity_note ?? null,
      })),
      slots: (input.slots ?? []).map((s) => ({
        id: s.id,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
        capacity: s.capacity ?? null,
        languages: s.languages ?? input.languages ?? [],
      })),
      childAssignments: input.child_assignments ?? [],
    };
    return this.#append("VISIT_SLOT_PUBLISHED", openDayId, payload);
  }

  updateOpenDay(actor, patch) {
    this.#require(actor, "publish");
    const state = this.state;
    this.#requireOpen(state);
    const { child_assignments, ...rest } = patch;
    return this.#append("OPEN_DAY_UPDATED", state.openDay.id, {
      ...rest,
      areas: patch.areas?.map((a) => ({
        id: a.id,
        name: a.name ?? a.id,
        accessible: a.accessible ?? true,
        capacityNote: a.capacity_note ?? null,
      })),
      slots: patch.slots?.map((s) => {
        const existing = state.slots.get(s.id);
        return {
          id: s.id,
          startsAt: s.starts_at ?? existing?.startsAt,
          endsAt: s.ends_at ?? existing?.endsAt,
          capacity: s.capacity === undefined ? existing?.capacity ?? null : s.capacity,
          languages: s.languages ?? existing?.languages ?? [],
        };
      }),
      childAssignments: child_assignments,
    });
  }

  cancelOpenDay(actor, reason) {
    this.#require(actor, "publish");
    this.#requireOpen(this.state);
    return this.#append("OPEN_DAY_CANCELLED", this.state.openDay.id, { reason: reason ?? null });
  }

  // -------------------------------------------------------------------------
  // 2. 访客登记同行人与关注事项；取得限时凭证
  // -------------------------------------------------------------------------
  registerVisitor(actor, input) {
    this.#require(actor, "registerVisitor");
    const state = this.state;
    this.#requireOpen(state);
    const slot = state.slots.get(input.slot_id);
    if (!slot) throw new DomainError(ERROR_CODES.NOT_FOUND, `时段不存在：${input.slot_id}`);

    const size = input.party_size ?? 1 + (input.companions?.length ?? 0);
    if (!Number.isInteger(size) || size < 1) {
      throw new DomainError(ERROR_CODES.VALIDATION, "到访人数至少为 1");
    }
    const remaining = slotReservationRemaining(state, slot.id);
    if (remaining !== null && size > remaining) {
      throw new DomainError(ERROR_CODES.CAPACITY_FULL, `时段 ${slot.id} 名额不足`, {
        capacity: slot.capacity,
        remaining,
        requested: size,
      });
    }
    for (const areaId of input.planned_route ?? []) {
      if (!state.areas.has(areaId)) throw new DomainError(ERROR_CODES.VALIDATION, `计划区域不存在：${areaId}`);
    }

    const registrationId = input.registration_id ?? localId("reg");
    const payload = {
      display_name: input.display_name,
      contact_ref: input.contact_ref ?? null, // 接待联系所需，最小保留
      slot_id: slot.id,
      party_size: size,
      companions: (input.companions ?? []).map((c) =>
        typeof c === "string" ? { relation: c } : c,
      ),
      accessibility_needs: input.accessibility_needs ?? [],
      attention_notes: input.attention_notes ?? [],
      language: input.language ?? null,
      planned_route: input.planned_route ?? [],
    };
    this.#append("VISITOR_REGISTERED", registrationId, payload);
    return this.issuePass(actor, registrationId);
  }

  issuePass(actor, registrationId, options = {}) {
    this.#require(actor, "issuePass");
    const state = this.state;
    this.#requireOpen(state);
    const visitor = this.#requireVisitor(state, registrationId);
    const at = options.at ?? this.now();
    if (visitor.pass && !visitor.pass.revoked && Date.parse(visitor.pass.expiresAt) > Date.parse(at)) {
      if (options.supersede !== true) {
        throw new DomainError(ERROR_CODES.INVALID_STATE, "该访客已有有效限时凭证（可 supersede 换发）");
      }
      this.#append("PASS_REVOKED", registrationId, { reason: "replaced" }, at);
    }
    const slot = state.slots.get(options.slot_id ?? visitor.slotId);
    const ttlMinutes = options.ttl_minutes ?? (slot ? minutesBetween(slot.startsAt, slot.endsAt) + 30 : 120);
    const expiresAt = options.expires_at ?? new Date(Date.parse(at) + ttlMinutes * 60000).toISOString();
    const code = options.code ?? localId("pass").toUpperCase();
    return this.#append(
      "PASS_ISSUED",
      registrationId,
      { code, expires_at: expiresAt, slot_id: slot?.id ?? visitor.slotId },
      at,
    );
  }

  revokePass(actor, registrationId, reason) {
    this.#require(actor, "revokePass");
    this.#requireVisitor(this.state, registrationId);
    return this.#append("PASS_REVOKED", registrationId, { reason: reason ?? null });
  }

  // -------------------------------------------------------------------------
  // 3. 在园儿童监护人分别决定观察、摄影、宣传
  // -------------------------------------------------------------------------
  recordConsent(actor, childId, scope, state2 = CONSENT_STATES.GRANTED, meta = {}) {
    this.#require(actor, "recordConsent");
    if (requireEnum(scope, CONSENT_SCOPES, "同意范围")) {
      throw new DomainError(ERROR_CODES.VALIDATION, requireEnum(scope, CONSENT_SCOPES, "同意范围"));
    }
    if (requireEnum(state2, CONSENT_STATES, "同意决定")) {
      throw new DomainError(ERROR_CODES.VALIDATION, requireEnum(state2, CONSENT_STATES, "同意决定"));
    }
    return this.#append("CONSENT_RECORDED", childId, {
      scope,
      state: state2,
      guardian_ref: meta.guardian_ref ?? null,
      note: meta.note ?? null,
    });
  }

  // 撤回：只改变撤回时刻之后的活动；已发布材料另行走处置流程（不删除记录）
  withdrawConsent(actor, childId, scope, meta = {}) {
    this.#require(actor, "recordConsent");
    if (requireEnum(scope, CONSENT_SCOPES, "同意范围")) {
      throw new DomainError(ERROR_CODES.VALIDATION, requireEnum(scope, CONSENT_SCOPES, "同意范围"));
    }
    const child = this.state.children.get(childId);
    if (!child?.consents?.[scope] || child.consents[scope].state !== CONSENT_STATES.GRANTED) {
      throw new DomainError(ERROR_CODES.INVALID_STATE, "只能撤回一项当前有效的授权");
    }
    return this.#append("CONSENT_WITHDRAWN", childId, {
      scope,
      guardian_ref: meta.guardian_ref ?? null,
      note: meta.note ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // 4. 入园 / 临时离场 / 再次进入 / 最终离开（现场容量）
  // -------------------------------------------------------------------------
  checkIn(actor, registrationId, options = {}) {
    this.#require(actor, "movement");
    const state = this.state;
    this.#requireOpen(state);
    const visitor = this.#requireVisitor(state, registrationId);
    const at = options.at ?? this.now();

    const usable = passUsableAt(visitor, at);
    if (!usable.usable) {
      const code = {
        no_pass: ERROR_CODES.PASS_MISSING,
        pass_revoked: ERROR_CODES.PASS_REVOKED,
        registration_cancelled: ERROR_CODES.PASS_REVOKED,
        pass_expired: ERROR_CODES.PASS_EXPIRED,
      }[usable.reason] ?? ERROR_CODES.PASS_MISSING;
      throw new DomainError(code, `凭证不可用：${usable.reason}`, { reason: usable.reason });
    }
    if (isGlobalLockdown(state)) {
      throw new DomainError(ERROR_CODES.GLOBAL_LOCKDOWN, "全园封控中，暂停一切入园");
    }
    if (visitor.status !== VISITOR_STATUS.REGISTERED) {
      throw new DomainError(ERROR_CODES.INVALID_STATE, `当前状态 ${visitor.status} 不能入园`);
    }
    const slotId = usable.pass.slotId;
    const slot = state.slots.get(slotId);
    const occ = slotOccupancy(state, slotId);
    if (slot && slot.capacity !== null && occ.people + visitor.partySize > slot.capacity) {
      throw new DomainError(ERROR_CODES.CAPACITY_FULL, "现场容量已满", {
        capacity: slot.capacity,
        onSite: occ.people,
        arriving: visitor.partySize,
      });
    }
    return this.#append("VISITOR_CHECKED_IN", registrationId, { via: options.via ?? "main" }, at);
  }

  temporarilyExit(actor, registrationId, options = {}) {
    this.#require(actor, "movement");
    const state = this.state;
    const visitor = this.#requireVisitor(state, registrationId);
    if (visitor.status !== VISITOR_STATUS.ON_SITE) {
      throw new DomainError(ERROR_CODES.INVALID_STATE, "只有在园访客可以临时离场");
    }
    return this.#append("VISITOR_TEMPORARILY_EXITED", registrationId, {
      reason: options.reason ?? null,
      expected_return_by: options.expected_return_by ?? null,
    }, options.at ?? this.now());
  }

  reenter(actor, registrationId, options = {}) {
    this.#require(actor, "movement");
    const state = this.state;
    this.#requireOpen(state);
    const visitor = this.#requireVisitor(state, registrationId);
    const at = options.at ?? this.now();

    if (visitor.status !== VISITOR_STATUS.TEMP_OUT) {
      throw new DomainError(ERROR_CODES.INVALID_STATE, "只有临时离场的访客可以再次进入");
    }
    const usable = passUsableAt(visitor, at);
    if (!usable.usable) {
      const code = {
        no_pass: ERROR_CODES.PASS_MISSING,
        pass_revoked: ERROR_CODES.PASS_REVOKED,
        registration_cancelled: ERROR_CODES.PASS_REVOKED,
        pass_expired: ERROR_CODES.PASS_EXPIRED,
      }[usable.reason] ?? ERROR_CODES.PASS_MISSING;
      throw new DomainError(code, `再次进入被拒：${usable.reason}`, { reason: usable.reason });
    }
    if (isGlobalLockdown(state)) {
      throw new DomainError(ERROR_CODES.GLOBAL_LOCKDOWN, "全园封控中，暂停再次进入");
    }
    // 临时离场释放了现场名额，再入时重新校验容量
    const slotId = usable.pass.slotId;
    const slot = state.slots.get(slotId);
    const occ = slotOccupancy(state, slotId);
    if (slot && occ.people + visitor.partySize > slot.capacity) {
      throw new DomainError(ERROR_CODES.CAPACITY_FULL, "现场容量已满，无法再次进入", {
        capacity: slot.capacity,
        onSite: occ.people,
      });
    }
    return this.#append("VISITOR_REENTERED", registrationId, {}, at);
  }

  checkOut(actor, registrationId, options = {}) {
    this.#require(actor, "movement");
    const visitor = this.#requireVisitor(this.state, registrationId);
    if (![VISITOR_STATUS.ON_SITE, VISITOR_STATUS.TEMP_OUT].includes(visitor.status)) {
      throw new DomainError(ERROR_CODES.INVALID_STATE, "该访客当前不在可离场状态");
    }
    return this.#append("VISITOR_CHECKED_OUT", registrationId, {}, options.at ?? this.now());
  }

  // -------------------------------------------------------------------------
  // 5. 区域进出：按该区域儿童监护人的分项同意实时裁定
  // -------------------------------------------------------------------------
  enterArea(actor, registrationId, areaId, options = {}) {
    this.#require(actor, "movement");
    const state = this.state;
    this.#requireOpen(state);
    const visitor = this.#requireVisitor(state, registrationId);
    const at = options.at ?? this.now();

    if (visitor.status !== VISITOR_STATUS.ON_SITE) {
      throw new DomainError(ERROR_CODES.INVALID_STATE, "访客不在园，不能进入区域");
    }
    if (!state.areas.has(areaId)) throw new DomainError(ERROR_CODES.NOT_FOUND, `区域不存在：${areaId}`);

    const pause = areaPauseState(state, areaId, at);
    if (pause.paused) {
      this.#append("ACCESS_REFUSED", registrationId, {
        area_id: areaId,
        reason: pause.scope === "global" ? ERROR_CODES.GLOBAL_LOCKDOWN : ERROR_CODES.ROUTE_PAUSED,
        detail: pause.reason,
      }, at);
      throw new DomainError(
        pause.scope === "global" ? ERROR_CODES.GLOBAL_LOCKDOWN : ERROR_CODES.ROUTE_PAUSED,
        `区域 ${areaId} 当前暂停`,
        { reason: pause.reason },
      );
    }
    const policy = areaPolicy(state, areaId, at);
    if (!policy.observationAllowed) {
      this.#append("ACCESS_REFUSED", registrationId, {
        area_id: areaId,
        reason: ERROR_CODES.OBSERVATION_DENIED,
        detail: { denyingChildren: policy.denyingChildren.observation },
      }, at);
      throw new DomainError(
        ERROR_CODES.OBSERVATION_DENIED,
        `区域 ${areaId} 有在园儿童的监护人未允许观察`,
        { denyingChildren: policy.denyingChildren.observation },
      );
    }
    return this.#append("AREA_ENTERED", registrationId, { area_id: areaId }, at);
  }

  exitArea(actor, registrationId, areaId, options = {}) {
    this.#require(actor, "movement");
    this.#requireVisitor(this.state, registrationId);
    return this.#append(
      "AREA_EXITED",
      registrationId,
      { area_id: areaId },
      options.at ?? this.now(),
    );
  }

  // 拍摄前校验：区域摄影政策 + 取景涉及的每名儿童
  canCapture(state, areaId, childIds = [], at = this.now()) {
    const policy = areaPolicy(state, areaId, at);
    const violations = [];
    for (const childId of childIds.length ? childIds : policy.children) {
      const decision = consentAt(state.children.get(childId), CONSENT_SCOPES.PHOTOGRAPHY, at);
      if (decision.state !== CONSENT_STATES.GRANTED) violations.push(childId);
    }
    return { allowed: violations.length === 0, violations, policy };
  }

  // -------------------------------------------------------------------------
  // 6. 突发照护 / 传染病 / 消防：暂停局部路线（消防为全园），提供改期
  // -------------------------------------------------------------------------
  pauseRoute(actor, input) {
    this.#require(actor, "pauseRoute");
    const state = this.state;
    this.#requireOpen(state);
    const reasonProblem = requireEnum(input.reason, PAUSE_REASONS, "暂停原因");
    if (reasonProblem) throw new DomainError(ERROR_CODES.VALIDATION, reasonProblem);

    const isGlobal = input.reason === GLOBAL_PAUSE_REASON || input.global === true || !input.area_ids?.length;
    const areaIds = isGlobal ? [...state.areas.keys()] : input.area_ids;
    for (const areaId of isGlobal ? [] : input.area_ids) {
      if (!state.areas.has(areaId)) throw new DomainError(ERROR_CODES.NOT_FOUND, `区域不存在：${areaId}`);
    }
    const event = this.#append("ROUTE_PAUSED", state.openDay.id, {
      reason: input.reason,
      area_ids: isGlobal ? [] : input.area_ids,
      note: input.note ?? null,
    });

    // 向受影响家庭提供改期
    const affected = input.offer_reschedule === false
      ? []
      : affectedVisitorIds(state, areaIds, { includePlanned: true, atIso: this.now() });
    const offers = [];
    if (input.new_slot_id) {
      for (const registrationId of affected) {
        offers.push(this.offerReschedule(actor, registrationId, {
          reason: input.reason,
          area_ids: isGlobal ? areaIds : input.area_ids,
          new_slot_id: input.new_slot_id,
        }));
      }
    }
    return { event, affected, offers };
  }

  resumeRoute(actor, input = {}) {
    this.#require(actor, "resumeRoute");
    const state = this.state;
    this.#requireOpen(state);
    const global = input.global === true || (state.globalPause && !input.area_ids?.length);
    return this.#append("ROUTE_RESUMED", state.openDay.id, {
      area_ids: input.area_ids ?? [],
      global: global === true,
    });
  }

  offerReschedule(actor, registrationId, input) {
    this.#require(actor, "reschedule");
    const state = this.state;
    const visitor = this.#requireVisitor(state, registrationId);
    if (!state.slots.has(input.new_slot_id)) {
      throw new DomainError(ERROR_CODES.NOT_FOUND, `改期目标时段不存在：${input.new_slot_id}`);
    }
    const offerId = localId("offer");
    this.#append(
      "RESCHEDULE_OFFERED",
      registrationId,
      {
        offer_id: offerId,
        reason: input.reason ?? null,
        area_ids: input.area_ids ?? visitor.plannedAreaIds ?? [],
        new_slot_id: input.new_slot_id,
      },
      input.at ?? this.now(),
    );
    return { offerId, registrationId, newSlotId: input.new_slot_id };
  }

  respondReschedule(actor, registrationId, offerId, accepted, options = {}) {
    this.#require(actor, "reschedule");
    const at = options.at ?? this.now();
    const state = this.state;
    const visitor = this.#requireVisitor(state, registrationId);
    const offer = visitor.offers.find((o) => o.id === offerId);
    if (!offer) throw new DomainError(ERROR_CODES.NOT_FOUND, "改期邀约不存在");
    if (offer.status !== "pending") throw new DomainError(ERROR_CODES.INVALID_STATE, "邀约已回应");

    if (accepted) {
      if (visitor.onSite) {
        throw new DomainError(
          ERROR_CODES.INVALID_STATE,
          "访客仍在园，请先办理离场再接受改期",
          { status: visitor.status },
        );
      }
      // 接受改期：新时段名额校验
      const remaining = slotReservationRemaining(state, offer.newSlotId);
      if (remaining !== null && visitor.partySize > remaining) {
        throw new DomainError(ERROR_CODES.CAPACITY_FULL, "改期目标时段名额不足", { remaining });
      }
      const acceptedEvent = this.#append(
        "RESCHEDULE_ACCEPTED",
        registrationId,
        { offer_id: offerId, reissue_pass: options.reissue_pass ?? true },
        at,
      );
      // 旧凭证指向旧时段，随改期作废并为新时段换发限时凭证
      if (options.reissue_pass !== false) {
        this.#append("PASS_REVOKED", registrationId, { reason: "rescheduled" }, at);
        this.issuePass(actor, registrationId, { slot_id: offer.newSlotId, at });
      }
      return acceptedEvent;
    }
    return this.#append("RESCHEDULE_DECLINED", registrationId, { offer_id: offerId }, at);
  }

  // -------------------------------------------------------------------------
  // 7. 影像登记与可跟踪处置
  // -------------------------------------------------------------------------
  logMedia(actor, mediaId, input) {
    this.#require(actor, "logMedia");
    const state = this.state;
    const at = input.at ?? this.now();
    const childIds = input.child_ids ?? [];
    for (const childId of childIds) {
      if (!state.children.has(childId)) throw new DomainError(ERROR_CODES.NOT_FOUND, `儿童不存在：${childId}`);
    }
    // 登记时即按当时授权裁定：拍摄授权或宣传授权缺失的影像不得进入“保留”
    let initialStatus = MEDIA_STATUSES.LOGGED;
    if (input.initial_status) {
      initialStatus = input.initial_status;
    } else if (childIds.length) {
      const isPromotion = input.purpose === "promotion" || input.captured_by === "center";
      // 个人影像只需摄影授权；园方宣传还需宣传授权（两者分别由监护人决定）
      const requiredScopes = isPromotion
        ? [CONSENT_SCOPES.PHOTOGRAPHY, CONSENT_SCOPES.PROMOTION]
        : [CONSENT_SCOPES.PHOTOGRAPHY];
      const missing = childIds.filter((id) =>
        requiredScopes.some((scope) => consentAt(state.children.get(id), scope, at).state !== CONSENT_STATES.GRANTED),
      );
      initialStatus = missing.length === 0 ? MEDIA_STATUSES.RETAINED : MEDIA_STATUSES.DISPOSING;
    }

    return this.#append("MEDIA_LOGGED", mediaId, {
      area_id: input.area_id ?? null,
      visitor_id: input.visitor_id ?? null,
      captured_by: input.captured_by ?? "visitor",
      purpose: input.purpose ?? "personal",
      child_ids: childIds,
      channels: input.channels ?? [],
      descriptor: input.descriptor ?? "",
      captured_at: at,
      initial_status: initialStatus,
    });
  }

  // 撤回授权后：已发布材料不删除，而是标记进入处置流程
  flagMediaForDisposal(actor, mediaId, reason) {
    this.#require(actor, "disposal");
    const item = this.state.media.get(mediaId);
    if (!item) throw new DomainError(ERROR_CODES.NOT_FOUND, `影像不存在：${mediaId}`);
    if (item.status === MEDIA_STATUSES.DISPOSED) {
      throw new DomainError(ERROR_CODES.INVALID_STATE, "影像处置流程已完成");
    }
    return this.#append("MEDIA_FLAGGED", mediaId, { reason: reason ?? "consent_withdrawn" });
  }

  resolveMediaRequest(actor, mediaId, decision, note) {
    this.#require(actor, "disposal");
    if (!["retain", "dispose"].includes(decision)) {
      throw new DomainError(ERROR_CODES.VALIDATION, "决定必须是 retain 或 dispose");
    }
    if (!this.state.media.get(mediaId)) throw new DomainError(ERROR_CODES.NOT_FOUND, `影像不存在：${mediaId}`);
    return this.#append("MEDIA_REQUEST_RESOLVED", mediaId, { decision, note: note ?? null });
  }

  // 推进处置流程步骤；必须按 MEDIA_DISPOSAL_STEPS 顺序进行，全程可跟踪
  recordDisposalStep(actor, mediaId, step, input = {}) {
    this.#require(actor, "disposal");
    const state = this.state;
    const item = state.media.get(mediaId);
    if (!item) throw new DomainError(ERROR_CODES.NOT_FOUND, `影像不存在：${mediaId}`);
    const idx = MEDIA_DISPOSAL_STEPS.indexOf(step);
    if (idx === -1) throw new DomainError(ERROR_CODES.VALIDATION, `非法处置步骤：${step}`);
    const done = item.disposalSteps.map((s) => s.step);
    for (let i = 0; i < idx; i += 1) {
      if (!done.includes(MEDIA_DISPOSAL_STEPS[i])) {
        throw new DomainError(ERROR_CODES.DISPOSAL_INCOMPLETE, `必须先完成步骤：${MEDIA_DISPOSAL_STEPS[i]}`, {
          next: MEDIA_DISPOSAL_STEPS[done.length],
        });
      }
    }
    return this.#append("MEDIA_DISPOSAL_STEP_RECORDED", mediaId, {
      step,
      by: input.by ?? actor.id ?? null,
      note: input.note ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // 8. 投诉 / 删除请求案件
  // -------------------------------------------------------------------------
  openCase(actor, input) {
    this.#require(actor, "case");
    const problem = requireEnum(input.kind, CASE_KINDS, "案件种类");
    if (problem) throw new DomainError(ERROR_CODES.VALIDATION, problem);
    const caseId = input.case_id ?? localId("case");
    return this.#append("CASE_OPENED", caseId, {
      kind: input.kind,
      subject: input.subject ?? null,
      media_ids: input.media_ids ?? [],
      summary: input.summary ?? "",
    });
  }

  advanceCase(actor, caseId, stage, note) {
    this.#require(actor, "case");
    const kase = this.state.cases.get(caseId);
    if (!kase) throw new DomainError(ERROR_CODES.NOT_FOUND, `案件不存在：${caseId}`);
    const idx = CASE_STAGES.indexOf(stage);
    if (idx === -1) throw new DomainError(ERROR_CODES.VALIDATION, `非法案件阶段：${stage}`);
    const currentIdx = CASE_STAGES.indexOf(kase.stage);
    if (idx <= currentIdx) throw new DomainError(ERROR_CODES.INVALID_STATE, "案件只能向前推进");
    return this.#append("CASE_STAGE_REACHED", caseId, { stage, note: note ?? null });
  }

  closeCase(actor, caseId, resolution) {
    this.#require(actor, "case");
    if (!this.state.cases.get(caseId)) throw new DomainError(ERROR_CODES.NOT_FOUND, `案件不存在：${caseId}`);
    return this.#append("CASE_CLOSED", caseId, { resolution: resolution ?? null });
  }

  // -------------------------------------------------------------------------
  // 9. 结束开放日（仍有访客在园时需显式确认）
  // -------------------------------------------------------------------------
  closeOpenDay(actor, options = {}) {
    this.#require(actor, "close");
    const state = this.state;
    this.#requireOpen(state);
    const onSite = [...state.visitors.values()].filter((v) => v.onSite);
    if (onSite.length && options.force !== true) {
      throw new DomainError(ERROR_CODES.VISITORS_ON_SITE, "仍有访客在园，结束前请确认全部离场", {
        visitors: onSite.map((v) => v.registrationId),
      });
    }
    return this.#append("EVENT_CLOSED", state.openDay.id, { forced: options.force === true });
  }
}

function minutesBetween(startIso, endIso) {
  return Math.max(1, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000));
}
