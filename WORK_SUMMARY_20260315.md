# VR 机器人示教平台改造与任务化采集总结（截至 2026-03-15）

## 1. 本日目标

在已有“human -> robot”时序训练闭环基础上，完成数据采集从“纯姿态录制”向“任务驱动录制”升级：

1. 在 VR 场景中加入可随机生成的目标物（球）
2. 建立可训练的任务标签（接触、握持、阶段、成功/超时）
3. 将任务观测写入每帧数据（`obs.task`），而不仅是事件日志
4. 支持连续任务流：**5 个目标 = 1 个 episode**
5. 支持双手独立判定（左手/右手分开计算）

---

## 2. 关键代码改动

### 2.1 录制层扩展（Recording Manager）

修改文件：
- `src/utils/recordingManager.js`

新增能力：
- `recordedChannels` 增加 `taskObservation`
- `recordFrame()` 支持通过依赖注入回调 `getTaskObservation()` 写入：
  - `obs.task`（任务级观测）

意义：
- 训练数据中每帧都可携带任务语义，便于后续特征工程与策略学习。

---

### 2.2 VR 控制页任务系统升级

修改文件：
- `src/components/RobotVR.vue`

#### A. 目标任务系统

新增：
- 目标球可视体创建与随机采样
- 每个 episode 自动生成目标
- 接触阈值、保持时间、超时阈值可配置

当前参数（核心）：
- `TASK_CONTACT_THRESHOLD = 0.16m`
- `TASK_REACH_HOLD_MS = 250ms`
- `TASK_TIMEOUT_MS = 20000ms`
- `TASKS_PER_EPISODE = 5`

#### B. 多目标回合逻辑（新）

从“1 回合 1 个目标”升级为：
- **完成一次成功触碰+握持后，自动刷新下一球**
- **累计完成 5 个目标后，自动结束 episode**（`task_success_5of5`）

#### C. 双手独立计算（新）

由“左右手 OR 判定”升级为“左右手分开统计并同侧成功判定”：

每帧记录：
- 距离：`distToTargetLeft` / `distToTargetRight`
- 接触：`contactFlagLeft` / `contactFlagRight`
- 接触保持：`contactHoldMsLeft` / `contactHoldMsRight`
- 握持输入：`squeezePressedLeft` / `squeezePressedRight`

成功条件（同侧）：
- 左手成功：`contactHoldMsLeft >= 阈值` 且 `squeezePressedLeft == true`
- 右手成功：`contactHoldMsRight >= 阈值` 且 `squeezePressedRight == true`

并记录：
- `successHand`（`left`/`right`）

#### D. 任务标签与事件增强

新增/增强事件：
- `episode_task_plan`
- `target_spawned`
- `target_contact`（带 hand）
- `grasp_success`（带 successHand 与左右手状态）
- `target_completed_next`
- `episode_timeout`
- `episode_task_summary`

#### E. 调试面板增强

VR 面板新增显示：
- 当前 `Task phase`
- 当前目标距离 `d=...`
- 当前进度 `completed/total`（例如 `3/5`）
- 当前目标序号（`targetIndex`）

---

## 3. 当前数据结构变化（面向训练）

每帧 `episodes.jsonl`：
- 维持原有 human/robot 观测字段
- 新增 `obs.task`（任务语义）

`obs.task` 关键字段：
- `targetId`, `targetIndex`, `completedTargets`, `targetsPerEpisode`
- `targetPose`
- `distToTarget`, `distToTargetLeft`, `distToTargetRight`
- `contactFlag`, `contactFlagLeft`, `contactFlagRight`
- `contactHoldMs`, `contactHoldMsLeft`, `contactHoldMsRight`
- `squeezePressed`, `squeezePressedLeft`, `squeezePressedRight`
- `phaseLabel`, `successHand`, `episodeSuccess`

说明：
- 仍保留聚合字段（`distToTarget` / `contactFlag` / `squeezePressed`）以兼容旧分析脚本。

---

## 4. 如何在 VR 中操作（详细）

### 4.1 进入与准备

1. 打开控制页（`/`）并进入 VR。
2. 确认手臂跟随已校准（按提示完成两次扳机流程）。
3. 确认左手/右手控制器都已连接。

### 4.2 开始采集

开始 episode（任选其一）：
- 手柄：**左手 X**
- 键盘：**B**

开始后系统会：
- 自动创建该 episode 的任务计划（5 个目标）
- 生成第 1 个随机目标球
- 开始按固定频率录帧

### 4.3 完成单个目标

对当前球执行：
1. 用任一只手将末端移动到球附近（进入接触阈值）
2. 保持短暂停留（约 250ms）
3. 用**同一只手**按下 `squeeze`（握持键）

成功后系统行为：
- 写入 `grasp_success`（记录成功手）
- 自动刷新下一个球（无需再按 X）
- 进度加 1（例如 `2/5`）

### 4.4 完成整个 episode

- 连续完成 5 个目标后，系统自动结束 episode。
- 结果标记为 `task_success_5of5`。

### 4.5 超时与手动控制

- 若当前目标超过超时（20s）未完成：自动结束 episode（`timeout`）
- 手动结束：
  - 手柄：右手 A
  - 键盘：N
- 导出数据：
  - 手柄：右手 B/Y
  - 键盘：E

---

## 5. 当前可用功能清单

1. WebXR 双手控制与机器人手臂跟随
2. 目标球随机生成与任务进度管理
3. 双手独立任务判定（接触/握持/成功）
4. 连续 5 目标自动闭环 episode
5. 事件流与帧流双通道记录
6. 会话级、回合级、帧级多粒度标签
7. VR 面板实时状态反馈（进度/阶段/距离）

---

## 6. 采集建议（即刻可执行）

建议每次采集批次：
- 30~50 个 episode（每个 episode 固定 5 目标）
- 成功与超时都保留，不要只留“完美成功”
- 左右手都刻意使用，避免单手偏置

建议分布：
- 双手任务贡献尽量接近（例如左/右成功各约 40%~60%）
- 目标高度与左右分布多样化
- 保留少量恢复动作轨迹（接触失败后再对准）

---

## 7. 下一步建议

1. 在 `imitation-learning/src/h2r/features.py` 接入 `obs.task` 特征（先从距离与阶段 one-hot 开始）
2. 做“带任务特征 vs 不带任务特征”对照实验
3. 输出按 `successHand` 分组的离线指标（看左右手是否存在性能偏置）
4. 后续可扩展到障碍物与放置点任务（pick-place）

---

## 8. 本次改动影响范围

- 功能影响：采集逻辑、事件结构、帧 schema
- 兼容性：保留聚合字段，不破坏旧 JSON 基本读取
- 风险点：训练脚本尚未消费新增 `obs.task` 字段（需下一步接入）

---

## 9. 核心结论

今天的改造把系统从“动作录制器”推进为“任务化示教采集器”：

- 有目标
- 有阶段
- 有成功定义
- 有双手独立信号
- 有多目标连续 episode

这将显著提升后续模型学习“规律（任务因果）”而不只是“姿态拟合”的可能性。
