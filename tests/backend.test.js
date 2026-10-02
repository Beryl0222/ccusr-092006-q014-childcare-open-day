import assert from "node:assert/strict";
import test from "node:test";
import { validateEvent, EVENT_KINDS } from "../src/childcare_open_day.js";
import { createEventStore, OpenDayCoordinator, DomainError } from "../src/backend.js";

const OD = "od-2026-10-10";

// 固定时钟：开放日 10:00–12:00
function coordinator() {
  let t = Date.parse("2026-10-10T10:00:00+08:00");
  const clock = () => new Date(t);
  const coord = new OpenDayCoordinator(createEventStore(), { clock });
  coord.__advance = (ms) => {
    t += ms;
  };
  coord.__setTime = (iso) => {
    t = Date.parse(iso);
  };
  return coord;
}

function schedule(coord, { siteCap = 4, s1Cap = 4, s2Cap = 4 } = {}) {
  coord.scheduleOpenDay({
    open_day_id: OD,
    site_capacity: siteCap,
    languages: ["zh-CN", "en"],
    accessibility: "全园无台阶，入口有无障碍坡道",
    areas: [
      { area_id: "class-a", name: "小班教室", capacity: 3, accessible: true },
      { area_id: "nap-room", name: "午休室", capacity: 1, accessible: true },
      { area_id: "hall", name: "多功能厅", capacity: 6, accessible: false, accessibility_note: "二层无电梯" },
    ],
    slots: [
      { slot_id: "s1", start_at: "2026-10-10T10:00:00+08:00", end_at: "2026-10-10T11:00:00+08:00", capacity: s1Cap, area_ids: ["class-a", "nap-room"] },
      { slot_id: "s2", start_at: "2026-10-10T11:00:00+08:00", end_at: "2026-10-10T12:00:00+08:00", capacity: s2Cap, area_ids: ["class-a", "hall"] },
    ],
  });
}

function registerAndPass(coord, visitorId, slotId = "s1", companions = [], extra = {}) {
  coord.registerVisitor({
    open_day_id: OD,
    visitor_id: visitorId,
    slot_id: slotId,
    display_name: `访客${visitorId}`,
    companions,
    access_needs: extra.access_needs ?? "",
    focus_areas: extra.focus_areas ?? ["class-a"],
    languages: extra.languages ?? ["zh-CN"],
    contact: "should-stay-hidden@example.test",
  });
  return coord.issueCredential({ open_day_id: OD, visitor_id: visitorId, ...(extra.credential ?? {}) });
}

function expectError(fn, code) {
  assert.throws(fn, (err) => err instanceof DomainError && err.code === code, `应抛出 ${code}`);
}

// ---------- 发布与登记 ----------

test("园方发布区域、时段、人数、讲解语言与无障碍条件", () => {
  const c = coordinator();
  schedule(c);
  const view = c.staffView(OD, "COORDINATOR");
  assert.equal(view.site.capacity, 4);
  assert.deepEqual(view.paused_areas, []);
});

test("时段人数上限在登记阶段即生效", () => {
  const c = coordinator();
  schedule(c);
  // s1 容量 4 人：两组各 2 人正好满
  registerAndPass(c, "v1", "s1", [{ kind: "ADULT" }]);
  registerAndPass(c, "v2", "s1", [{ kind: "CHILD" }]);
  expectError(() => registerAndPass(c, "v3", "s1"), "SLOT_FULL");
});

test("登记必须引用已发布区域和时段", () => {
  const c = coordinator();
  schedule(c);
  expectError(() => c.registerVisitor({ open_day_id: OD, visitor_id: "v1", slot_id: "nope" }), "SLOT_NOT_FOUND");
});

// ---------- 凭证时效 ----------

