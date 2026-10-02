// 开放日探访协调后端的统一入口。
export * from "./childcare_open_day.js";
export { EventStore, generateEventId } from "./store.js";
export { buildState, freshState } from "./state.js";
export {
  affectedVisitorIds,
  areaPauseState,
  areaPolicy,
  consentAt,
  currentObservationConflicts,
  isGlobalLockdown,
  passUsableAt,
  slotCapacityRemaining,
  slotOccupancy,
  slotReservationRemaining,
} from "./policies.js";
export { OpenDayService } from "./service.js";
export {
  ownerClosingReport,
  publicCatalogView,
  receptionView,
  safetyView,
  staffView,
} from "./views.js";
export { DomainError, ERROR_CODES } from "./errors.js";
