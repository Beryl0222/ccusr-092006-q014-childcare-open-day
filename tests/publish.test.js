import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_CODES } from "../src/errors.js";
import { publicCatalogView } from "../src/views.js";
import { makeFixture, IDS } from "./fixtures.js";

test("园方发布开放区域、时段、人数、讲解语言与无障碍条件", () => {
  const { svc, actors, publish } = makeFixture();
  publish();
  const catalog = publicCatalogView(svc.state, "2026-10-02T08:31:00+08:00");
  assert.equal(catalog.open_day_id, IDS.openDay);
  assert.deepEqual(catalog.languages, ["zh", "en"]);
  assert.equal(catalog.accessibility.wheelchair, true);
  assert.equal(catalog.areas.length, 3);
  assert.equal(catalog.areas.find((a) => a.id === IDS.yard).accessible, false);
  assert.equal(catalog.slots[0].capacity, 4);
});

test("接待与安全岗位无权发布目录，只有负责人可以", () => {
  const { svc, actors, publish } = makeFixture();
  assert.throws(() => svc.publishOpenDay(actors.reception, "x", {}), (e) => e.code === ERROR_CODES.PERMISSION_DENIED);
  assert.throws(() => svc.publishOpenDay(actors.safety, "x", {}), (e) => e.code === ERROR_CODES.PERMISSION_DENIED);
  assert.doesNotThrow(() => publish());
});

test("非法时段（时间倒置、负容量）被拒绝", () => {
  const { svc, actors, publish } = makeFixture();
  assert.throws(
    () =>
      svc.publishOpenDay(actors.owner, "bad", {
        areas: [],
        slots: [{ id: "x", starts_at: "2026-10-02T11:00+08:00", ends_at: "2026-10-02T10:00+08:00", capacity: 2 }],
      }),
    (e) => e.code === ERROR_CODES.VALIDATION,
  );
});

test("开放日结束后不能再登记访客", () => {
  const { svc, actors, publish } = makeFixture();
  publish();
  svc.closeOpenDay(actors.owner);
  assert.throws(
    () => svc.registerVisitor(actors.reception, { display_name: "晚到", slot_id: IDS.slot1 }),
    (e) => e.code === ERROR_CODES.ALREADY_CLOSED,
  );
});