test("限时凭证：未到生效时间或超过有效时段不得入园", () => {
  const c = coordinator();
  schedule(c);
  registerAndPass(c, "v1");
  c.__setTime("2026-10-10T09:44:00+08:00"); // 凭证 10:00 才生效
  expectError(() => c.checkIn({ open_day_id: OD, visitor_id: "v1" }), "CREDENTIAL_NOT_VALID_YET");
  c.__setTime("2026-10-10T11:16:00+08:00"); // 凭证 11:00 失效（且超出 15 分钟入园宽限）
  expectError(() => c.checkIn({ open_day_id: OD, visitor_id: "v1" }), "CREDENTIAL_EXPIRED");
});

test("吊销凭证后无法入园，历史记录仍保留", () => {
  const c = coordinator();
  schedule(c);
  const code = registerAndPass(c, "v1");
  c.revokeCredential({ open_day_id: OD, code, reason: "SECURITY" });
  expectError(() => c.checkIn({ open_day_id: OD, visitor_id: "v1" }), "CREDENTIAL_REVOKED");
  const revoked = c.events().find((e) => e.kind === "CREDENTIAL_REVOKED");
  assert.ok(revoked, "吊销事件必须保留在事件流中");
});

// ---------- 入园 / 临时离场 / 再进入 / 容量 ----------

test("入园、临时离场释放容量、再次进入重新核对容量", () => {
  const c = coordinator();
  // 时段预约容量充足（8），现场同时容量 4 才是约束
  schedule(c, { s1Cap: 8, s2Cap: 8 });
  // v1 两人、v2 两人，现场容量 4 正好满
  registerAndPass(c, "v1", "s1", [{ kind: "ADULT" }]);
  registerAndPass(c, "v2", "s1", [{ kind: "ADULT" }]);
  c.checkIn({ open_day_id: OD, visitor_id: "v1" });
  c.checkIn({ open_day_id: OD, visitor_id: "v2" });

  // 已满，未入园的 v3 无法进入
  registerAndPass(c, "v3");
  expectError(() => c.checkIn({ open_day_id: OD, visitor_id: "v3" }), "SITE_FULL");

  // v1 临时离场 → 释放两个名额 → v3 可以入园
  c.tempExit({ open_day_id: OD, visitor_id: "v1" });
  c.checkIn({ open_day_id: OD, visitor_id: "v3" });

  // v1 想再进，但现场又满了（v2 两人 + v3 两人）
  expectError(() => c.reenter({ open_day_id: OD, visitor_id: "v1" }), "SITE_FULL");

  // v3 最终离园 → v1 可再次进入
  c.checkOut({ open_day_id: OD, visitor_id: "v3" });
  c.reenter({ open_day_id: OD, visitor_id: "v1" });
  assert.equal(c.staffView(OD, "RECEPTION").site.inside_now, 4);
});

test("最终离园后不得再次入园", () => {
  const c = coordinator();
  schedule(c);
  registerAndPass(c, "v1");
  c.checkIn({ open_day_id: OD, visitor_id: "v1" });
  c.checkOut({ open_day_id: OD, visitor_id: "v1" });
  expectError(() => c.checkIn({ open_day_id: OD, visitor_id: "v1" }), "ALREADY_CHECKED_OUT");
});

test("重复入园、未入园临时离场均被拒绝", () => {
  const c = coordinator();
  schedule(c);
  registerAndPass(c, "v1");
  c.checkIn({ open_day_id: OD, visitor_id: "v1" });
  expectError(() => c.checkIn({ open_day_id: OD, visitor_id: "v1" }), "ALREADY_INSIDE");
  registerAndPass(c, "v2"); // 已登记但未入园
  expectError(() => c.tempExit({ open_day_id: OD, visitor_id: "v2" }), "NOT_INSIDE");
});

