import assert from "node:assert/strict";
import test from "node:test";
import { PAUSE_REASONS, VISITOR_STATUS } from "../src/childcare_open_day.js";
import { ERROR_CODES } from "../src/errors.js";
import { isGlobalLockdown } from "../src/policies.js";
import { makeFixture, IDS } from "./fixtures.js";

function morning() {
  const f = makeFixture();
  f.publish();
  f.grantObservationAndPhoto();
  f.setTime("2026-10-02T09:00:00+08:00");
  return f;
}

test("突发照护：暂停局部路线，受影响访客收到改期邀约，未受影响者不收到", () => {
  const { svc, actors, registerVisitor } = morning();
  const inYard = registerVisitor({ display_name: "场内", planned_route: [IDS.yard] });
  const inClass = registerVisitor({ display_name: "教室内", planned_route: [IDS.classA] });
  svc.checkIn(actors.reception, inYard);
  svc.checkIn(actors.reception, inClass);
  svc.enterArea(actors.reception, inYard, IDS.yard);
  svc.enterArea(actors.reception, inClass, IDS.classA);

  const result = svc.pauseRoute(actors.safety, {
    reason: PAUSE_REASONS.CARE_INCIDENT,
    area_ids: [IDS.yard],
    note: "幼儿跌倒处理中",
    new_slot_id: IDS.slot2,
  });
  assert.deepEqual(result.affected, [inYard]);
  assert.equal(result.offers.length, 1);

  // 暂停区域不可进入，且留痕
  assert.throws(
    () => svc.enterArea(actors.reception, inClass, IDS.yard),
    (e) => e.code === ERROR_CODES.ROUTE_PAUSED,
  );
  assert.equal(svc.state.visitors.get(inClass).accessRefusals.at(-1).reason, ERROR_CODES.ROUTE_PAUSED);

  // 未暂停区域仍可进入
  assert.doesNotThrow(() => svc.enterArea(actors.reception, inYard, IDS.classB));
});

test("暂停只影响当时正在进行的时段：更晚时段已登记家庭不收到改期", () => {
  const { svc, actors, registerVisitor } = morning();
  // 09:00 暂停 yard 时，slot2（10:00 开始）的家庭尚未到访
  registerVisitor({ display_name: "晚时段", slot_id: IDS.slot2, planned_route: [IDS.yard] });
  const result = svc.pauseRoute(actors.safety, {
    reason: PAUSE_REASONS.INFECTION_RISK,
    area_ids: [IDS.yard],
    new_slot_id: IDS.slot2,
  });
  assert.deepEqual(result.affected, []);
  assert.equal(result.offers.length, 0);
});

test("恢复局部路线后区域可再次进入", () => {
  const { svc, actors, registerVisitor } = morning();
  const id = registerVisitor({ planned_route: [IDS.yard] });
  svc.checkIn(actors.reception, id);
  svc.pauseRoute(actors.safety, { reason: PAUSE_REASONS.INFECTION_RISK, area_ids: [IDS.yard] });
  assert.throws(() => svc.enterArea(actors.reception, id, IDS.yard), (e) => e.code === ERROR_CODES.ROUTE_PAUSED);
  svc.resumeRoute(actors.safety, { area_ids: [IDS.yard] });
  assert.doesNotThrow(() => svc.enterArea(actors.reception, id, IDS.yard));
});

