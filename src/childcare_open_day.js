// childcare_open_day 领域资料的基础结构。

export const EVENT_KINDS = Object.freeze(["VISIT_SLOT_PUBLISHED", "CONSENT_RECORDED", "VISITOR_CHECKED_IN", "ROUTE_PAUSED", "MEDIA_REQUEST_RESOLVED"]);
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
