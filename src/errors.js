// 领域错误：携带稳定 code，便于调用方与测试区分“无权、容量满、凭证过期”等情形。
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export const ERROR_CODES = Object.freeze({
  PERMISSION_DENIED: "PERMISSION_DENIED",
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  ALREADY_CLOSED: "ALREADY_CLOSED",
  CANCELLED: "CANCELLED",
  INVALID_STATE: "INVALID_STATE",
  PASS_MISSING: "PASS_MISSING",
  PASS_EXPIRED: "PASS_EXPIRED",
  PASS_REVOKED: "PASS_REVOKED",
  CAPACITY_FULL: "CAPACITY_FULL",
  GLOBAL_LOCKDOWN: "GLOBAL_LOCKDOWN",
  ROUTE_PAUSED: "ROUTE_PAUSED",
  OBSERVATION_DENIED: "OBSERVATION_DENIED",
  PHOTOGRAPHY_DENIED: "PHOTOGRAPHY_DENIED",
  DISPOSAL_INCOMPLETE: "DISPOSAL_INCOMPLETE",
  VISITORS_ON_SITE: "VISITORS_ON_SITE",
});