test("消防要求触发全园封控：一切入园与区域进入被阻止", () => {
  const { svc, actors, registerVisitor } = morning();
  const onSite = registerVisitor({ display_name: "已在园" });
  const waiting = registerVisitor({ display_name: "门口等候" });
  svc.checkIn(actors.reception, onSite);
  svc.enterArea(actors.reception, onSite, IDS.classA);

  svc.pauseRoute(actors.safety, { reason: PAUSE_REASONS.FIRE_SAFETY, note: "消防演练" });
  assert.equal(isGlobalLockdown(svc.state), true);

  assert.throws(() => svc.checkIn(actors.reception, waiting), (e) => e.code === ERROR_CODES.GLOBAL_LOCKDOWN);
  assert.throws(() => svc.enterArea(actors.reception, onSite, IDS.classB), (e) => e.code === ERROR_CODES.GLOBAL_LOCKDOWN);

  // 临时离场者在封控期间也不能再入
  svc.exitArea(actors.reception, onSite, IDS.classA);
  svc.temporarilyExit(actors.reception, onSite);
  assert.throws(() => svc.reenter(actors.reception, onSite), (e) => e.code === ERROR_CODES.GLOBAL_LOCKDOWN);

  // 解除后恢复
  svc.resumeRoute(actors.safety, { global: true });
  assert.equal(isGlobalLockdown(svc.state), false);
  assert.doesNotThrow(() => svc.reenter(actors.reception, onSite));
});

test("接待岗位无权暂停路线", () => {
  const { svc, actors } = morning();
  assert.throws(
    () => svc.pauseRoute(actors.reception, { reason: PAUSE_REASONS.CARE_INCIDENT, area_ids: [IDS.yard] }),
    (e) => e.code === ERROR_CODES.PERMISSION_DENIED,
  );
});

test("接受改期：旧凭证作废、换发新时段凭证，访客按新时段入园", () => {
  const f = morning();
  const { svc, actors, registerVisitor } = f;
  const id = registerVisitor({ planned_route: [IDS.yard] });
  svc.checkIn(actors.reception, id);
  svc.enterArea(actors.reception, id, IDS.yard);

  const { offerId } = svc.offerReschedule(actors.reception, id, {
    reason: PAUSE_REASONS.INFECTION_RISK,
    area_ids: [IDS.yard],
    new_slot_id: IDS.slot2,
  });
  // 改期前需先离场（原时段结束）
  svc.exitArea(actors.reception, id, IDS.yard);
  f.setTime("2026-10-02T09:55:00+08:00");
  svc.checkOut(actors.reception, id);

  f.setTime("2026-10-02T09:56:00+08:00");
  svc.respondReschedule(actors.reception, id, offerId, true);
  const v = svc.state.visitors.get(id);
  assert.equal(v.slotId, IDS.slot2);
  assert.equal(v.pass.slotId, IDS.slot2);
  assert.equal(v.status, VISITOR_STATUS.REGISTERED);
  assert.equal(v.offers[0].status, "accepted");

  // 新时段入园
  f.setTime("2026-10-02T10:05:00+08:00");
  assert.doesNotThrow(() => svc.checkIn(actors.reception, id));
});

test("拒绝改期：时段与凭证不变", () => {
  const { svc, actors, registerVisitor } = morning();
  const id = registerVisitor({ planned_route: [IDS.yard] });
  const { offerId } = svc.offerReschedule(actors.reception, id, {
    reason: PAUSE_REASONS.CARE_INCIDENT,
    area_ids: [IDS.yard],
    new_slot_id: IDS.slot2,
  });
  svc.respondReschedule(actors.reception, id, offerId, false);
  assert.equal(svc.state.visitors.get(id).slotId, IDS.slot1);
  assert.equal(svc.state.visitors.get(id).offers[0].status, "declined");
});

test("改期目标时段名额不足时不能接受", () => {
  const f = morning();
  const { svc, actors, registerVisitor } = f;
  // 把 slot2 约满（6 人）
  registerVisitor({ display_name: "占名额", slot_id: IDS.slot2, party_size: 6 });
  const id = registerVisitor({ display_name: "待改期", planned_route: [IDS.yard] });
  const { offerId } = svc.offerReschedule(actors.reception, id, {
    reason: PAUSE_REASONS.CARE_INCIDENT,
    area_ids: [IDS.yard],
    new_slot_id: IDS.slot2,
  });
  assert.throws(
    () => svc.respondReschedule(actors.reception, id, offerId, true),
    (e) => e.code === ERROR_CODES.CAPACITY_FULL,
  );
});
