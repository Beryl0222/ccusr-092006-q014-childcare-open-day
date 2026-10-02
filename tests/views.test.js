import assert from "node:assert/strict";
import test from "node:test";
import { STAFF_ROLES } from "../src/childcare_open_day.js";
import { publicCatalogView, receptionView, safetyView, staffView } from "../src/views.js";
import { makeFixture, IDS } from "./fixtures.js";

function setup() {
  const f = makeFixture();
  f.publish();
  f.grantObservationAndPhoto();
  f.setTime("2026-10-02T09:00:00+08:00");
  const id = f.registerVisitor({
    display_name: "陈女士",
    contact_ref: "tel:13800000000",
    attention_notes: ["孩子对坚果过敏"],
    accessibility_needs: ["电梯"],
    language: "en",
  });
  return { ...f, id };
}

test("公开目录只含园方发布信息，不含任何访客或在园儿童资料", () => {
  const { svc } = setup();
  const catalog = publicCatalogView(svc.state);
  const text = JSON.stringify(catalog);
  assert.ok(!text.includes("陈女士"));
  assert.ok(!text.includes(IDS.child1));
  assert.ok(catalog.areas.some((a) => a.id === IDS.classA));
});

test("接待视图严格限定在接待所需字段，不含同意与影像资料", () => {
  const { svc, actors, id } = setup();
  const view = staffView(svc.state, actors.reception);
  const row = view.visitors.find((v) => v.registration_id === id);
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "accessibility_needs",
      "attention_notes",
      "contact_ref",
      "display_name",
      "language",
      "party_size",
      "pass_code",
      "registration_id",
      "slot_id",
      "status",
    ].sort(),
  );
  // 视图中没有任何儿童同意、影像、处置内容
  assert.ok(!JSON.stringify(view).includes(IDS.child1));
});

test("安全视图不暴露联系方式与关注事项，只给处置突发所需信息", () => {
  const { svc, actors, id } = setup();
  svc.checkIn(actors.reception, id);
  svc.enterArea(actors.reception, id, IDS.classA);
  const view = safetyView(svc.state);
  assert.equal(view.on_site.length, 1);
  const row = view.on_site[0];
  assert.ok(!("contact_ref" in row));
  assert.ok(!("attention_notes" in row));
  assert.equal(row.current_area_id, IDS.classA);
  assert.ok(view.areas[IDS.classA].people >= 1);
});

test("负责人视图可查看全部协调资料", () => {
  const { svc, actors } = setup();
  const view = staffView(svc.state, actors.owner);
  assert.equal(view.scope, "care_owner");
  assert.ok(view.catalog && view.reception && view.safety);
});

test("未知角色不能取得员工视图", () => {
  const { svc } = setup();
  assert.throws(() => staffView(svc.state, { id: "x", role: "ghost" }));
});

test("接待无法读取安全视图（通过角色分发天然隔离）", () => {
  const { svc, actors } = setup();
  const view = staffView(svc.state, actors.reception);
  assert.equal(view.scope, "reception");
  assert.ok(!("on_site" in view));
});
