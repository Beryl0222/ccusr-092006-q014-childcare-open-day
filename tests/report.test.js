import assert from "node:assert/strict";
import test from "node:test";
import {
  CASE_KINDS,
  CONSENT_SCOPES,
  CONSENT_STATES,
  MEDIA_DISPOSAL_STEPS,
  MEDIA_STATUSES,
  PAUSE_REASONS,
} from "../src/childcare_open_day.js";
import { ERROR_CODES } from "../src/errors.js";
import { ownerClosingReport } from "../src/views.js";
import { makeFixture, IDS } from "./fixtures.js";

function fullDay() {
  const f = makeFixture();
  f.publish();
  f.grantObservationAndPhoto();
  svcConsentForPromo(f);
  f.setTime("2026-10-02T09:00:00+08:00");

  const v1 = f.registerVisitor({ display_name: "林女士", planned_route: [IDS.classA, IDS.yard] });
  const v2 = f.registerVisitor({ display_name: "赵先生", slot_id: IDS.slot2, party_size: 2 });

  const { svc, actors } = f;
  svc.checkIn(actors.reception, v1);
  svc.enterArea(actors.reception, v1, IDS.classA, { at: "2026-10-02T09:05+08:00" });
  svc.exitArea(actors.reception, v1, IDS.classA, { at: "2026-10-02T09:20+08:00" });
  svc.enterArea(actors.reception, v1, IDS.yard, { at: "2026-10-02T09:25+08:00" });

  // 园方宣传照（含 c1，已授权宣传）
  svc.logMedia(actors.owner, "m-promo", {
    area_id: IDS.classA,
    captured_by: "center",
    purpose: "promotion",
    channels: ["official-account"],
    child_ids: [IDS.child1],
  });

  // 活动场局部暂停并提供改期
  svc.pauseRoute(actors.safety, {
    reason: PAUSE_REASONS.INFECTION_RISK,
    area_ids: [IDS.yard],
    note: "同班出现症状",
    new_slot_id: IDS.slot2,
  });
  svc.resumeRoute(actors.safety, { area_ids: [IDS.yard] });

  svc.exitArea(actors.reception, v1, IDS.yard, { at: "2026-10-02T09:40+08:00" });
  svc.checkOut(actors.reception, v1, { at: "2026-10-02T09:55+08:00" });

  return { ...f, v1, v2 };
}

function svcConsentForPromo(f) {
  f.svc.recordConsent(f.actors.owner, IDS.child1, CONSENT_SCOPES.PROMOTION, CONSENT_STATES.GRANTED);
}

test("闭园报告说清每位访客到过哪些区域（含时间）", () => {
  const { svc, v1 } = fullDay();
  const report = ownerClosingReport(svc.state);
  const row = report.visitors.find((v) => v.registration_id === v1);
  assert.deepEqual(row.areas_visited, [IDS.classA, IDS.yard]);
  assert.equal(Date.parse(row.area_visits[0].entered_at), Date.parse("2026-10-02T09:05+08:00"));
  assert.equal(Date.parse(row.area_visits[0].exited_at), Date.parse("2026-10-02T09:20+08:00"));
  assert.equal(row.final_status, "left");
});

test("闭园报告列出哪些影像被允许保留、哪些在处置及当前步骤", () => {
  const { svc, actors, v1 } = fullDay();
  // 撤回 c1 宣传授权，既有宣传照进入处置并推进两步
  svc.withdrawConsent(actors.owner, IDS.child1, CONSENT_SCOPES.PROMOTION);
  svc.flagMediaForDisposal(actors.owner, "m-promo", "family request");
  svc.recordDisposalStep(actors.owner, "m-promo", MEDIA_DISPOSAL_STEPS[0]);
  svc.recordDisposalStep(actors.owner, "m-promo", MEDIA_DISPOSAL_STEPS[1]);

  const report = ownerClosingReport(svc.state);
  const media = report.media.find((m) => m.media_id === "m-promo");
  assert.equal(media.status, MEDIA_STATUSES.DISPOSING);
  assert.equal(media.retention_allowed, false);
  assert.equal(media.disposal.current_step, MEDIA_DISPOSAL_STEPS[1]);
  assert.equal(media.disposal.next_step, MEDIA_DISPOSAL_STEPS[2]);
  assert.equal(media.disposal.completed, false);

  // 报告含暂停史
  assert.equal(report.pauses.some((p) => p.reason === PAUSE_REASONS.INFECTION_RISK && !p.active), true);
  void v1;
});

test("投诉与删除请求按阶段推进，报告展示走到哪一步", () => {
  const { svc, actors } = fullDay();
  svc.openCase(actors.owner, {
    case_id: "case-1",
    kind: CASE_KINDS.DELETION,
    media_ids: ["m-promo"],
    summary: "家长要求删除公众号照片",
  });
  svc.advanceCase(actors.owner, "case-1", "triaged");
  svc.advanceCase(actors.owner, "case-1", "actioned");

  let report = ownerClosingReport(svc.state);
  let c = report.cases.find((x) => x.case_id === "case-1");
  assert.equal(c.kind, CASE_KINDS.DELETION);
  assert.equal(c.stage, "actioned");
  assert.equal(c.history.length, 3);

  // 阶段不能倒退
  assert.throws(() => svc.advanceCase(actors.owner, "case-1", "triaged"), (e) => e.code === ERROR_CODES.INVALID_STATE);

  svc.advanceCase(actors.owner, "case-1", "responded");
  svc.closeCase(actors.owner, "case-1", "已撤下并回复家长");
  report = ownerClosingReport(svc.state);
  c = report.cases.find((x) => x.case_id === "case-1");
  assert.equal(c.stage, "closed");
  assert.equal(c.closed_at !== null, true);
});

test("非负责人不能开案或推进案件", () => {
  const { svc, actors } = fullDay();
  assert.throws(
    () => svc.openCase(actors.reception, { kind: CASE_KINDS.COMPLAINT, summary: "x" }),
    (e) => e.code === ERROR_CODES.PERMISSION_DENIED,
  );
});

test("仍有访客在园时结束开放日需要显式确认", () => {
  const f = makeFixture();
  f.publish();
  f.setTime("2026-10-02T09:00+08:00");
  const id = f.registerVisitor();
  f.svc.checkIn(f.actors.reception, id);
  assert.throws(
    () => f.svc.closeOpenDay(f.actors.owner),
    (e) => e.code === ERROR_CODES.VISITORS_ON_SITE,
  );
  f.svc.closeOpenDay(f.actors.owner, { force: true });
  assert.equal(f.svc.state.openDay.closed, true);
});

test("报告汇总结案与处置计数", () => {
  const { svc, actors } = fullDay();
  svc.openCase(actors.owner, { case_id: "case-a", kind: CASE_KINDS.COMPLAINT, summary: "讲解不清" });
  svc.closeCase(actors.owner, "case-a", "已致歉");
  const report = ownerClosingReport(svc.state);
  assert.equal(report.summary.registrations, 2);
  assert.equal(report.summary.cases_closed, 1);
  assert.equal(report.summary.cases_open, 0);
  assert.equal(report.summary.media_total, 1);
});