test("区域容量与区域到访记录", () => {
  const c = coordinator();
  schedule(c);
  // nap-room 容量 1：v1 单人可进，v2 两人不可进
  registerAndPass(c, "v1", "s1", [], { focus_areas: ["nap-room"] });
  registerAndPass(c, "v2", "s1", [], { focus_areas: ["nap-room"] });
  c.checkIn({ open_day_id: OD, visitor_id: "v1" });
  c.checkIn({ open_day_id: OD, visitor_id: "v2" });
  c.logAreaEntry({ open_day_id: OD, visitor_id: "v1", area_id: "nap-room" });
  expectError(() => c.logAreaEntry({ open_day_id: OD, visitor_id: "v2", area_id: "nap-room" }), "AREA_FULL");
  // 区域进出配对：离开后 v2 可进入
  c.logAreaExit({ open_day_id: OD, visitor_id: "v1", area_id: "nap-room" });
  c.logAreaEntry({ open_day_id: OD, visitor_id: "v2", area_id: "nap-room" });
  const report = c.dailyReport(OD);
  const v1 = report.visitors.find((v) => v.visitor_id === "v1");
  assert.deepEqual(v1.areas_visited.map((a) => a.area_id), ["nap-room"]);
  assert.equal(v1.areas_visited[0].visits, 1);
});

// ---------- 监护人三类授权 ----------

test("观察、摄影、宣传三类授权分别决定；默认未决定即禁止发布", () => {
  const c = coordinator();
  schedule(c);
  c.recordConsent({ open_day_id: OD, child_id: "child-1", scope: "OBSERVATION", decision: "ALLOWED" });
  c.recordConsent({ open_day_id: OD, child_id: "child-1", scope: "PHOTOGRAPHY", decision: "DENIED" });
  const status = c.consentStatus(OD, "child-1");
  assert.equal(status.OBSERVATION, "ALLOWED");
  assert.equal(status.PHOTOGRAPHY, "DENIED");
  assert.equal(status.PROMOTION, "UNDECIDED");
  expectError(
    () => c.publishMedia({ open_day_id: OD, media_id: "m1", scope: "PROMOTION", child_ids: ["child-1"] }),
    "CONSENT_MISSING",
  );
  expectError(
    () => c.publishMedia({ open_day_id: OD, media_id: "m2", scope: "PHOTOGRAPHY", child_ids: ["child-1"] }),
    "CONSENT_MISSING",
  );
});

test("撤回只影响后续：已发布材料进入处置流程而非从记录消失", () => {
  const c = coordinator();
  schedule(c);
  c.recordConsent({ open_day_id: OD, child_id: "child-1", scope: "PHOTOGRAPHY", decision: "ALLOWED" });
  c.publishMedia({ open_day_id: OD, media_id: "m1", scope: "PHOTOGRAPHY", child_ids: ["child-1"] });

  // 撤回后不能再发布新影像
  c.withdrawConsent({ open_day_id: OD, child_id: "child-1", scope: "PHOTOGRAPHY" });
  expectError(
    () => c.publishMedia({ open_day_id: OD, media_id: "m2", scope: "PHOTOGRAPHY", child_ids: ["child-1"] }),
    "CONSENT_MISSING",
  );

  // 已发布的 m1 自动进入处置流程（PENDING），但 MEDIA_PUBLISHED 与 CONSENT_RECORDED 事件都还在
  const report = c.dailyReport(OD);
  const m1 = report.media.find((m) => m.media_id === "m1");
  assert.equal(m1.stage, "IN_PROCESS");
  assert.equal(m1.requests[0].stage, "PENDING");
  assert.ok(c.events().some((e) => e.kind === "MEDIA_PUBLISHED" && e.subject_id === "m1"));

  // 处置流程可跟踪：要求下架 → 已下架
  const reqId = m1.requests[0].request_id;
  c.resolveMediaRequest({ open_day_id: OD, media_id: "m1", request_id: reqId, resolution: "TAKEDOWN_REQUESTED" });
  c.resolveMediaRequest({ open_day_id: OD, media_id: "m1", request_id: reqId, resolution: "TAKEN_DOWN", note: "平台与本地副本均已移除" });
  const after = c.dailyReport(OD).media.find((m) => m.media_id === "m1");
  assert.equal(after.stage, "TAKEN_DOWN");
  assert.equal(after.retained, false);
  assert.ok(after.requests[0].resolved_at, "终局必须有处置时间");
  // 终局不可反复改
  expectError(
    () => c.resolveMediaRequest({ open_day_id: OD, media_id: "m1", request_id: reqId, resolution: "RETAINED_JUSTIFIED" }),
    "REQUEST_CLOSED",
  );
});

