import assert from "node:assert/strict";
import test from "node:test";
import {
  CONSENT_SCOPES,
  CONSENT_STATES,
  MEDIA_DISPOSAL_STEPS,
  MEDIA_STATUSES,
} from "../src/childcare_open_day.js";
import { ERROR_CODES } from "../src/errors.js";
import { areaPolicy, consentAt } from "../src/policies.js";
import { makeFixture, IDS } from "./fixtures.js";

test("观察、摄影、宣传三项同意彼此独立", () => {
  const { svc, actors, publish, setTime, grantObservationAndPhoto } = makeFixture();
  publish();
  svc.recordConsent(actors.owner, IDS.child1, CONSENT_SCOPES.OBSERVATION, CONSENT_STATES.GRANTED);
  svc.recordConsent(actors.owner, IDS.child1, CONSENT_SCOPES.PHOTOGRAPHY, CONSENT_STATES.DENIED);
  // 宣传未表态
  const c = svc.state.children.get(IDS.child1);
  assert.equal(consentAt(c, CONSENT_SCOPES.OBSERVATION, "2026-10-02T09:00+08:00").state, CONSENT_STATES.GRANTED);
  assert.equal(consentAt(c, CONSENT_SCOPES.PHOTOGRAPHY, "2026-10-02T09:00+08:00").state, CONSENT_STATES.DENIED);
  assert.equal(consentAt(c, CONSENT_SCOPES.PROMOTION, "2026-10-02T09:00+08:00").state, CONSENT_STATES.DENIED);
  assert.equal(consentAt(c, CONSENT_SCOPES.PROMOTION, "2026-10-02T09:00+08:00").decided, false);
});

test("区域内任一儿童监护人拒绝观察，访客不得进入该区域", () => {
  const { svc, actors, registerVisitor, publish, setTime, grantObservationAndPhoto } = makeFixture();
  publish();
  // c1、c2 在 class-a：c1 全部允许，c2 拒绝观察
  svc.recordConsent(actors.owner, IDS.child1, CONSENT_SCOPES.OBSERVATION, CONSENT_STATES.GRANTED);
  svc.recordConsent(actors.owner, IDS.child1, CONSENT_SCOPES.PHOTOGRAPHY, CONSENT_STATES.GRANTED);
  svc.recordConsent(actors.owner, IDS.child2, CONSENT_SCOPES.OBSERVATION, CONSENT_STATES.DENIED);
  setTime("2026-10-02T09:00+08:00");
  const id = registerVisitor();
  svc.checkIn(actors.reception, id);
  assert.throws(() => svc.enterArea(actors.reception, id, IDS.classA), (e) => e.code === ERROR_CODES.OBSERVATION_DENIED);
  // 拒绝进入留痕
  assert.equal(svc.state.visitors.get(id).accessRefusals[0].reason, ERROR_CODES.OBSERVATION_DENIED);
});

test("允许观察但拒绝摄影时可以进入，拍摄被政策拦截", () => {
  const { svc, actors, registerVisitor, publish, setTime, grantObservationAndPhoto } = makeFixture();
  publish();
  grantObservationAndPhoto();
  svc.recordConsent(actors.owner, IDS.child1, CONSENT_SCOPES.PHOTOGRAPHY, CONSENT_STATES.DENIED);
  setTime("2026-10-02T09:00+08:00");
  const id = registerVisitor();
  svc.checkIn(actors.reception, id);
  assert.doesNotThrow(() => svc.enterArea(actors.reception, id, IDS.classA));
  const decision = svc.canCapture(svc.state, IDS.classA);
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.violations, [IDS.child1]);
});

