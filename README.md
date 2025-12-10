## VR Humanoid Robot Control (WebXR + three.js + Vue 3)

一个基于 WebXR 的 VR 人形机器人控制 Demo，使用 three.js + Vue 3 + Vite 构建。

目标是：

- 任何人只要有 VR 设备（例如 SteamVR + 一体机串流），访问这个网站就能进入 VR 场景，控制一个人形机器人。
- 支持两种 Avatar 形态：
	- **服务器端预设 Avatar**：开箱即用的机器人模型（例如 RobotExpressive、低模 Humanoid），适合「点开就玩」。
	- **自定义上传 Avatar**：用户在桌面浏览器上传自己的 glTF/GLB 模型，通过 UI 显式绑定肩/肘/手等骨骼，实现 1:1 手臂跟随。

项目使用 WebXR 读取 VR 头显与手柄的姿态，对接 three.js 的骨骼和 IK 系统，让虚拟机器人在 VR 中被实时驱动，可以行走、转身、挥手。

---

## 功能特性

- **VR 场景 & WebXR 支持**
	- 基于 three.js + WebXR，为支持 WebXR 的浏览器（Chrome + SteamVR、PC 浏览器串流到一体机等）提供 VR 体验。
	- 使用 WebXR 的 `renderer.xr` 管理相机与控制器，支持手柄位置/按键/摇杆输入。

- **两页架构：配置页 & 控制页**
	- `config.html`：Avatar 配置页。
		- 从服务器加载预设 Avatar 列表（`public/avatars.json`）。
		- 桌面浏览器下提供「上传 GLB/GLTF + 骨骼映射 UI」。
		- 将选中的 Avatar 配置写入 `localStorage`（键：`vr_avatar_config_v1`）。
	- `index.html`：VR 控制页。
		- 读取 `localStorage` 中的 Avatar 配置。
		- 加载对应模型（预设：通过 URL 用 `GLTFLoader` 加载；自定义：使用上传时的 glTF 场景 clone）。
		- 构建 IK 骨骼链，进入 VR 控制场景。

- **Avatar 预设系统**
	- 通过 `public/avatars.json` 维护一组可直接选择的 Avatar，例如：
		- 默认的 `RobotExpressive` 模型。
		- 低模 Humanoid 机器人模型。
	- 每个预设包括：
		- `id` / `name`
		- `modelUrl`：对应 glTF/GLB 文件路径。
		- `mapping`：逻辑关节名称 → 实际骨骼名称（详见下文）。

- **自定义模型 & 骨骼映射（高级用户）**
	- 在桌面浏览器打开 `config.html`：
		- 上传本地 glTF/GLB 文件。
		- `AvatarMappingPanel` 会解析模型骨骼并展示骨骼名列表。
		- 用户将以下逻辑关节映射到模型中的骨骼：
			- `head`, `spine`
			- `leftShoulder`, `leftElbow`, `leftHand`
			- `rightShoulder`, `rightElbow`, `rightHand`
		- 支持「自动建议映射」按钮，基于常见命名自动尝试填充，再由用户校正。
	- 确认后，配置会被保存为：

		```jsonc
		{
			"url": "本地 blob URL 或远程 URL",
			"mapping": { "leftShoulder": "...", "leftElbow": "...", ... },
			"raw": { "gltf": { /* GLTF 数据 */ }, "scene": {}, "bones": [], "nodes": [] },
			"meta": { "savedAt": "..." }
		}
		```

	- VR 控制页读取该配置后，会基于 `mapping` 构建 IK 链，实现自定义 Avatar 的 1:1 手臂跟随。

- **逻辑关节驱动的 IK 手臂跟随**
	- 使用「逻辑关节」抽象人格化关节点：

		```ts
		head, spine,
		leftShoulder, leftElbow, leftHand,
		rightShoulder, rightElbow, rightHand
		```

	- 对任意 Avatar，只要在映射中指定这 6 个关键骨骼，VR 控制页就可以：
		- 在 three.js 场景中找到对应 `Object3D`；
		- 构建左右手臂的 IK 链（肩 → 肘 → 手）；
		- 通过 WebXR 控制器的位姿驱动机器人手臂进行 1:1 跟随。
	- 当映射缺失时，会尝试基于骨骼命名自动推断骨骼链（仅作为开发辅助或默认模型 fallback）。

- **VR 行走 & 视角**
	- 使用左手柄摇杆控制机器人在场景中的行走与转向。
	- 机器人固定在用户前方一定距离，场景中提供地面网格与灯光，便于观察整体动作。
	- 右上角提供一个小型「镜像视图」摄像机，方便在屏幕上观察机器人整体动作效果。

---

## 目录结构概览

关键目录和文件：

- 根目录
	- `index.html`：VR 控制入口页面（加载 `src/main.js` → `App.vue` → `RobotVR.vue`）。
	- `config.html`：Avatar 配置页面（加载 `src/config-main.js` → `ConfigApp.vue`）。
	- `vite.config.js`：Vite 配置，启用多入口（`index.html` + `config.html`）。