test("观察授权撤回不影响此前的摄影/宣传发布", () => {
  const c = coordinator();
  schedule(c);
  c.recordConsent({ open_day_id: OD, child_id: "child-1", scope: "PROMOTION", decision: "ALLOWED" });
  c.publishMedia({ open_day_id: OD, media_id: "m1", scope: "PROMOTION", child_ids: ["child-1"] });
  // 未做过 OBSERVATION 决定的儿童也可以直接撤回
  c.withdrawConsent({ open_day_id: OD, child_id: "child-1", scope: "OBSERVATION" });
  const m1 = c.dailyReport(OD).media.find((m) => m.media_id === "m1");
  assert.equal(m1.stage, "RETAINED", "不同范围的撤回不应牵连宣传材料");
});

// ---------- 突发状况：局部路线暂停与改期 ----------

test("消防要求暂停区域后不得进入，恢复后可进入", () => {
  const c = coordinator();
  schedule(c);
  registerAndPass(c, "v1");
  c.checkIn({ open_day_id: OD, visitor_id: "v1" });
  c.pauseArea({ open_day_id: OD, area_id: "class-a", reason: "FIRE_SAFETY", note: "消防通道检查" });
  expectError(() => c.logAreaEntry({ open_day_id: OD, visitor_id: "v1", area_id: "class-a" }), "ROUTE_PAUSED");
  c.resumeArea({ open_day_id: OD, area_id: "class-a" });
  c.logAreaEntry({ open_day_id: OD, visitor_id: "v1", area_id: "class-a" });
});

test("传染病风险暂停后向受影响家庭提供改期，接受后旧凭证失效并发放新凭证", () => {
  const c = coordinator();
  schedule(c);
  registerAndPass(c, "v1", "s1");
  c.checkIn({ open_day_id: OD, visitor_id: "v1" });
  c.logAreaEntry({ open_day_id: OD, visitor_id: "v1", area_id: "class-a" });
  // v2 预约了 s1（路线含 class-a），尚未入园，也应被视为受影响家庭
  registerAndPass(c, "v2", "s1");

  c.pauseArea({ open_day_id: OD, area_id: "class-a", reason: "INFECTION_RISK" });
  const result = c.offerReschedule({ open_day_id: OD, area_id: "class-a", to_slot_id: "s2" });
  assert.deepEqual(result.offered.sort(), ["v1", "v2"]);

  // v2 接受改期：名额从 s1 转到 s2，旧凭证吊销、新凭证发放
  const oldCode = c.staffView(OD, "RECEPTION").visitors.find((v) => v.visitor_id === "v2").credential.code;
  c.respondReschedule({ open_day_id: OD, visitor_id: "v2", status: "ACCEPTED" });
  const v2View = c.staffView(OD, "RECEPTION").visitors.find((v) => v.visitor_id === "v2");
  assert.equal(v2View.slot_id, "s2");
  assert.equal(v2View.credential.status, "ISSUED");
  assert.notEqual(v2View.credential.code, oldCode);
  const old = c.events().filter((e) => e.kind === "CREDENTIAL_REVOKED").map((e) => e.payload.code);
  assert.ok(old.includes(oldCode), "旧凭证必须吊销留痕");

  // 新凭证在 s1 时段内尚未生效，s2 时段才可以入园
  expectError(() => c.checkIn({ open_day_id: OD, visitor_id: "v2" }), "CREDENTIAL_NOT_VALID_YET");

  // v1 当时正在暂停区域内，接受改期后当前到访自动结束、容量释放，
  // 凭新凭证在 s2 重新入园
  c.respondReschedule({ open_day_id: OD, visitor_id: "v1", status: "ACCEPTED" });
  const v1Row = c.dailyReport(OD).visitors.find((v) => v.visitor_id === "v1");
  assert.equal(v1Row.status, "RESCHEDULED");
  assert.equal(v1Row.credential.status, "ISSUED");

  c.__advance(60 * 60_000); // 11:00，s2 开始
  c.checkIn({ open_day_id: OD, visitor_id: "v2" });
  c.checkIn({ open_day_id: OD, visitor_id: "v1" });
  assert.equal(c.staffView(OD, "RECEPTION").site.inside_now, 2);
});

