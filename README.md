# 托育开放日隐私协调

本项目用于整理托育开放日隐私协调领域中的事件名称、交换字段与脱敏样例，并提供一套以仅追加事件为唯一事实来源的探访协调后端，方便业务、运营和研发人员在同一套术语下讨论后续服务。资料只包含领域约定，不包含真实个人信息、生产连接或外部账号。

## 目录

- `src/childcare_open_day.js`：事件种类、枚举（授权范围、暂停原因、处置状态、员工角色）与最小字段校验。
- `src/backend.js`：开放日协调后端（事件存储、状态投影、命令与员工视图）。
- `data/sample.json`：用于核对资料格式的虚构事件。
- `tests/`：契约校验与端到端场景测试。

## 领域流程

1. **园方发布**：开放区域、时段、各时段人数、讲解语言、现场容量与无障碍条件（`OPEN_DAY_SCHEDULED`）。
2. **访客登记与凭证**：访客登记同行人、无障碍需求与关注事项后，取得绑定时段的限时凭证（`VISITOR_REGISTERED` / `CREDENTIAL_ISSUED`）。
3. **现场出入**：入园、临时离场、再次进入、最终离园（`VISITOR_CHECKED_IN` / `VISITOR_TEMP_EXITED` / `VISITOR_REENTERED` / `VISITOR_CHECKED_OUT`），区域进出成对记录（`AREA_ENTRY_LOGGED` / `AREA_EXIT_LOGGED`）。
4. **监护人分别授权**：在园儿童的监护人对**观察、摄影、园方宣传**三个范围分别决定（`CONSENT_RECORDED`），可分别撤回（`CONSENT_WITHDRAWN`）。
5. **突发处置**：突发照护、传染病风险或消防要求可暂停局部路线（`ROUTE_PAUSED` / `ROUTE_RESUMED`），并向受影响家庭提供改期（`VISIT_RESCHEDULED`）。
6. **影像与投诉**：影像发布时逐人核对授权现状（`MEDIA_PUBLISHED`）；撤回或删除请求让已发布材料进入可跟踪的处置流程（`MEDIA_RETENTION_FLAGGED` / `MEDIA_REQUEST_RESOLVED`）；投诉单独流转（`COMPLAINT_FILED` / `COMPLAINT_RESOLVED`）。
7. **闭园**：负责人闭园并取得日报（`OPEN_DAY_CLOSED` + `dailyReport`）。

## 关键语义

- **容量准确**：现场容量按同行人数实时增减；临时离场立即释放、再次进入重新核对；区域容量独立于现场容量；登记阶段还受时段预约容量约束。
- **撤回只改变后续**：撤回后新的观察/拍摄/发布一律按未授权处理；**已发布材料不会从记录中消失**，而是生成处置请求，状态依次可跟踪（`PENDING → TAKEDOWN_REQUESTED → TAKEN_DOWN`，或 `RETAINED_JUSTIFIED` / `REJECTED` 终局），原始发布事件与授权依据始终保留。
- **改期**：受影响家庭 = 暂停时刻正在该区域的访客 + 路线包含该区域且时段未结束的登记家庭；目标时段容量不足的家庭不发提议、留待人工处理；接受改期后旧凭证吊销留痕并发放新凭证，在园中的到访自动结束。
- **闭园不冻结善后**：闭园后现场操作（入园、区域进入、暂停等）拒绝，但删除请求与投诉可继续流转。
- **员工数据最小化**（`staffView`）：
  - 接待 `RECEPTION`：凭证、同行人数、无障碍需求、在场状态；不含联系方式、授权、投诉正文；
  - 引导 `GUIDE`：在园访客、关注区域、讲解语言，以及各区域「观察受限」儿童**计数**（不识别具体儿童）；
  - 协调 `COORDINATOR`：容量、暂停、待回复改期、处置中影像、未结投诉的编号；
  - 负责人 `DIRECTOR`：完整日报——每位访客到过哪些区域、哪些影像允许保留（`RETAINED` / `IN_PROCESS` / `TAKEN_DOWN`）、投诉与删除请求走到哪一步。

## 本地核对

```bash
npm test
```