- `public/`
	- `avatars.json`：预设 Avatar 列表（id/name/modelUrl/mapping）。
	- `models/RobotExpressive.glb`：默认机器人模型。
	- `models/low_poly_humanoid_robot.glb`：低模 Humanoid 机器人模型。
- `src/`
	- `main.js`：VR 控制页入口，挂载 `App.vue`。
	- `App.vue`：简单 Shell，渲染 `RobotVR` 组件。
	- `config-main.js`：配置页入口，挂载 `ConfigApp.vue`。
	- `ConfigApp.vue`：Avatar 配置页逻辑（预设选择 + 自定义上传 + 映射）。
	- `components/RobotVR.vue`：核心 VR 控制逻辑（三维场景、WebXR、IK、镜像视图等）。
	- `customAvatar/AvatarMappingPanel.vue`：自定义模型上传 & 逻辑关节映射 UI。
	- `customAvatar/avatarTypes.js`：逻辑关节定义与 AvatarConfig 类型工具函数。
	- `customAvatar/avatarLoader.js`：自定义模型加载与骨骼分析工具。

---

## 本地运行

### 环境要求

- Node.js（推荐 18+）
- npm 或 pnpm / yarn

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

默认会在类似 `http://localhost:5173/` 启动 Vite 开发服务器。

### 构建生产版本

```bash
npm run build
```

构建结果输出到 `dist/` 目录，可用任意静态服务器（如 Nginx）托管。

---

## 使用说明：预设 Avatar 体验

这是给「想快速体验 VR 控制」的用户准备的最简单路径。

1. 启动开发服务器或部署站点。
2. 在支持 WebXR 的浏览器中打开 `http://localhost:5173/config.html`（或部署后的 `/config.html`）。
3. 在「预设 Avatar」下拉列表中选择一个机器人（例如默认机器人或低模机器人）。
4. 点击「使用此预设」，然后点击「进入 VR 控制」。
5. 在 VR 控制页点击页面上的「进入 VR」按钮，即可进入 VR 并通过手柄控制机器人（行走 + 手臂跟随）。

> 提示：在 VR 头显自带浏览器中，可以直接访问 `/config.html` + `/`，只使用预设即可完成体验，无需上传本地文件。

---

## 使用说明：上传自定义模型并绑定骨骼

这是项目的「高级模式」，适合有自己 GLB/GLTF 模型的用户（例如 Mixamo 导出、自己建模的人形机器人）。

1. 在 **桌面浏览器** 中打开 `http://localhost:5173/config.html`。
2. 在「自定义模型」区域点击「选择文件」，上传你的 `.glb` 或 `.gltf` 文件。
3. 等待加载完成后，左侧会显示模型的骨骼列表。
4. 在关节映射表中，为每个逻辑关节选择对应的骨骼：
	 - `head`, `spine`
	 - `leftShoulder`, `leftElbow`, `leftHand`
	 - `rightShoulder`, `rightElbow`, `rightHand`
5. 可先点击「自动建议映射」尝试自动匹配，然后手动校正有问题的项。
6. 点击「使用该模型」，配置会被保存到浏览器 `localStorage`（键：`vr_avatar_config_v1`）。
7. 点击「进入 VR 控制」，跳转到 `/` 页面。
8. 在 VR 控制页中点击「进入 VR」按钮，完成校准后，你的自定义模型就会在 VR 中实现行走与 1:1 手臂跟随。

> 注意：
> - 由于 VR 头显中的浏览器通常不支持本地文件选择，**上传 + 映射步骤推荐在桌面浏览器中完成**。
> - 如果使用 SteamVR + 一体机串流（例如 Vive Focus 3 串流到 PC），可以在 PC 浏览器中完成上传与映射，然后用同一个浏览器进入 WebXR，会通过 SteamVR 把画面和控制串流到一体机。

---

## VR 设备与浏览器建议

- **PC + SteamVR 路线**（推荐开发＆调试）：
	- 在 PC 上安装 SteamVR。
	- 使用 Chrome / Edge（支持 WebXR）访问 `http://localhost:5173/`。
	- 通过 SteamVR 把 WebXR 会话映射到 VR 头显和手柄输入。

- **一体机（如 Vive Focus 3）+ 串流**：
	- 使用厂商提供的串流软件（如 Vive Business Streaming）把一体机连接到 PC。
	- 在 PC 浏览器中运行本项目，进入 WebXR；画面和控制信号通过串流传到一体机。

- **一体机自带浏览器直连站点**：
	- 访问部署好的站点 `https://your-domain/`。
	- 使用预设 Avatar 体验 VR 控制（因为一体机浏览器通常无法方便地选择本地 GLB 文件）。

---

## 后续计划 / TODO

- 更多预设 Avatar（包括不同风格的人形机器人、未来如宇树 G1 等）。
- 进一步增强 IK 与碰撞避免，让动作更自然稳定。
- 将 Avatar 配置（模型 URL + 映射）从 `localStorage` 抽象为可分享的 JSON 或后端存储，支持分享给他人复用。
- 提供更直观的可视化调试面板，用于观察骨骼链、关节限制和 IK 目标。

---

## License

根据你实际选择的协议填写（MIT / Apache-2.0 / GPL 等）。当前仓库如未声明，默认视为保留所有权利。