test("改期目标时段满员时提议跳过容量不足的家庭", () => {
  const c = coordinator();
  schedule(c);
  registerAndPass(c, "v1", "s1", [{ kind: "ADULT" }, { kind: "ADULT" }]); // 3 人
  registerAndPass(c, "v2", "s2", [{ kind: "ADULT" }, { kind: "ADULT" }]); // s2 已占 3
  c.pauseArea({ open_day_id: OD, area_id: "class-a", reason: "CARE_EMERGENCY" });
  const result = c.offerReschedule({ open_day_id: OD, area_id: "class-a", to_slot_id: "s2" });
  // s2 只剩 1 个名额，3 人家庭放不下，列为受影响但不发出提议
  assert.deepEqual(result.affected, ["v1"]);
  assert.deepEqual(result.offered, []);
  assert.deepEqual(result.skipped_due_to_capacity, ["v1"]);
  expectError(() => c.respondReschedule({ open_day_id: OD, visitor_id: "v1", status: "ACCEPTED" }), "NO_OFFER");
});

// ---------- 员工数据最小化 ----------

test("接待视图只含接待所需字段，看不到联系方式、授权与投诉正文", () => {
  const c = coordinator();
  schedule(c);
  registerAndPass(c, "v1");
  c.recordConsent({ open_day_id: OD, child_id: "child-1", scope: "PHOTOGRAPHY", decision: "ALLOWED" });
  c.fileComplaint({ open_day_id: OD, complaint_id: "cp1", summary: "接待不应看到这段投诉正文" });
  const view = c.staffView(OD, "RECEPTION");
  const blob = JSON.stringify(view);
  assert.ok(!blob.includes("should-stay-hidden"), "联系方式不得出现在接待视图");
  assert.ok(!blob.includes("接待不应看到"), "投诉正文不得出现在接待视图");
  assert.ok(!blob.includes("guardian"), "授权资料不得出现在接待视图");
  assert.ok(!JSON.stringify(view).includes("consent"));
});

test("引导视图只看到在园访客及其关注区域、语言与暂停信息", () => {
  const c = coordinator();
  schedule(c);
  registerAndPass(c, "v1", "s1", [], { focus_areas: ["class-a"], languages: ["en"] });
  registerAndPass(c, "v2", "s2");
  c.checkIn({ open_day_id: OD, visitor_id: "v1" });
  const view = c.staffView(OD, "GUIDE");
  assert.deepEqual(view.visitors.map((v) => v.visitor_id), ["v1"], "未入园访客不应出现在引导视图");
  assert.deepEqual(view.visitors[0].focus_areas, ["class-a"]);
  assert.deepEqual(view.visitors[0].languages, ["en"]);
});

test("未知角色被拒绝", () => {
  const c = coordinator();
  schedule(c);
  expectError(() => c.staffView(OD, "VOLUNTEER"), "BAD_ROLE");
});