test("撤回只影响撤回之后的活动，不重写历史进入记录", () => {
  const f = makeFixture();
  const { svc, actors, registerVisitor } = f;
  f.publish();
  f.grantObservationAndPhoto();
  f.setTime("2026-10-02T09:00:00+08:00");
  const id = registerVisitor();
  svc.checkIn(actors.reception, id);
  svc.enterArea(actors.reception, id, IDS.classA, { at: "2026-10-02T09:05+08:00" });
  svc.exitArea(actors.reception, id, IDS.classA, { at: "2026-10-02T09:10+08:00" });

  // 09:20 c2 监护人撤回观察授权（只影响此后）
  f.setTime("2026-10-02T09:20:00+08:00");
  svc.withdrawConsent(actors.owner, IDS.child2, CONSENT_SCOPES.OBSERVATION);
  const child2 = svc.state.children.get(IDS.child2);
  assert.equal(child2.consents[CONSENT_SCOPES.OBSERVATION].withdrawn, true);

  // 09:05 时刻政策仍然允许（历史事实成立），09:30 时刻不再允许
  const policyBefore = areaPolicy(svc.state, IDS.classA, "2026-10-02T09:05+08:00");
  assert.equal(policyBefore.observationAllowed, true);
  const policyAfter = areaPolicy(svc.state, IDS.classA, "2026-10-02T09:30+08:00");
  assert.equal(policyAfter.observationAllowed, false);

  // 历史进入记录仍在（比较时刻，不比较字符串格式）
  const visit = svc.state.visitors.get(id).areaVisits[0];
  assert.equal(Date.parse(visit.enteredAt), Date.parse("2026-10-02T09:05+08:00"));
  assert.equal(Date.parse(visit.exitedAt), Date.parse("2026-10-02T09:10+08:00"));
});

test("撤回一项不存在的授权被拒绝", () => {
  const { svc, actors, publish, setTime, grantObservationAndPhoto } = makeFixture();
  publish();
  assert.throws(
    () => svc.withdrawConsent(actors.owner, IDS.child1, CONSENT_SCOPES.PROMOTION),
    (e) => e.code === ERROR_CODES.INVALID_STATE,
  );
});

test("个人影像在摄影授权齐备时可保留；园方宣传还需宣传授权", () => {
  const { svc, actors, publish, setTime, grantObservationAndPhoto } = makeFixture();
  publish();
  grantObservationAndPhoto();
  svc.recordConsent(actors.owner, IDS.child1, CONSENT_SCOPES.PROMOTION, CONSENT_STATES.GRANTED);
  setTime("2026-10-02T09:00+08:00");

  svc.logMedia(actors.reception, "m-personal", {
    area_id: IDS.classA,
    child_ids: [IDS.child1],
  });
  assert.equal(svc.state.media.get("m-personal").status, MEDIA_STATUSES.RETAINED);

  // c2 没有宣传授权：宣传影像进入处置
  svc.logMedia(actors.owner, "m-promo", {
    area_id: IDS.classA,
    captured_by: "center",
    purpose: "promotion",
    channels: ["weibo"],
    child_ids: [IDS.child1, IDS.child2],
  });
  assert.equal(svc.state.media.get("m-promo").status, MEDIA_STATUSES.DISPOSING);
});

test("撤回后已发布材料进入可跟踪处置流程，且必须按顺序推进", () => {
  const { svc, actors, publish, setTime, grantObservationAndPhoto } = makeFixture();
  publish();
  grantObservationAndPhoto();
  svc.recordConsent(actors.owner, IDS.child1, CONSENT_SCOPES.PROMOTION, CONSENT_STATES.GRANTED);
  setTime("2026-10-02T09:00+08:00");
  svc.logMedia(actors.owner, "m-post", {
    area_id: IDS.classA,
    captured_by: "center",
    purpose: "promotion",
    channels: ["moments"],
    child_ids: [IDS.child1],
  });
  assert.equal(svc.state.media.get("m-post").status, MEDIA_STATUSES.RETAINED);

  // 撤回宣传授权 → 标记既有材料处置，历史不删除
  svc.withdrawConsent(actors.owner, IDS.child1, CONSENT_SCOPES.PROMOTION);
  svc.flagMediaForDisposal(actors.owner, "m-post");
  assert.equal(svc.state.media.get("m-post").status, MEDIA_STATUSES.DISPOSING);

  // 跳步被拒绝
  assert.throws(
    () => svc.recordDisposalStep(actors.owner, "m-post", "taken_down"),
    (e) => e.code === ERROR_CODES.DISPOSAL_INCOMPLETE,
  );

  for (const step of MEDIA_DISPOSAL_STEPS) {
    svc.recordDisposalStep(actors.owner, "m-post", step, { note: step });
  }
  const item = svc.state.media.get("m-post");
  assert.equal(item.status, MEDIA_STATUSES.DISPOSED);
  assert.deepEqual(item.disposalSteps.map((s) => s.step), MEDIA_DISPOSAL_STEPS);

  // 原始 MEDIA_LOGGED 事件仍在事件流中（记录不消失）
  assert.ok(svc.store.all().some((e) => e.kind === "MEDIA_LOGGED" && e.subject_id === "m-post"));
});
