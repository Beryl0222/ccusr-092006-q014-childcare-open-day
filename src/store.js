// 仅追加的事件存储：任何事实都以事件形式追加，事件一经写入不可修改、不可删除。
// 撤回授权、撤销材料等操作都表现为新的事件，而不是对历史事件的改写。

import { validateEvent } from "./childcare_open_day.js";

let counter = 0;

// 生成稳定的事件标识：时间前缀 + 进程内自增序号，同毫秒内也不冲突
export function generateEventId(now = new Date()) {
  counter += 1;
  const stamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `evt_${stamp}_${counter.toString(36)}`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

export class EventStore {
  #events = [];

  // 追加一条事件；校验通过后深度冻结，返回被追加的事件
  append(record) {
    const problems = validateEvent(record);
    if (problems.length) {
      throw new Error(`事件缺少必填字段或字段非法：${problems.join("、")}`);
    }
    if (this.#events.some((e) => e.event_id === record.event_id)) {
      throw new Error(`事件标识重复：${record.event_id}`);
    }
    const frozen = deepFreeze(structuredClone(record));
    this.#events.push(frozen);
    return frozen;
  }

  // 只读访问事件流（返回冻结副本的引用，调用方无法改动存储）
  all() {
    return this.#events.slice();
  }

  get size() {
    return this.#events.length;
  }
}