test("观察授权落地到引导视图：受限儿童以区域计数呈现、不识别身份", () => {
  const c = coordinator();
  schedule(c);
  c.assignChildArea({ open_day_id: OD, child_id: "child-1", area_id: "class-a" });
  c.assignChildArea({ open_day_id: OD, child_id: "child-2", area_id: "class-a" });
  c.assignChildArea({ open_day_id: OD, child_id: "child-3", area_id: "nap-room" });
  c.recordConsent({ open_day_id: OD, child_id: "child-1", scope: "OBSERVATION", decision: "ALLOWED" });
  // child-2 未决定、child-3 明确拒绝
  c.recordConsent({ open_day_id: OD, child_id: "child-3", scope: "OBSERVATION", decision: "DENIED" });
  const view = c.staffView(OD, "GUIDE");
  const a = view.areas.find((x) => x.area_id === "class-a");
  const nap = view.areas.find((x) => x.area_id === "nap-room");
  assert.equal(a.observation_restricted_children, 1);
  assert.equal(nap.observation_restricted_children, 1);
  // 引导视图不出现任何具体儿童标识
  assert.ok(!JSON.stringify(view).includes("child-2"));
});

// ---------- 投诉与删除请求流转 ----------

test("投诉可登记并处理，闭园后仍可继续流转", () => {
  const c = coordinator();
  schedule(c);
  c.fileComplaint({ open_day_id: OD, complaint_id: "cp1", category: "PHOTOGRAPHY", summary: "希望核实一张照片的授权" });
  c.closeOpenDay(OD);
  // 闭园后投诉仍可处理（删除请求同理，流程不能因闭园而丢）
  c.resolveComplaint({ open_day_id: OD, complaint_id: "cp1", resolution: "已核对授权依据，照片保留并向家长说明" });
  const cp = c.dailyReport(OD).complaints.find((x) => x.complaint_id === "cp1");
  assert.equal(cp.status, "RESOLVED");
});

test("手动删除请求：从登记到下架全程可跟踪", () => {
  const c = coordinator();
  schedule(c);
  c.recordConsent({ open_day_id: OD, child_id: "child-1", scope: "PROMOTION", decision: "ALLOWED" });
  c.publishMedia({ open_day_id: OD, media_id: "m1", scope: "PROMOTION", child_ids: ["child-1"] });
  c.flagMedia({ open_day_id: OD, media_id: "m1", request_id: "rr1", reason: "DELETE_REQUEST", requester_ref: "guardian-child-1" });
  expectError(
    () => c.flagMedia({ open_day_id: OD, media_id: "m1", request_id: "rr2" }),
    "REQUEST_OPEN",
  );
  c.resolveMediaRequest({ open_day_id: OD, media_id: "m1", request_id: "rr1", resolution: "TAKEDOWN_REQUESTED" });
  c.resolveMediaRequest({ open_day_id: OD, media_id: "m1", request_id: "rr1", resolution: "TAKEN_DOWN" });
  const events = c.events().map((e) => e.kind);
  assert.ok(events.includes("MEDIA_RETENTION_FLAGGED"));
  assert.ok(events.includes("MEDIA_PUBLISHED"), "原始发布记录不删除");
});

// ---------- 闭园日报 ----------

test("闭园后现场操作冻结，但查询与处置流程继续", () => {
  const c = coordinator();
  schedule(c);
  registerAndPass(c, "v1");
  c.checkIn({ open_day_id: OD, visitor_id: "v1" });
  c.logAreaEntry({ open_day_id: OD, visitor_id: "v1", area_id: "class-a" });
  c.logAreaExit({ open_day_id: OD, visitor_id: "v1", area_id: "class-a" });
  c.checkOut({ open_day_id: OD, visitor_id: "v1" });
  c.closeOpenDay(OD);
  expectError(() => c.checkIn({ open_day_id: OD, visitor_id: "v1" }), "OPEN_DAY_CLOSED");
  expectError(() => c.pauseArea({ open_day_id: OD, area_id: "class-a", reason: "FIRE_SAFETY" }), "OPEN_DAY_CLOSED");
});

