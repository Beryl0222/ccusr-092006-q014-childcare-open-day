// 测试夹具：一套可调时钟的开放日环境与常用角色、区域、时段、儿童。
import { CONSENT_SCOPES, CONSENT_STATES, STAFF_ROLES } from "../src/childcare_open_day.js";
import { EventStore } from "../src/store.js";
import { OpenDayService } from "../src/service.js";

export const IDS = {
  openDay: "od-1",
  slot1: "s1", // 09:00-10:00，容量 4
  slot2: "s2", // 10:00-11:00，容量 6
  classA: "class-a",
  classB: "class-b",
  yard: "play-yard",
  child1: "c1",
  child2: "c2",
  child3: "c3",
};

export function makeFixture(start = "2026-10-02T08:30:00+08:00") {
  let now = new Date(start);
  const store = new EventStore();
  const svc = new OpenDayService(store, () => now);
  const actors = {
    owner: { id: "owner-1", role: STAFF_ROLES.CARE_OWNER },
    reception: { id: "rec-1", role: STAFF_ROLES.RECEPTION },
    safety: { id: "saf-1", role: STAFF_ROLES.SAFETY },
  };

  function setTime(iso) {
    now = new Date(iso);
  }

  function publish(overrides = {}) {
    return svc.publishOpenDay(actors.owner, IDS.openDay, {
      name: "十月开放日",
      summary: "欢迎准备入托的家庭",
      languages: ["zh", "en"],
      accessibility: { wheelchair: true, quiet_room: true },
      areas: [
        { id: IDS.classA, name: "豆豆班教室", accessible: true },
        { id: IDS.classB, name: "芽芽班教室", accessible: true },
        { id: IDS.yard, name: "户外活动场", accessible: false, capacity_note: "雨天关闭" },
      ],
      slots: [
        { id: IDS.slot1, starts_at: "2026-10-02T09:00:00+08:00", ends_at: "2026-10-02T10:00:00+08:00", capacity: 4 },
        { id: IDS.slot2, starts_at: "2026-10-02T10:00:00+08:00", ends_at: "2026-10-02T11:00:00+08:00", capacity: 6 },
      ],
      child_assignments: [
        { childId: IDS.child1, areaId: IDS.classA },
        { childId: IDS.child2, areaId: IDS.classA },
        { childId: IDS.child3, areaId: IDS.classB },
      ],
      ...overrides,
    });
  }

  // 默认：三名儿童都允许观察与拍摄（宣传由各测试自行设定）
  function grantObservationAndPhoto() {
    for (const childId of [IDS.child1, IDS.child2, IDS.child3]) {
      svc.recordConsent(actors.owner, childId, CONSENT_SCOPES.OBSERVATION, CONSENT_STATES.GRANTED);
      svc.recordConsent(actors.owner, childId, CONSENT_SCOPES.PHOTOGRAPHY, CONSENT_STATES.GRANTED);
    }
  }

  function registerVisitor(input = {}) {
    const event = svc.registerVisitor(actors.reception, {
      display_name: input.display_name ?? "王女士",
      contact_ref: input.contact_ref ?? "contact:wang",
      slot_id: input.slot_id ?? IDS.slot1,
      party_size: input.party_size ?? 1,
      companions: input.companions,
      accessibility_needs: input.accessibility_needs ?? [],
      attention_notes: input.attention_notes ?? [],
      language: input.language ?? "zh",
      planned_route: input.planned_route,
    });
    return event.subject_id;
  }

  return { svc, store, actors, ids: IDS, setTime, publish, grantObservationAndPhoto, registerVisitor };
}
