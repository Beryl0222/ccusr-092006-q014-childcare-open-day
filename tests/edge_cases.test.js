import assert from "node:assert/strict";
import test from "node:test";
import { CONSENT_SCOPES, PAUSE_REASONS, VISITOR_STATUS } from "../src/childcare_open_day.js";
import { ERROR_CODES } from "../src/errors.js";
import { currentObservationConflicts, slotOccupancy } from "../src/policies.js";
import { ownerClosingReport, safetyView } from "../src/views.js";
import { makeFixture, IDS } from "./fixtures.js";

test("临时离场保留再入名额：现场计数下降但名额不被挤占，再入恢复在场", () => {
  const f = makeFixture();
  f.publish();
  f.grantObservationAndPhoto();
  f.setTime("2026-10-02T09:00+08:00");
  const { svc, actors } = f;

  const a = f.registerVisitor({ display_name: "甲", party_size: 2 });
  const b = f.registerVisitor({ display_name: "乙", party_size: 2 }); // 与甲合计占满预约 4
  svc.checkIn(actors.reception, a);
  svc.temporarilyExit(actors.reception, a, { reason: "取物品" });
  svc.checkIn(actors.reception, b);

  // 现场只有乙 2 人；预约口径仍为甲、乙各保留 2
  assert.equal(slotOccupancy(svc.state, IDS.slot1).people, 2);
  // 第三名访客无法再预约（名额为甲保留着）
  assert.throws(
    () => f.registerVisitor({ display_name: "丙", party_size: 1 }),
    (e) => e.code === ERROR_CODES.CAPACITY_FULL,
  );

  // 甲再入成功：现场恢复为 4，恰好在容量内
  svc.reenter(actors.reception, a);
  assert.equal(slotOccupancy(svc.state, IDS.slot1).people, 4);
  assert.equal(svc.state.visitors.get(a).status, VISITOR_STATUS.ON_SITE);
});

test("监护人撤回观察授权时仍停留该区域的访客，会出现在安全视图冲突清单中", () => {
  const f = makeFixture();
  f.publish();
  f.grantObservationAndPhoto();
  f.setTime("2026-10-02T09:00+08:00");
  const { svc, actors } = f;

  const id = f.registerVisitor({ planned_route: [IDS.classA] });
  svc.checkIn(actors.reception, id);
  svc.enterArea(actors.reception, id, IDS.classA);
  assert.equal(currentObservationConflicts(svc.state, "2026-10-02T09:10+08:00").length, 0);

  // c2 监护人在访客停留期间撤回观察
  f.setTime("2026-10-02T09:15:00+08:00");
  svc.withdrawConsent(actors.owner, IDS.child2, CONSENT_SCOPES.OBSERVATION);

  const conflicts = currentObservationConflicts(svc.state, "2026-10-02T09:16+08:00");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].registration_id, id);
  assert.equal(conflicts[0].area_id, IDS.classA);
  assert.deepEqual(conflicts[0].denying_children, [IDS.child2]);

  const view = safetyView(svc.state, "2026-10-02T09:16+08:00");
  assert.equal(view.observation_conflicts.length, 1);
  // 安全视图不含撤回原因之外的儿童同意全量信息
  assert.ok(!JSON.stringify(view).includes("guardianRef"));

  // 值班引导离开后冲突消失；撤回前的合法访问记录仍保留
  svc.exitArea(actors.reception, id, IDS.classA);
  assert.equal(currentObservationConflicts(svc.state, "2026-10-02T09:20+08:00").length, 0);
  assert.equal(svc.state.visitors.get(id).areaVisits[0].areaId, IDS.classA);
});

test("闭园报告标注访问期间发生的撤回（撤回后停留部分）", () => {
  const f = makeFixture();
  f.publish();
  f.grantObservationAndPhoto();
  f.setTime("2026-10-02T09:00+08:00");
  const { svc, actors } = f;
  const id = f.registerVisitor({ planned_route: [IDS.classA] });
  svc.checkIn(actors.reception, id);
  svc.enterArea(actors.reception, id, IDS.classA);
  f.setTime("2026-10-02T09:15:00+08:00");
  svc.withdrawConsent(actors.owner, IDS.child1, CONSENT_SCOPES.OBSERVATION);
  svc.exitArea(actors.reception, id, IDS.classA, { at: "2026-10-02T09:20+08:00" });

  const report = ownerClosingReport(svc.state);
  const visit = report.visitors[0].area_visits[0];
  assert.equal(visit.withdrawals_during_visit.length, 1);
  assert.equal(visit.withdrawals_during_visit[0].child_id, IDS.child1);
  assert.equal(visit.withdrawals_during_visit[0].scope, CONSENT_SCOPES.OBSERVATION);
});

test("事件流仅追加：任何撤回、作废、处置都不减少事件数量", () => {
  const f = makeFixture();
  f.publish();
  f.grantObservationAndPhoto();
  f.setTime("2026-10-02T09:00+08:00");
  const { svc, actors } = f;
  const id = f.registerVisitor();
  const before = svc.store.size;
  svc.checkIn(actors.reception, id);
  svc.withdrawConsent(actors.owner, IDS.child1, CONSENT_SCOPES.PHOTOGRAPHY);
  svc.revokePass(actors.reception, id, "manual");
  const after = svc.store.size;
  assert.ok(after > before);
  // 冻结：尝试篡改历史事件应无效
  const first = svc.store.all()[0];
  assert.throws(() => {
    first.payload.name = "hacked";
  }, TypeError);
});

test("未知暂停原因被拒绝", () => {
  const f = makeFixture();
  f.publish();
  assert.throws(
    () => f.svc.pauseRoute(f.actors.safety, { reason: "earthquake", area_ids: [IDS.yard] }),
    (e) => e.code === ERROR_CODES.VALIDATION,
  );
});

test("消防全园封控记录在暂停日志中，解除后仍可追溯", () => {
  const f = makeFixture();
  f.publish();
  f.svc.pauseRoute(f.actors.safety, { reason: PAUSE_REASONS.FIRE_SAFETY, note: "演练" });
  f.svc.resumeRoute(f.actors.safety, { global: true });
  const log = f.svc.state.pauseLog;
  assert.equal(log.length, 1);
  assert.equal(log[0].global, true);
  assert.equal(log[0].active, false);
  assert.ok(log[0].resumedAt);
});