test("负责人日报说清到访区域、保留影像与请求进度", () => {
  const c = coordinator();
  schedule(c);
  registerAndPass(c, "v1");
  c.checkIn({ open_day_id: OD, visitor_id: "v1" });
  c.logAreaEntry({ open_day_id: OD, visitor_id: "v1", area_id: "class-a" });
  c.logAreaExit({ open_day_id: OD, visitor_id: "v1", area_id: "class-a" });
  c.logAreaEntry({ open_day_id: OD, visitor_id: "v1", area_id: "nap-room" });
  c.checkOut({ open_day_id: OD, visitor_id: "v1" });

  c.recordConsent({ open_day_id: OD, child_id: "child-1", scope: "PROMOTION", decision: "ALLOWED" });
  c.publishMedia({ open_day_id: OD, media_id: "m-keep", scope: "PROMOTION", child_ids: ["child-1"] });

  c.recordConsent({ open_day_id: OD, child_id: "child-2", scope: "PHOTOGRAPHY", decision: "ALLOWED" });
  c.publishMedia({ open_day_id: OD, media_id: "m-down", scope: "PHOTOGRAPHY", child_ids: ["child-2"] });
  c.flagMedia({ open_day_id: OD, media_id: "m-down", request_id: "rr-down" });

  c.fileComplaint({ open_day_id: OD, complaint_id: "cp1", category: "PHOTOGRAPHY", summary: "核实摄影授权" });

  const report = c.dailyReport(OD);
  const v1 = report.visitors.find((v) => v.visitor_id === "v1");
  assert.deepEqual(v1.areas_visited.map((a) => a.area_id), ["class-a", "nap-room"]);
  const keep = report.media.find((m) => m.media_id === "m-keep");
  const down = report.media.find((m) => m.media_id === "m-down");
  assert.equal(keep.stage, "RETAINED", "无处置请求的影像被允许保留");
  assert.equal(down.stage, "IN_PROCESS", "删除请求进行中可在日报中看到进度");
  assert.equal(report.complaints[0].status, "OPEN");
  assert.ok(report.site.peak_inside >= 1);

  // 负责人视图就是完整日报
  assert.equal(c.staffView(OD, "DIRECTOR").report.visitors.length, 1);
});

// ---------- 事件契约 ----------

test("协调器写入的所有事件都符合领域约定", () => {
  const c = coordinator();
  schedule(c);
  registerAndPass(c, "v1");
  c.checkIn({ open_day_id: OD, visitor_id: "v1" });
  c.logAreaEntry({ open_day_id: OD, visitor_id: "v1", area_id: "class-a" });
  c.recordConsent({ open_day_id: OD, child_id: "child-1", scope: "PHOTOGRAPHY", decision: "ALLOWED" });
  c.publishMedia({ open_day_id: OD, media_id: "m1", scope: "PHOTOGRAPHY", child_ids: ["child-1"] });
  c.withdrawConsent({ open_day_id: OD, child_id: "child-1", scope: "PHOTOGRAPHY" });
  c.pauseArea({ open_day_id: OD, area_id: "nap-room", reason: "CARE_EMERGENCY" });
  c.fileComplaint({ open_day_id: OD, complaint_id: "cp1" });
  for (const record of c.events()) {
    assert.deepEqual(validateEvent(record), [], `${record.kind} 应通过校验`);
    assert.ok(EVENT_KINDS.includes(record.kind));
  }
});

test("非法枚举值无法写入事件存储", () => {
  const store = createEventStore();
  assert.throws(() =>
    store.append({
      event_id: "bad1",
      kind: "ROUTE_PAUSED",
      occurred_at: "2026-10-10T10:00:00+08:00",
      subject_id: OD,
      payload: { reason: "WEATHER" },
    }),
  );
});
