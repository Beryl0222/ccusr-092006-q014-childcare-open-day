import assert from "node:assert/strict";
import test from "node:test";
import { VISITOR_STATUS } from "../src/childcare_open_day.js";
import { ERROR_CODES } from "../src/errors.js";
import { slotOccupancy } from "../src/policies.js";
import { makeFixture, IDS } from "./fixtures.js";

function setup() {
  const f = makeFixture();
  f.publish();
  f.grantObservationAndPhoto();
  f.setTime("2026-10-02T09:00:00+08:00");
  return f;
}

test("登记后自动取得限时凭证，凭证带过期时间且与时段绑定", () => {
  const { svc, registerVisitor } = setup();
  const id = registerVisitor();
  const visitor = svc.state.visitors.get(id);
  assert.ok(visitor.pass, "应签发凭证");
  assert.ok(Date.parse(visitor.pass.expiresAt) > Date.parse("2026-10-02T09:00+08:00"));
  assert.equal(visitor.pass.slotId, IDS.slot1);
  assert.equal(visitor.pass.revoked, false);
});

test("登记同行人与关注事项被完整记录", () => {
  const { svc, registerVisitor } = setup();
  const id = registerVisitor({
    companions: [{ relation: "配偶", accessibility_needs: ["轮椅"] }],
    party_size: 2,
    attention_notes: ["携带折叠婴儿车"],
    accessibility_needs: ["无障碍通道"],
    language: "en",
  });
  const v = svc.state.visitors.get(id);
  assert.equal(v.partySize, 2);
  assert.deepEqual(v.attentionNotes, ["携带折叠婴儿车"]);
  assert.equal(v.language, "en");
  assert.equal(v.companions[0].relation, "配偶");
});

test("登记阶段即受时段容量约束，超额被拒绝", () => {
  const { svc, registerVisitor } = setup();
  registerVisitor({ party_size: 3 });
  assert.throws(() => registerVisitor({ display_name: "第二户", party_size: 2 }), (e) => e.code === ERROR_CODES.CAPACITY_FULL);
});

test("取消登记/作废凭证后释放预约名额", () => {
  const { svc, actors, registerVisitor } = setup();
  const first = registerVisitor({ party_size: 4 });
  assert.throws(() => registerVisitor({ display_name: "候补", party_size: 1 }), (e) => e.code === ERROR_CODES.CAPACITY_FULL);
  svc.revokePass(actors.reception, first, "duplicate");
  registerVisitor({ display_name: "候补", party_size: 1 });
  assert.equal(svc.state.visitors.size, 2);
});

test("凭证过期后不能入园，换发新凭证后可入园", () => {
  const { svc, actors, registerVisitor } = setup();
  const id = registerVisitor();
  // 凭证默认在时段结束后 30 分钟（10:30）过期
  assert.throws(
    () => svc.checkIn(actors.reception, id, { at: "2026-10-02T12:30:00+08:00" }),
    (e) => e.code === ERROR_CODES.PASS_EXPIRED,
  );
  // 换发一张短时凭证后仍可入园
  svc.issuePass(actors.reception, id, { expires_at: "2026-10-02T09:10:00+08:00", supersede: true });
  assert.throws(
    () => svc.checkIn(actors.reception, id, { at: "2026-10-02T09:20:00+08:00" }),
    (e) => e.code === ERROR_CODES.PASS_EXPIRED,
  );
  svc.issuePass(actors.reception, id, { expires_at: "2026-10-02T10:30:00+08:00", supersede: true });
  assert.doesNotThrow(() => svc.checkIn(actors.reception, id, { at: "2026-10-02T09:05:00+08:00" }));
});

test("临时离场释放现场名额，再次进入后恢复在场计数", () => {
  const { svc, actors, registerVisitor } = setup();
  const a = registerVisitor({ display_name: "甲", party_size: 2 });
  const b = registerVisitor({ display_name: "乙", party_size: 2 });

  svc.checkIn(actors.reception, a);
  svc.checkIn(actors.reception, b);
  assert.equal(slotOccupancy(svc.state, IDS.slot1).people, 4);

  svc.temporarilyExit(actors.reception, a);
  assert.equal(slotOccupancy(svc.state, IDS.slot1).people, 2, "临时离场应释放现场名额");
  assert.equal(svc.state.visitors.get(a).status, VISITOR_STATUS.TEMP_OUT);

  svc.reenter(actors.reception, a);
  assert.equal(slotOccupancy(svc.state, IDS.slot1).people, 4);
  assert.equal(svc.state.visitors.get(a).status, VISITOR_STATUS.ON_SITE);
});

test("未在临时离场状态不能再次进入", () => {
  const { svc, actors, registerVisitor } = setup();
  const id = registerVisitor();
  svc.checkIn(actors.reception, id);
  assert.throws(() => svc.reenter(actors.reception, id), (e) => e.code === ERROR_CODES.INVALID_STATE);
});

test("最终离开后不能再入，状态机非法跳转被拒绝", () => {
  const { svc, actors, registerVisitor } = setup();
  const id = registerVisitor();
  svc.checkIn(actors.reception, id);
  svc.checkOut(actors.reception, id);
  assert.equal(svc.state.visitors.get(id).status, VISITOR_STATUS.LEFT);
  assert.throws(() => svc.reenter(actors.reception, id), (e) => e.code === ERROR_CODES.INVALID_STATE);
  assert.throws(() => svc.checkIn(actors.reception, id), (e) => e.code === ERROR_CODES.INVALID_STATE);
});
