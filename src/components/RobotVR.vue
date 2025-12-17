<template>
  <div ref="container" id="vr-container"></div>
</template>

<script setup>
import * as THREE from 'three';
import { ref, onMounted, onUnmounted } from 'vue';
import { VRButton } from '../VRButton.js'; 
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadCustomAvatarFile, createBlobUrlFromArrayBuffer } from '../utils/avatarStorage.js';
import { createRecordingManager } from '../utils/recordingManager.js';
import logger from '../utils/logger.js';
// VR 控制页不再内嵌 AvatarMappingPanel，改由独立配置页负责上传和映射

const container = ref(null);
// 当前使用的 Avatar 配置（为空时使用内置 RobotExpressive）
// 可能来自：
// - 预设（avatars.json 中的某一项）：{ presetId, modelUrl, mapping, meta }
// - 自定义上传：{ source: 'custom', fileName, mapping, meta }
const currentAvatarConfig = ref(null);
const AVATAR_CONFIG_KEY = 'vr_avatar_config_v1';
let camera, scene, renderer, robot, mixer;
let controller1, controller2; // VR 手柄对象
let controller1Hand = null;   // 'left' | 'right' | null
let controller2Hand = null;   // 'left' | 'right' | null
const controllersByHand = { left: null, right: null };
let inputSourcesChangeHandler = null;

function bindInputSourcesListener(session) {
  if (!session || inputSourcesChangeHandler) return;
  inputSourcesChangeHandler = (event) => {
    if (!event) return;
    if (event.added && event.added.length) {
      event.added.forEach(src => {
        if (!src || !src.handedness) return;
        getControllerByHand(src.handedness);
      });
    }
    if (event.removed && event.removed.length) {
      event.removed.forEach(src => {
        if (!src || !src.handedness) return;
        if (controllersByHand[src.handedness]) {
          controllersByHand[src.handedness] = null;
        }
      });
    }
  };
  session.addEventListener('inputsourceschange', inputSourcesChangeHandler);
}

function unbindInputSourcesListener(session) {
  if (!session || !inputSourcesChangeHandler) return;
  session.removeEventListener('inputsourceschange', inputSourcesChangeHandler);
  inputSourcesChangeHandler = null;
}
let clock = new THREE.Clock();
let idleAction, walkAction;
let leftHandFollow = false;
let rightHandFollow = false;
let lastUserPosition = new THREE.Vector3();

// === 校准与镜像状态 ===
let calibrating = false;      // 进入VR后的校准阶段：提示用户双手下垂
let mirroringActive = false;  // 校准确认后开始持续模仿（无需一直按扳机）
let awaitingFollowStart = false; // 第一次扳机：复位到下垂并提示；第二次扳机：开始跟随

// === 镜像映射系统（新增）===
// 记录按下扳机时的初始状态
let leftHandInitialized = false;
let rightHandInitialized = false;
let leftControllerInitialOffset = new THREE.Vector3();  // 左手柄相对相机的初始偏移
let rightControllerInitialOffset = new THREE.Vector3(); // 右手柄相对相机的初始偏移
let leftHandInitialPos = new THREE.Vector3();  // 左手腕的初始世界位置
let rightHandInitialPos = new THREE.Vector3(); // 右手腕的初始世界位置
let cameraInitialPos = new THREE.Vector3();    // VR相机的初始位置
let cameraInitialQuat = new THREE.Quaternion(); // VR相机初始朝向
let invCameraInitialQuat = new THREE.Quaternion(); // 其逆
let cameraInitialYaw = 0; // 相机初始的绕Y轴朝向（弧度）
let leftControllerInitialLocalUser = new THREE.Vector3();  // 左手柄在“用户参照系(相机初始)”下的初始向量
let rightControllerInitialLocalUser = new THREE.Vector3(); // 右手柄在“用户参照系(相机初始)”下的初始向量
let leftHandInitialLocal = new THREE.Vector3();  // 左手腕在“机器人本地坐标系”下的初始位置
let rightHandInitialLocal = new THREE.Vector3(); // 右手腕在“机器人本地坐标系”下的初始位置
let robotHead = null; // 机器人头部骨骼引用（用于手部映射参考）
let headInitialLocal = new THREE.Vector3(); // 头部在机器人本地坐标系下的位置
let leftHandOffsetFromHeadLocal = new THREE.Vector3(); // 左手腕相对头部的本地偏移
let rightHandOffsetFromHeadLocal = new THREE.Vector3(); // 右手腕相对头部的本地偏移
const headWorldTemp = new THREE.Vector3();
const headLocalTemp = new THREE.Vector3();
let lastLeftLogTime = 0;
let lastRightLogTime = 0;
const recordingManager = createRecordingManager();

// 镜像视图相关
let mirrorCamera, mirrorRenderer;
let mirrorViewActive = true; // 默认开启镜像视图
// 摇杆控制机器人移动
let leftJoystickAxes = { x: 0, y: 0 }; // 左摇杆输入
let robotVelocity = new THREE.Vector3(); // 机器人移动速度
const ROBOT_WALK_SPEED = 1.5; // 机器人行走速度 (米/秒)
const ROBOT_TURN_SPEED = 2.0; // 机器人转向速度 (弧度/秒)

// === 人类手臂长度估算（用于比例缩放）===
// 标准人类手臂长度约 0.55-0.65m，这里取中间值
const HUMAN_ARM_LENGTH = 0.60; // 米

// 手臂跟随增益
// 因为已经有 IK 比例缩放，这里应该接近 1:1
// X: 左右方向，Y: 上下方向，Z: 前后方向（负值因为用户面向+Z，机器人面向-Z）
const FOLLOW_GAIN = new THREE.Vector3(1.0, 1.0, -1.0);
// 上举增益 - 既然 IK 已经正确缩放，不需要额外放大
const Y_UP_THRESHOLD = 0.25; // m，相对相机的上举增量超过该值时开始加成
const Y_UP_BOOST = 1.0;      // 改为 1.0，不额外放大
// 校准时“手臂下垂”初始姿势的左右/前向偏移（米）
const CALIB_SIDE_OFFSET = 0.35;   // 向身体两侧再放一点，避免双手靠得太近
const CALIB_FORWARD_OFFSET = 0.0; // 不向前探，避免在腹前相互靠近

// 屏幕调试显示（输出到控制台，可根据 allowRepeat 避免刷屏）
const _debugSeenMessages = new Set();
function showDebug(message, allowRepeat = false) {
  if (message == null) return;
  if (!allowRepeat) {
    if (_debugSeenMessages.has(message)) return;
    _debugSeenMessages.add(message);
  }
  logger.debug(`[DEBUG] ${message}`);
}

function getActiveAvatarName() {
  const config = currentAvatarConfig.value;
  if (!config) return 'RobotExpressive';
  if (config.meta && config.meta.displayName) return config.meta.displayName;
  if (config.fileName) return config.fileName;
  if (config.presetId) return config.presetId;
  if (config.modelUrl) return config.modelUrl.split('/').pop();
  return 'CustomAvatar';
}

// 简单的提示覆盖层（仅用于校准提示，不属于调试面板）
let hintDiv = null;
function showHint(text) {
  if (!hintDiv) {
    hintDiv = document.createElement('div');
    Object.assign(hintDiv.style, {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
      padding: '16px 20px', background: 'rgba(0,0,0,0.78)', color: '#fff', border: '2px solid #0f0',
      borderRadius: '10px', zIndex: 10001, maxWidth: '90vw', textAlign: 'center', whiteSpace: 'pre-line'
    });
    document.body.appendChild(hintDiv);
  }
  hintDiv.textContent = text || '';
  hintDiv.style.display = 'block';
}
function hideHint() { if (hintDiv) hintDiv.style.display = 'none'; }

// === VR 内 3D 调试面板 ===
let vrDebugPanel = null;
let vrDebugTexture = null;
let vrDebugCanvas = null;
let vrDebugCtx = null;
const CHINESE_NUMERAL = ['零','一','二','三','四','五','六','七','八','九','十'];

function formatRecordLabel(count) {
  if (!count) return '未记录';
  if (count > 0 && count <= 10) {
    return `第${CHINESE_NUMERAL[count]}次记录`;
  }
  return `第${count}次记录`;
}

let recordCount = 0;
let lastRecordLabel = formatRecordLabel(0);

function createVRDebugPanel() {
  // 创建用于绘制文字的 Canvas
  vrDebugCanvas = document.createElement('canvas');
  vrDebugCanvas.width = 512;
  vrDebugCanvas.height = 256;
  vrDebugCtx = vrDebugCanvas.getContext('2d');
  
  // 创建纹理
  vrDebugTexture = new THREE.CanvasTexture(vrDebugCanvas);
  vrDebugTexture.needsUpdate = true;
  
  // 创建面板几何体和材质
  const geometry = new THREE.PlaneGeometry(1.0, 0.5);
  const material = new THREE.MeshBasicMaterial({
    map: vrDebugTexture,
    transparent: true,
    side: THREE.DoubleSide
  });
  
  vrDebugPanel = new THREE.Mesh(geometry, material);
  // 固定在世界坐标的左侧位置，不跟随用户
  vrDebugPanel.position.set(-1.5, 1.5, -1.0); // 左侧1.5米，高度1.5米，前方1米
  vrDebugPanel.rotation.y = Math.PI / 4; // 稍微转向中心，方便用户侧头查看
  
  return vrDebugPanel;
}

function updateVRDebugPanel(lines) {
  if (!vrDebugCtx || !vrDebugTexture) return;
  
  const ctx = vrDebugCtx;
  const w = vrDebugCanvas.width;
  const h = vrDebugCanvas.height;
  
  // 清空画布
  ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.fillRect(0, 0, w, h);
  
  // 绘制边框
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, w - 4, h - 4);
  
  // 绘制文字
  ctx.fillStyle = '#00ff00';
  ctx.font = '24px monospace';
  
  const lineHeight = 30;
  let y = 35;
  for (const line of lines) {
    ctx.fillText(line, 15, y);
    y += lineHeight;
  }
  
  vrDebugTexture.needsUpdate = true;
}

// 动态解析的手部骨骼名称（会在模型加载后修正）
let LEFT_HAND_NAME = 'mixamorigLeftHand';
let RIGHT_HAND_NAME = 'mixamorigRightHand';
// 由 Avatar 映射显式指定的关节名称（优先级高于自动推断）
// 对应原始骨骼结构：Shoulder → UpperArm → LowerArm → Hand/Palm
let MAPPED_JOINTS = {
  leftShoulder: '',
  leftUpperArm: '',
  leftLowerArm: '',
  leftHand: '',
  rightShoulder: '',
  rightUpperArm: '',
  rightLowerArm: '',
  rightHand: '',
};
// 保存加载时检测到的骨骼名称，供运行时查找使用
let detectedBoneNames = [];
let detectedMeshSkeletonBones = [];
let leftArmChain = [];
let rightArmChain = [];
let leftArmChainInfo = null;
let rightArmChainInfo = null;
let ikBlendActive = false;
let showDebugHelpers = false;
let skeletonHelper = null;
let fingerSpheres = [];
let meshWireframePrev = new Map();
// joint limits map: regex -> {min: [x,y,z], max: [x,y,z]} in radians
const jointLimits = [
  { test: /shoulder/i, min: [-Math.PI/2, -Math.PI/2, -Math.PI/2], max: [Math.PI/2, Math.PI/2, Math.PI/2] },
  { test: /upperarm/i, min: [-Math.PI/2, -Math.PI/2, -Math.PI/2], max: [Math.PI/2, Math.PI/2, Math.PI/2] },
  { test: /lowerarm/i, min: [0, -Math.PI/2, -Math.PI/2], max: [Math.PI, Math.PI/2, Math.PI/2] },
  { test: /hand|palm/i, min: [-Math.PI/2, -Math.PI/2, -Math.PI/2], max: [Math.PI/2, Math.PI/2, Math.PI/2] },
  // finger joints: prevent extreme unnatural rotations (conservative defaults)
  { test: /thumb/i, min: [-Math.PI/2, -Math.PI/2, -Math.PI/2], max: [Math.PI/2, Math.PI/2, Math.PI/2] },
  { test: /index|middle|ring/i, min: [-0.1, -0.3, -0.3], max: [0.8, 0.3, 0.3] }
];
let fingerBonesLeft = [];
let fingerBonesRight = [];
let fingerSavedQuats = {};
let fingersLocked = false;
let palmBindQuats = {}; // 保存 palm/hand/wrist 的绑定四元数以便在 IK 后恢复
let leftFingerChains = {}; // map fingerName -> { bones:[], info }
let rightFingerChains = {};
let bodyColliders = []; // 简单的躯干碰撞球列表 {center: Vector3, radius: number}
let colliderMeshes = []; // visual helpers for colliders
let _onKeyDown = null;
let _onKeyUp = null;
let _onPointerMove = null;
// 用于整体跟随的偏移量（机器人在用户前方，便于观察）
// Z值为负表示前方，VR中使用绝对值
const ROBOT_FOLLOW_OFFSET = new THREE.Vector3(0, -0.8, -3.0); // 前方3米，桌面模式降低0.8米（俯视效果）

// ****** 配置项 (已根据 RobotExpressive 模型调整) ******
const ROBOT_MODEL_PATH = '/models/RobotExpressive.glb'; 
const LOCOMOTION_SPEED = 0.05;
// RobotExpressive 模型中右手关节的名称
const RIGHT_HAND_JOINT_NAME = 'mixamorigRightHand'; 

// 将任意机器人模型放置在用户前方的通用函数
function placeRobotInFrontOfUser(robotObject) {
  if (!robotObject) return;
  // 机器人固定在用户前方2米处（距离缩近便于观察）
  // 注意：在 WebXR 中，-Z 是用户面对的方向（前方）
  robotObject.position.set(0, 0, -2.0);
  // 旋转机器人使其面向用户（+Z方向）
  // 大多数模型默认面向 +Z，所以旋转180度让它面向用户
  if (robotObject.rotation) {
    robotObject.rotation.y = Math.PI;
  }
  logger.debug('[VR] Robot placed at:', robotObject.position.toArray());
}

function setupRecordingManager() {
  const resolveArmJoint = (chain, joint) => {
    if (!chain || !chain.length) return null;
    if (chain.length >= 4) {
      if (joint === 'shoulder') return chain[0];
      if (joint === 'upperArm') return chain[1];
      if (joint === 'lowerArm') return chain[2];
      if (joint === 'hand') return chain[3];
    }
    if (chain.length === 3) {
      if (joint === 'upperArm') return chain[0];
      if (joint === 'lowerArm') return chain[1];
      if (joint === 'hand') return chain[2];
      return null;
    }
    if (chain.length === 2) {
      if (joint === 'upperArm') return chain[0];
      if (joint === 'hand') return chain[1];
      return null;
    }
    if (chain.length === 1) {
      if (joint === 'hand' || joint === 'upperArm') return chain[0];
      return null;
    }
    return null;
  };

  recordCount = 0;
  lastRecordLabel = formatRecordLabel(recordCount);

  recordingManager.init(
    {
      renderer,
      getUserHeadObject: () => camera,
      getControllerObject: (hand) => getControllerByHand(hand),
      getRobotPart: (part) => {
        if (part === 'head') return robotHead;
        if (part === 'leftShoulder') return resolveArmJoint(leftArmChain, 'shoulder');
        if (part === 'leftUpperArm') return resolveArmJoint(leftArmChain, 'upperArm');
        if (part === 'leftLowerArm') return resolveArmJoint(leftArmChain, 'lowerArm');
        if (part === 'leftHand') return resolveArmJoint(leftArmChain, 'hand');
        if (part === 'rightShoulder') return resolveArmJoint(rightArmChain, 'shoulder');
        if (part === 'rightUpperArm') return resolveArmJoint(rightArmChain, 'upperArm');
        if (part === 'rightLowerArm') return resolveArmJoint(rightArmChain, 'lowerArm');
        if (part === 'rightHand') return resolveArmJoint(rightArmChain, 'hand');
        return null;
      },
    },
    {
      filenamePrefix: 'vr-snapshots',
      exportPromptMessage: '检测到 VR 记录数据，是否下载 CSV 文件？',
      metadataProvider: () => ({
        avatar: getActiveAvatarName(),
        mirroringActive,
      }),
      onCapture: (record) => {
        recordCount += 1;
        lastRecordLabel = formatRecordLabel(recordCount);
        showDebug(`[记录] 捕获 #${record.index} (${record.reason})`, true);
      },
      onExport: ({ filename, count }) => {
        logger.info(`[RecordingManager] Exported ${count} records → ${filename}`);
      },
    }
  );

  if (typeof window !== 'undefined' && import.meta.env.DEV) {
    window.__vrRecordingManager = recordingManager;
  }
}

onMounted(async () => {
  // 尝试从 localStorage 读取 Avatar 配置（由配置页写入）
  try {
    const raw = localStorage.getItem(AVATAR_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      currentAvatarConfig.value = parsed;
  logger.info('[RobotVR] Loaded avatar config from localStorage', parsed);

      // 如果是自定义上传的模型，需要从 IndexedDB 加载文件数据
      if (parsed.source === 'custom') {
  logger.info('[RobotVR] Detected custom avatar, loading from IndexedDB...');
        try {
          const fileRecord = await loadCustomAvatarFile();
          if (fileRecord && fileRecord.fileData) {
            // 将 ArrayBuffer 转换为 blob URL，供 GLTFLoader 使用
            const blobUrl = createBlobUrlFromArrayBuffer(fileRecord.fileData, fileRecord.fileName);
            // 把 blobUrl 附加到配置中，供 applyAvatarConfig 使用
            currentAvatarConfig.value = {
              ...parsed,
              modelUrl: blobUrl,
              _fromIndexedDB: true,
            };
            logger.info('[RobotVR] Custom avatar file loaded from IndexedDB, blobUrl created');
          } else {
            logger.warn('[RobotVR] No custom avatar file found in IndexedDB, will fallback to default');
            currentAvatarConfig.value = null;
          }
        } catch (e) {
          logger.error('[RobotVR] Failed to load custom avatar from IndexedDB', e);
          currentAvatarConfig.value = null;
        }
      }
    }
  } catch (e) {
  logger.warn('[RobotVR] Failed to read avatar config from localStorage', e);
  }

  init();
  animate();
  window.addEventListener('resize', onWindowResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize);
  if (renderer) renderer.setAnimationLoop(null);
  recordingManager.dispose();
  // 无需移除 PC 调试事件（未注册）
  if (hintDiv) { try { document.body.removeChild(hintDiv); } catch(e){} hintDiv = null; }
});

function init() {
  logger.info('[VR] init() called; ROBOT_MODEL_PATH=', ROBOT_MODEL_PATH);
  
  // 显示版本号以确认代码已更新
  setTimeout(() => {
    showDebug('🚀 v1.2 VR Debug Mode 已加载');
  }, 500);
  
  // 1. 场景/渲染器设置
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x404060); // 稍微偏蓝的背景，区别于灰色
  scene.add(new THREE.GridHelper(20, 40, 0x888888, 0x444444)); // 更大更明显的网格
  
  // === VR 调试辅助：添加醒目的参考物 ===
  // 原点标记（红色大球）
  const originMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xff0000 })
  );
  originMarker.position.set(0, 0.2, 0);
  scene.add(originMarker);
  
  // 坐标轴辅助线（红=X，绿=Y，蓝=Z）
  const axesHelper = new THREE.AxesHelper(2);
  scene.add(axesHelper);
  
  // 添加 VR 内调试面板
  const debugPanel = createVRDebugPanel();
  if (debugPanel) {
    scene.add(debugPanel);
    // 初始显示欢迎信息
    updateVRDebugPanel([
      'VR Robot Control',
      '---------------------',
      'Position: Loading...',
      'Arm Follow: OFF',
  '记录：' + lastRecordLabel,
      'Model: Loading...'
    ]);
  }
  
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 50);
  camera.position.set(0, 2.2, 0); // VR 相机初始位置在原点，高度2.2米（更高的俯视视角）

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace; // 修复：使用新版 API
  renderer.xr.enabled = true; // 启用 WebXR
  container.value.appendChild(renderer.domElement);

  setupRecordingManager();

  // WebXR 会话生命周期：进入时先进行校准，引导用户按扳机确认
  try {
    renderer.xr.addEventListener('sessionstart', () => {
      calibrating = false;
      mirroringActive = false;
      awaitingFollowStart = false;
      controllersByHand.left = null;
      controllersByHand.right = null;
      try {
        const session = renderer.xr.getSession ? renderer.xr.getSession() : null;
        bindInputSourcesListener(session);
      } catch (_) {}
      showHint('按一次扳机：机器人手臂复位到自然下垂并提示\n再按一次扳机：开始 1:1 跟随');
    });
    renderer.xr.addEventListener('sessionend', () => {
      calibrating = false;
      mirroringActive = false;
      awaitingFollowStart = false;
      try {
        const session = renderer.xr.getSession ? renderer.xr.getSession() : null;
        unbindInputSourcesListener(session);
      } catch (_) {}
      controllersByHand.left = null;
      controllersByHand.right = null;
      showDebug('VR 会话结束');
    });
  } catch (e) {
    // 某些环境可能没有事件分发，忽略
  }

  // 2. VR 入口按钮
  container.value.appendChild(VRButton.createButton(renderer));

  // 3. 光源
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));
  scene.add(new THREE.DirectionalLight(0xffffff, 0.8));

  // 4. 加载机器人模型（默认或根据配置加载）
  if (currentAvatarConfig.value) {
    try {
      // 如果只是一个包含 modelUrl + mapping 的轻量配置，则在内部再次用 GLTFLoader 加载
      applyAvatarConfig(currentAvatarConfig.value);
    } catch (e) {
  logger.error('[Avatar] apply avatar on init failed, fallback to default robot', e);
      loadRobotModel();
    }
  } else {
    loadRobotModel();
  }

  // 5. 配置 VR 控制器
  setupControllers();

  // 6. 创建右上角镜像视图
  setupMirrorView();

  // 初始化 lastUserPosition（以当前相机位置为基准）
  try {
    const xrCamera = renderer.xr.getCamera(camera);
    lastUserPosition.copy(xrCamera.position);
  } catch (e) {
    lastUserPosition.set(0, 0, 0);
  }

  // === PC 模拟：创建虚拟控制器并绑定键盘/鼠标事件 ===
  // 当手柄 follow 状态改变时，更新 IK vs 动画 混合（PC 调试已移除）
  const updateIKBlend = () => {
    // 只要处于持续模仿（或临时跟随）就关闭动画以免相互影响
    const active = mirroringActive || leftHandFollow || rightHandFollow;
    if (active === ikBlendActive) return;
    ikBlendActive = active;
    if (mixer) {
      if (ikBlendActive) {
  logger.debug('[IK] activating IK: fading out animations');
        if (walkAction) walkAction.fadeOut(0.2);
        if (idleAction) idleAction.fadeOut(0.2);
        // freeze fingers to avoid animation-driven penetration
        lockFingers();
      } else {
  logger.debug('[IK] deactivating IK: restoring animations');
        if (idleAction) { idleAction.reset(); idleAction.fadeIn(0.2); idleAction.play(); }
        if (walkAction) { walkAction.reset(); walkAction.fadeIn(0.2); /* don't necessarily play walk */ }
        // restore fingers
        unlockFingers();
      }
    }
  };
  // PC 调试输入与键盘切换已移除
}

function loadRobotModel() {
  // 占位符模型 (在模型加载失败时显示)
  robot = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 1.5, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x00ff00, transparent: true, opacity: 0.5 })
  );
  robot.position.y = 0.75;
  scene.add(robot);

  const loader = new GLTFLoader();
  logger.info('[VR] GLTFLoader starting load for', ROBOT_MODEL_PATH);
  loader.load(
    ROBOT_MODEL_PATH,
    function (gltf) {
      scene.remove(robot); // 移除占位符
      robot = gltf.scene;
  // 使用通用的放置逻辑
  placeRobotInFrontOfUser(robot);
  scene.add(robot);
      
      showDebug('✓ 机器人加载完成，位置:(0,0,-3) 朝向:-Z(背对用户)');

    // 调试模型关节：在控制台查看所有关节名称，并自动检测左右手骨骼名称
    const boneNames = [];
    const meshSkeletonBones = [];
    robot.traverse((child) => {
      if (child.isBone) {
        boneNames.push(child.name);
        const lname = child.name.toLowerCase();
        // 只在明确包含 lefthand/righthand 时更新，避免被 Palm2L/Palm2R 覆盖
        if (lname.includes('lefthand')) LEFT_HAND_NAME = child.name;
        if (lname.includes('righthand')) RIGHT_HAND_NAME = child.name;
      }
      if (child.isMesh && child.skeleton) {
        meshSkeletonBones.push(child.skeleton.bones.map(b=>b.name));
      }
    });
    // 导出至全局变量供其它函数调试/查找使用
    detectedBoneNames = boneNames;
    detectedMeshSkeletonBones = meshSkeletonBones;
  logger.debug('[MODEL] boneNames:', boneNames);
  logger.debug('[MODEL] mesh skeleton bones:', meshSkeletonBones);
  logger.debug('[MODEL] resolved LEFT_HAND_NAME=', LEFT_HAND_NAME, ' RIGHT_HAND_NAME=', RIGHT_HAND_NAME);
    // 进一步尝试解析出实际可用的骨骼/节点名称（将用于稳定的运行时查找）
    try {
      // 如果 findBone 可用，尝试找到实际对象并用其 name 作为首选名称
      if (typeof findBone === 'function') {
        // 传入侧向提示，优先寻找带 L / R 后缀或包含 left/right 的名称
        const leftObj = findBone(robot, LEFT_HAND_NAME, 'left');
        const rightObj = findBone(robot, RIGHT_HAND_NAME, 'right');
        if (leftObj) LEFT_HAND_NAME = leftObj.name;
        if (rightObj) RIGHT_HAND_NAME = rightObj.name;
  logger.debug('[MODEL] final mapped LEFT_HAND_NAME=', LEFT_HAND_NAME, ' RIGHT_HAND_NAME=', RIGHT_HAND_NAME);
      }
    } catch (e) {
  logger.warn('[MODEL] findBone mapping failed', e);
    }

    // 构建手臂骨骼链（若存在）用于后续 IK 计算
    try {
      buildArmChains();
  logger.debug('[MODEL] leftArmChain=', leftArmChain.map(b=>b.name));
  logger.debug('[MODEL] rightArmChain=', rightArmChain.map(b=>b.name));
    } catch (e) {
  logger.warn('[MODEL] buildArmChains failed', e);
    }
    // 缓存头骨引用（用于手部映射的参考点）
    try {
      // 先尝试精确名称匹配，避免把 Palm/Hand 当成 Head
      robotHead = robot.getObjectByName('mixamorigHead')
                || robot.getObjectByName('Head');

      // 如果精确匹配失败，再用 findBone 做模糊查找，但显式排除 Palm/Hand/Finger
      if (!robotHead && typeof findBone === 'function') {
        const candidate = findBone(robot, 'Head');
        if (candidate && !/palm|hand|finger/i.test(candidate.name)) {
          robotHead = candidate;
        }
      }

      if (robotHead) {
  logger.debug('[MODEL] robotHead node =', robotHead.name);
      } else {
  logger.warn('[MODEL] robot head bone not found, fallback to robot origin');
      }
    } catch (e) {
  logger.warn('[MODEL] resolve robot head failed', e);
      robotHead = null;
    }
    // 额外检测手指骨骼
    try {
      detectFingerBones();
  logger.debug('[MODEL] fingerBonesLeft=', fingerBonesLeft.map(b=>b.name));
  logger.debug('[MODEL] fingerBonesRight=', fingerBonesRight.map(b=>b.name));
    } catch (e) {
  logger.warn('[MODEL] detectFingerBones failed', e);
    }
    // 构建 per-finger 短链，用于短链 IK（thumb/index/middle）
    try {
      buildFingerChains();
  logger.debug('[MODEL] leftFingerChains=', Object.keys(leftFingerChains));
  logger.debug('[MODEL] rightFingerChains=', Object.keys(rightFingerChains));
  } catch (e) { logger.warn('[MODEL] buildFingerChains failed', e); }
    // 保存 palm / hand / wrist 的绑定四元数（rest pose），用于在 IK 后恢复或限制 palm 旋转
    try {
      palmBindQuats = {};
      const allChains = (leftArmChain || []).concat(rightArmChain || []);
      for (const b of allChains) {
        if (!b || !b.name) continue;
        if (/palm|hand|wrist/i.test(b.name)) {
          palmBindQuats[b.name] = b.quaternion.clone();
        }
      }
    } catch (e) {
  logger.warn('[MODEL] save palm bind quats failed', e);
    }
    // 创建调试可视化
    try {
      createDebugHelpers();
    } catch (e) {}
    // 初始化躯干简单碰撞体（基于已知骨骼位置）
    try {
      initBodyColliders();
      logger.debug('[MODEL] bodyColliders=', bodyColliders);
    } catch (e) { logger.warn('[MODEL] initBodyColliders failed', e); }

    if (gltf.animations && gltf.animations.length > 0) {
           mixer = new THREE.AnimationMixer(robot);
           logger.info(`[动画] 找到 ${gltf.animations.length} 个动画:`);
           gltf.animations.forEach((clip, index) => {
             logger.info(`  [${index}] "${clip.name}" - 时长: ${clip.duration.toFixed(2)}s`);
             const lowerName = clip.name.toLowerCase();
             
             // 待机动画
             if (lowerName.includes('idle')) {
               idleAction = mixer.clipAction(clip);
               logger.debug(`    → 设为待机动画`);
             }
             
             // 行走动画：只匹配 "walking"，排除 "walkjump"
             if (lowerName === 'walking' || (lowerName.includes('walk') && !lowerName.includes('jump') && !lowerName.includes('run'))) {
               walkAction = mixer.clipAction(clip);
               logger.debug(`    → 设为行走动画`);
             }
           });
           
           // 如果没找到walk动画，尝试其他名称
           if (!walkAction) {
             logger.info('[动画] 未找到walk动画，尝试查找其他名称...');
             gltf.animations.forEach((clip) => {
               const lowerName = clip.name.toLowerCase();
               if (lowerName.includes('walking') || lowerName === 'walk') {
                 walkAction = mixer.clipAction(clip);
                 logger.debug(`    → 使用 "${clip.name}" 作为行走动画`);
               }
             });
           }
           
           if (idleAction) {
             idleAction.play();
             logger.debug('[动画] 播放待机动画');
           }
           if (walkAction) {
             walkAction.timeScale = 1.0; // 使用正常速度（0.96秒一个循环）
             logger.debug('[动画] 行走动画已准备，速度: 1.0x');
           }
      }
          logger.info('机器人模型加载成功！');
    },
    // progress callback
    function (xhr) {
      try {
        const pct = xhr.total ? (xhr.loaded / xhr.total * 100).toFixed(1) : null;
        logger.debug('[VR] GLTFLoader progress', xhr.loaded, 'bytes', pct ? pct + '%' : '');
      } catch (e) {}
    },
    function (error) {
      logger.error('[VR] 加载机器人模型失败（GLTFLoader onError）。将使用占位模型。', error);
    }
  );
}

// 应用 Avatar 配置：
// - 若有 modelUrl（预设 或 从 IndexedDB 加载的自定义模型），通过 GLTFLoader 加载
// - 若包含 raw.gltf/scene（仅同页内存中），直接使用现有场景克隆（已废弃路径）
function applyAvatarConfig(config) {
  if (!scene) return;

  // 1. 清理旧机器人
  if (robot && robot.parent === scene) {
    try { scene.remove(robot); } catch (e) { logger.warn('[Avatar] remove old robot failed', e); }
  }

  // 2. 有 modelUrl：通过 GLTFLoader 加载（预设 或 自定义上传）
  if (config && config.modelUrl) {
    const url = config.modelUrl;
    const isCustom = config.source === 'custom' || config._fromIndexedDB;
    logger.info(`[Avatar] loading ${isCustom ? 'custom' : 'preset'} avatar from url:`, url);

    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        try {
          robot = gltf.scene;
          placeRobotInFrontOfUser(robot);
          scene.add(robot);

          // 根据映射优先确定关键骨骼名称
          try {
            if (config.mapping) {
              // 记录完整映射，供后续 IK 构建使用
              // 对应骨骼结构：Shoulder → UpperArm → LowerArm → Hand
              MAPPED_JOINTS = {
                leftShoulder: config.mapping.leftShoulder || '',
                leftUpperArm: config.mapping.leftUpperArm || '',
                leftLowerArm: config.mapping.leftLowerArm || '',
                leftHand: config.mapping.leftHand || '',
                rightShoulder: config.mapping.rightShoulder || '',
                rightUpperArm: config.mapping.rightUpperArm || '',
                rightLowerArm: config.mapping.rightLowerArm || '',
                rightHand: config.mapping.rightHand || '',
              };

              if (MAPPED_JOINTS.leftHand) LEFT_HAND_NAME = MAPPED_JOINTS.leftHand;
              if (MAPPED_JOINTS.rightHand) RIGHT_HAND_NAME = MAPPED_JOINTS.rightHand;
            } else {
              MAPPED_JOINTS = {
                leftShoulder: '', leftUpperArm: '', leftLowerArm: '', leftHand: '',
                rightShoulder: '', rightUpperArm: '', rightLowerArm: '', rightHand: '',
              };
            }
          } catch (e) {
            logger.warn('[Avatar] apply preset mapping names failed', e);
          }

          // 重新收集骨骼名称
          detectedBoneNames = [];
          detectedMeshSkeletonBones = [];
          robot.traverse((child) => {
            if (child.isBone) detectedBoneNames.push(child.name);
            if (child.isMesh && child.skeleton) {
              detectedMeshSkeletonBones.push(child.skeleton.bones.map((b) => b.name));
            }
          });
          logger.debug('[AVATAR] (preset) boneNames:', detectedBoneNames);
          logger.debug('[AVATAR] (preset) mesh skeleton bones:', detectedMeshSkeletonBones);

          // 重新构建手臂链、手指链和碰撞体等
          buildArmChainsFromMappingOrAuto();
          detectFingerBones();
          buildFingerChains();
          createDebugHelpers();
          initBodyColliders();

          // 重新建立动画混合器（若模型带有动画）
          mixer = null;
          idleAction = null;
          walkAction = null;
          if (gltf.animations && gltf.animations.length) {
            mixer = new THREE.AnimationMixer(robot);
            logger.info(`[AVATAR] found ${gltf.animations.length} animations`);
            gltf.animations.forEach((clip) => {
              const lowerName = clip.name.toLowerCase();
              if (lowerName.includes('idle')) idleAction = mixer.clipAction(clip);
              if (lowerName === 'walking' || (lowerName.includes('walk') && !lowerName.includes('jump') && !lowerName.includes('run'))) {
                walkAction = mixer.clipAction(clip);
              }
            });
            if (idleAction) idleAction.play();
          }
          logger.info(`[Avatar] ${isCustom ? 'custom' : 'preset'} avatar loaded successfully`);
        } catch (e) {
          logger.error('[Avatar] avatar post-setup failed, fallback to default', e);
          loadRobotModel();
        }
      },
      undefined,
      (error) => {
  logger.error('[Avatar] failed to load model url, fallback to default', error);
        loadRobotModel();
      }
    );

    return;
  }

  // 3. 自定义上传：使用 raw.scene
  if (!config || !config.raw || !config.raw.scene) {
    // 回退到默认模型
    loadRobotModel();
    return;
  }

  const { scene: avatarScene } = config.raw;
  // clone 一份干净的场景，避免直接把 Proxy / 共享引用塞进 three.js 渲染管线
  let cloned;
  try {
    cloned = avatarScene.clone(true);
  } catch (e) {
  logger.warn('[Avatar] clone avatar scene failed, fallback to original scene instance', e);
    cloned = avatarScene;
  }

  robot = cloned;
  placeRobotInFrontOfUser(robot);
  scene.add(robot);

  // 根据映射优先确定关键骨骼名称
  try {
    if (config.mapping) {
      MAPPED_JOINTS = {
        leftShoulder: config.mapping.leftShoulder || '',
        leftUpperArm: config.mapping.leftUpperArm || '',
        leftLowerArm: config.mapping.leftLowerArm || '',
        leftHand: config.mapping.leftHand || '',
        rightShoulder: config.mapping.rightShoulder || '',
        rightUpperArm: config.mapping.rightUpperArm || '',
        rightLowerArm: config.mapping.rightLowerArm || '',
        rightHand: config.mapping.rightHand || '',
      };

      if (MAPPED_JOINTS.leftHand) LEFT_HAND_NAME = MAPPED_JOINTS.leftHand;
      if (MAPPED_JOINTS.rightHand) RIGHT_HAND_NAME = MAPPED_JOINTS.rightHand;
    } else {
      MAPPED_JOINTS = {
        leftShoulder: '', leftUpperArm: '', leftLowerArm: '', leftHand: '',
        rightShoulder: '', rightUpperArm: '', rightLowerArm: '', rightHand: '',
      };
    }
  } catch (e) {
    logger.warn('[Avatar] apply mapping names failed', e);
  }

  // 像默认模型一样，重建骨骼链、手指、碰撞体和动画
  try {
    // 重新收集骨骼名称
    detectedBoneNames = [];
    detectedMeshSkeletonBones = [];
    robot.traverse((child) => {
      if (child.isBone) detectedBoneNames.push(child.name);
      if (child.isMesh && child.skeleton) {
        detectedMeshSkeletonBones.push(child.skeleton.bones.map((b) => b.name));
      }
    });
  logger.debug('[AVATAR] boneNames:', detectedBoneNames);
  logger.debug('[AVATAR] mesh skeleton bones:', detectedMeshSkeletonBones);

  // 重新构建手臂链、手指链和碰撞体等
  buildArmChainsFromMappingOrAuto();
    detectFingerBones();
    buildFingerChains();
    createDebugHelpers();
    initBodyColliders();

    // 重新建立动画混合器（若自定义模型带有动画）
    mixer = null;
    if (config.raw.gltf && config.raw.gltf.animations && config.raw.gltf.animations.length) {
      mixer = new THREE.AnimationMixer(robot);
  logger.info(`[AVATAR] found ${config.raw.gltf.animations.length} animations`);
      idleAction = null;
      walkAction = null;
      config.raw.gltf.animations.forEach((clip) => {
        const lowerName = clip.name.toLowerCase();
        if (lowerName.includes('idle')) idleAction = mixer.clipAction(clip);
        if (lowerName === 'walking' || (lowerName.includes('walk') && !lowerName.includes('jump') && !lowerName.includes('run'))) {
          walkAction = mixer.clipAction(clip);
        }
      });
      if (idleAction) idleAction.play();
    }
  } catch (e) {
    logger.error('[Avatar] post-setup for custom avatar failed', e);
  }
}

function setupControllers() {
    // 控制器 0 (左手柄：用于移动 Locomotion)
    controller1 = renderer.xr.getController(0);
    controller1.addEventListener('connected', onControllerConnected);
  controller1.addEventListener('connected', (e)=>{ try { controller1Hand = e.data && e.data.handedness || null; controller1.userData.handedness = controller1Hand; } catch(_){} });
  controller1.addEventListener('selectstart', () => {
    if (!mirroringActive && !awaitingFollowStart) {
      // 第一次扳机：让机器人手臂复位到自然下垂并提示
      resetArmsToDownPose();
      showHint('请将你的双臂也自然下垂\n再次按下扳机开始 1:1 跟随');
      awaitingFollowStart = true;
      return;
    }
    if (awaitingFollowStart) {
      calibrateInitialPose();
      hideHint();
      awaitingFollowStart = false;
      return;
    }
  });
  controller1.addEventListener('selectend', () => { 
    logger.debug('controller1 selectend'); 
  });
  // 支持 squeeze 事件作为备选（有些控制器使用 squeeze）
  controller1.addEventListener('squeezestart', () => { 
    logger.debug('controller1 squeezestart');
    if (calibrating) calibrateInitialPose();
  });
  controller1.addEventListener('squeezeend', () => { logger.debug('controller1 squeezeend'); });
    scene.add(controller1);

    // 控制器 1 (右手柄：用于手势跟随 Gestures)
    controller2 = renderer.xr.getController(1);
    controller2.addEventListener('connected', onControllerConnected);
  controller2.addEventListener('connected', (e)=>{ try { controller2Hand = e.data && e.data.handedness || null; controller2.userData.handedness = controller2Hand; } catch(_){} });
  controller2.addEventListener('selectstart', () => { 
    if (!mirroringActive && !awaitingFollowStart) {
      resetArmsToDownPose();
      showHint('请将你的双臂也自然下垂\n再次按下扳机开始 1:1 跟随');
      awaitingFollowStart = true;
      return;
    }
    if (awaitingFollowStart) {
      calibrateInitialPose();
      hideHint();
      awaitingFollowStart = false;
      return;
    }
  });
  controller2.addEventListener('selectend', () => { logger.debug('controller2 selectend'); });
  controller2.addEventListener('squeezestart', () => { 
    logger.debug('controller2 squeezestart');
    if (calibrating) calibrateInitialPose();
  });
  controller2.addEventListener('squeezeend', () => { logger.debug('controller2 squeezeend'); });
    scene.add(controller2);

    // 添加可视化的控制器网格
    const controllerGeometry = new THREE.BoxGeometry(0.02, 0.02, 0.2);
    const controllerMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const controllerMesh = new THREE.Mesh(controllerGeometry, controllerMaterial);
    controller1.add(controllerMesh.clone());
    controller2.add(controllerMesh.clone());
}

// 采集初始姿态并开始持续镜像（1:1 跟随）
function calibrateInitialPose() {
  if (!robot) return;
  // 采集相机位置与朝向（建立用户参照系）
  try {
    camera.getWorldPosition(cameraInitialPos);
    camera.getWorldQuaternion(cameraInitialQuat);
    invCameraInitialQuat.copy(cameraInitialQuat).invert();
    // 提取相机初始的绕Y轴朝向（仅使用 yaw 便于与机器人朝向对齐）
    const e = new THREE.Euler().setFromQuaternion(cameraInitialQuat, 'YXZ');
    cameraInitialYaw = e.y;
  } catch (e) { cameraInitialPos.set(0,0,0); cameraInitialQuat.identity && cameraInitialQuat.identity(); invCameraInitialQuat.identity && invCameraInitialQuat.identity(); }

  // 采集左右控制器相对相机的偏移
  try {
    const leftCtrl = getControllerByHand('left');
    if (leftCtrl) {
      const p = new THREE.Vector3();
      leftCtrl.getWorldPosition(p);
      leftControllerInitialOffset.copy(p).sub(cameraInitialPos);
      leftControllerInitialLocalUser.copy(leftControllerInitialOffset).applyQuaternion(invCameraInitialQuat);
    }
    const rightCtrl = getControllerByHand('right');
    if (rightCtrl) {
      const p = new THREE.Vector3();
      rightCtrl.getWorldPosition(p);
      rightControllerInitialOffset.copy(p).sub(cameraInitialPos);
      rightControllerInitialLocalUser.copy(rightControllerInitialOffset).applyQuaternion(invCameraInitialQuat);
    }
  } catch (e) {}

  // 设定“手臂下垂”的初始目标位置作为基准（而不是模型原始胸前姿势）
  try {
    const worldDown = new THREE.Vector3(0, -1, 0);
    const worldForward = new THREE.Vector3(0, 0, 1).applyQuaternion(robot.quaternion);
    const rootPos = new THREE.Vector3();
    robot.getWorldPosition(rootPos);

    // 计算每侧的“向外”向量：以各自肩相对机器人根的本地 X 符号确定
    const computeOutward = (shoulderObj, fallbackSign) => {
      if (!shoulderObj) {
        // 退化：直接用机器人本地 X 轴方向
        return new THREE.Vector3(fallbackSign, 0, 0).applyQuaternion(robot.quaternion).normalize();
      }
      const sp = new THREE.Vector3();
      shoulderObj.getWorldPosition(sp);
      const spLocal = sp.clone();
      robot.worldToLocal(spLocal);
      const sign = spLocal.x >= 0 ? 1 : -1;
      return new THREE.Vector3(sign, 0, 0).applyQuaternion(robot.quaternion).normalize();
    };

    const shoulderL = (leftArmChainInfo && leftArmChainInfo.bones && leftArmChainInfo.bones[0]) || findBone(robot, 'ShoulderL', 'left') || findBone(robot, LEFT_HAND_NAME, 'left') || robot;
    const shoulderR = (rightArmChainInfo && rightArmChainInfo.bones && rightArmChainInfo.bones[0]) || findBone(robot, 'ShoulderR', 'right') || findBone(robot, RIGHT_HAND_NAME || RIGHT_HAND_JOINT_NAME, 'right') || robot;

    const outL = computeOutward(shoulderL, -1);
    const outR = computeOutward(shoulderR, 1);

    const shoulderPosL = new THREE.Vector3();
    const shoulderPosR = new THREE.Vector3();
    shoulderL.getWorldPosition(shoulderPosL);
    shoulderR.getWorldPosition(shoulderPosR);

    const reachL = (leftArmChainInfo && leftArmChainInfo.total) ? leftArmChainInfo.total * 0.95 : 0.5;
    const reachR = (rightArmChainInfo && rightArmChainInfo.total) ? rightArmChainInfo.total * 0.95 : 0.5;

    // 左侧
    leftHandInitialPos.copy(shoulderPosL)
      .add(worldDown.clone().multiplyScalar(reachL))
      .add(outL.clone().multiplyScalar(CALIB_SIDE_OFFSET))
      .add(worldForward.clone().multiplyScalar(CALIB_FORWARD_OFFSET));
    // 右侧
    rightHandInitialPos.copy(shoulderPosR)
      .add(worldDown.clone().multiplyScalar(reachR))
      .add(outR.clone().multiplyScalar(CALIB_SIDE_OFFSET))
      .add(worldForward.clone().multiplyScalar(CALIB_FORWARD_OFFSET));
    // 保存本地手腕初始位置（机器人本地）
    leftHandInitialLocal.copy(leftHandInitialPos.clone());
    robot.worldToLocal(leftHandInitialLocal);
    rightHandInitialLocal.copy(rightHandInitialPos.clone());
    robot.worldToLocal(rightHandInitialLocal);
    const headLocalAtCalib = getHeadLocalPosition(new THREE.Vector3());
    headInitialLocal.copy(headLocalAtCalib);
    leftHandOffsetFromHeadLocal.copy(leftHandInitialLocal).sub(headInitialLocal);
    rightHandOffsetFromHeadLocal.copy(rightHandInitialLocal).sub(headInitialLocal);
  } catch (e) {}

  calibrating = false;
  mirroringActive = true;
  showDebug('✓ 校准完成：开始 1:1 模仿');

  // 激活 IK 混合：淡出动画并锁定手指
  try {
    if (mixer) {
      if (walkAction) walkAction.fadeOut(0.2);
      if (idleAction) idleAction.fadeOut(0.2);
    }
    lockFingers();
  } catch (e) {}
}

// 设置右上角镜像视图（显示机器人正面）
function setupMirrorView() {
  // 创建镜像相机 - 固定在机器人前方
  mirrorCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  
  // 创建小窗口渲染器（canvas 叠加在右上角）
  mirrorRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const size = 200; // 镜像视图大小（像素）
  mirrorRenderer.setSize(size, size);
  mirrorRenderer.outputColorSpace = THREE.SRGBColorSpace;
  
  // 设置镜像 canvas 样式（固定在右上角）
  const mirrorCanvas = mirrorRenderer.domElement;
  mirrorCanvas.style.position = 'absolute';
  mirrorCanvas.style.top = '10px';
  mirrorCanvas.style.right = '10px';
  mirrorCanvas.style.border = '3px solid rgba(255, 255, 255, 0.8)';
  mirrorCanvas.style.borderRadius = '8px';
  mirrorCanvas.style.zIndex = '1000';
  mirrorCanvas.style.pointerEvents = 'none'; // 不阻挡鼠标事件
  container.value.appendChild(mirrorCanvas);
  
  logger.info('[MIRROR] Mirror view created');
}

// 更新镜像视图相机位置（在机器人正前方）
function updateMirrorView() {
  if (!mirrorCamera || !mirrorRenderer || !robot || !mirrorViewActive) return;
  
  // 将镜像相机放在机器人正前方更远处，能看到全身
  const robotPos = new THREE.Vector3();
  robot.getWorldPosition(robotPos);
  
  const forward = new THREE.Vector3(0, 0, -1);
  forward.applyQuaternion(robot.quaternion);
  
  // 前方 3.0 米，高度 1.2 米（略微俯视）
  const camPos = robotPos.clone().add(forward.multiplyScalar(3.0)).add(new THREE.Vector3(0, 1.2, 0));
  mirrorCamera.position.copy(camPos);
  mirrorCamera.lookAt(robotPos.clone().add(new THREE.Vector3(0, 0.9, 0))); // 看向机器人上半身
  
  // 渲染镜像视图
  mirrorRenderer.render(scene, mirrorCamera);
}

// 复位手臂到“自然下垂”姿态（仅改变当前姿态，不启动跟随）
function resetArmsToDownPose() {
  if (!robot) return;
  try {
    const worldDown = new THREE.Vector3(0, -1, 0);
    const worldForward = new THREE.Vector3(0, 0, 1).applyQuaternion(robot.quaternion);
    const computeOutward = (shoulderObj, fallbackSign) => {
      if (!shoulderObj) {
        return new THREE.Vector3(fallbackSign, 0, 0).applyQuaternion(robot.quaternion).normalize();
      }
      const sp = new THREE.Vector3();
      shoulderObj.getWorldPosition(sp);
      const spLocal = sp.clone();
      robot.worldToLocal(spLocal);
      const sign = spLocal.x >= 0 ? 1 : -1;
      return new THREE.Vector3(sign, 0, 0).applyQuaternion(robot.quaternion).normalize();
    };
    const shoulderL = (leftArmChainInfo && leftArmChainInfo.bones && leftArmChainInfo.bones[0]) || findBone(robot, 'ShoulderL', 'left') || robot;
    const shoulderR = (rightArmChainInfo && rightArmChainInfo.bones && rightArmChainInfo.bones[0]) || findBone(robot, 'ShoulderR', 'right') || robot;
    const outL = computeOutward(shoulderL, -1);
    const outR = computeOutward(shoulderR, 1);
    const shoulderPosL = new THREE.Vector3(); shoulderL.getWorldPosition(shoulderPosL);
    const shoulderPosR = new THREE.Vector3(); shoulderR.getWorldPosition(shoulderPosR);
    const reachL = (leftArmChainInfo && leftArmChainInfo.total) ? leftArmChainInfo.total * 0.95 : 0.5;
    const reachR = (rightArmChainInfo && rightArmChainInfo.total) ? rightArmChainInfo.total * 0.95 : 0.5;
    const targetL = shoulderPosL.clone()
      .add(worldDown.clone().multiplyScalar(reachL))
      .add(outL.clone().multiplyScalar(CALIB_SIDE_OFFSET))
      .add(worldForward.clone().multiplyScalar(CALIB_FORWARD_OFFSET));
    const targetR = shoulderPosR.clone()
      .add(worldDown.clone().multiplyScalar(reachR))
      .add(outR.clone().multiplyScalar(CALIB_SIDE_OFFSET))
      .add(worldForward.clone().multiplyScalar(CALIB_FORWARD_OFFSET));
    // 用 IK 拉到目标，多迭代几次收敛
    // 骨骼链结构：[0]=Shoulder(锁骨), [1]=UpperArm(大臂), [2]=LowerArm(小臂), [3]=Hand(手掌)
    // IK 需要：UpperArm(肩部旋转), LowerArm(肘部弯曲), Hand(末端目标)
    if (leftArmChain && leftArmChain.length >= 4) {
      for (let i = 0; i < 6; i++) {
        simpleTwoJointIK(leftArmChain[1], leftArmChain[2], leftArmChain[3], targetL);
      }
    } else if (leftArmChain && leftArmChain.length === 3) {
      // 兼容没有 Shoulder 的 3 段链
      for (let i = 0; i < 6; i++) {
        simpleTwoJointIK(leftArmChain[0], leftArmChain[1], leftArmChain[2], targetL);
      }
    }
    if (rightArmChain && rightArmChain.length >= 4) {
      for (let i = 0; i < 6; i++) {
        simpleTwoJointIK(rightArmChain[1], rightArmChain[2], rightArmChain[3], targetR);
      }
    } else if (rightArmChain && rightArmChain.length === 3) {
      // 兼容没有 Shoulder 的 3 段链
      for (let i = 0; i < 6; i++) {
        simpleTwoJointIK(rightArmChain[0], rightArmChain[1], rightArmChain[2], targetR);
      }
    }
  } catch (e) {}
}

// 尝试以健壮的方式查找骨骼：优先精确名 -> 精确匹配检测名 -> 包含匹配 -> mesh skeleton bones -> 遍历搜索
function findBone(root, preferredName, sideHint) {
  if (!root) return null;
  // 1) 尝试精确名
  if (preferredName) {
    const byName = root.getObjectByName(preferredName);
    if (byName) return byName;
  }

  const handKeywords = ['hand', 'palm', 'wrist', 'thumb', 'index', 'middle', 'ring'];
  const isLeftName = (n) => {
    const lname = (n || '').toLowerCase();
    if (lname.includes('left')) return true;
    const last = n.slice(-1);
    if (last === 'L' || last === 'l') return true;
    return /_l$/i.test(n);
  };
  const isRightName = (n) => {
    const lname = (n || '').toLowerCase();
    if (lname.includes('right')) return true;
    const last = n.slice(-1);
    if (last === 'R' || last === 'r') return true;
    return /_r$/i.test(n);
  };

  // 2) 从 detectedBoneNames 中筛选候选项
  if (detectedBoneNames && detectedBoneNames.length) {
    // 优先：同时包含手部关键词与侧向标记的名称
    const candidates = [];
    for (const n of detectedBoneNames) {
      const ln = (n || '').toLowerCase();
      const hasHand = handKeywords.some(k => ln.includes(k));
      const left = isLeftName(n);
      const right = isRightName(n);
      candidates.push({ name: n, hasHand, left, right });
    }

    // 根据 sideHint 优先筛选
    if (sideHint === 'left') {
      let pick = candidates.find(c => c.hasHand && c.left) || candidates.find(c => c.left && c.name.toLowerCase().includes('palm')) || candidates.find(c => c.left) || candidates.find(c => c.hasHand);
      if (pick) return root.getObjectByName(pick.name);
    }
    if (sideHint === 'right') {
      let pick = candidates.find(c => c.hasHand && c.right) || candidates.find(c => c.right && c.name.toLowerCase().includes('palm')) || candidates.find(c => c.right) || candidates.find(c => c.hasHand);
      if (pick) return root.getObjectByName(pick.name);
    }

    // 如果没有 sideHint，尝试常规 hand 匹配
    const general = candidates.find(c => c.hasHand) || candidates[0];
    if (general) return root.getObjectByName(general.name);
  }

  // 3) mesh skeleton bones 中尝试找 hand
  if (detectedMeshSkeletonBones && detectedMeshSkeletonBones.length) {
    for (const arr of detectedMeshSkeletonBones) {
      for (const n of arr) {
        const ln = (n || '').toLowerCase();
        if (handKeywords.some(k => ln.includes(k))) {
          const o = root.getObjectByName(n);
          if (o) return o;
        }
      }
    }
  }

  // 4) 最后的遍历查找任何包含 hand/palm 的节点
  let found = null;
  root.traverse((c) => {
    if (!found && c.name) {
      const ln = c.name.toLowerCase();
      if (handKeywords.some(k => ln.includes(k))) found = c;
    }
  });
  if (found) return found;
  return null;
}

function getHeadLocalPosition(outVec) {
  if (!robot) return outVec.set(0, 1.2, 0);
  const headNode = robotHead || robot;
  headNode.getWorldPosition(headWorldTemp);
  headLocalTemp.copy(headWorldTemp);
  robot.worldToLocal(headLocalTemp);
  outVec.copy(headLocalTemp);
  return outVec;
}

// 构建左右手臂骨骼链（root->...->endEffector），优先使用常见命名
function buildArmChains() {
  leftArmChain = [];
  rightArmChain = [];
  if (!robot) return;
  // 常见的骨骼命名顺序（从肩到掌）
  const leftNames = ['ShoulderL','UpperArmL','LowerArmL','Palm2L','Palm1L','Palm3L'];
  const rightNames = ['ShoulderR','UpperArmR','LowerArmR','Palm2R','Palm1R','Palm3R'];
  for (const n of leftNames) {
    const o = robot.getObjectByName(n);
    if (o) leftArmChain.push(o);
  }
  for (const n of rightNames) {
    const o = robot.getObjectByName(n);
    if (o) rightArmChain.push(o);
  }
  // 如果没有找到 ShoulderL/ShoulderR，尝试通过检测的骨骼名查找最接近的链
  if (leftArmChain.length === 0 && detectedBoneNames.length) {
    const candidates = ['shoulder','upperarm','lowerarm','palm'];
    for (const key of candidates) {
      const found = detectedBoneNames.find(n => n.toLowerCase().includes(key) && (n.slice(-1) === 'L' || n.slice(-1) === 'l'));
      if (found) leftArmChain.push(robot.getObjectByName(found));
    }
  }
  if (rightArmChain.length === 0 && detectedBoneNames.length) {
    const candidates = ['shoulder','upperarm','lowerarm','palm'];
    for (const key of candidates) {
      const found = detectedBoneNames.find(n => n.toLowerCase().includes(key) && (n.slice(-1) === 'R' || n.slice(-1) === 'r'));
      if (found) rightArmChain.push(robot.getObjectByName(found));
    }
  }
  // 计算链信息（长度、rest 世界位置）
  leftArmChainInfo = buildChainInfo(leftArmChain);
  rightArmChainInfo = buildChainInfo(rightArmChain);
}

// 基于映射优先构建 IK 手臂链：
// - 若用户在映射中提供了完整的 Shoulder/UpperArm/LowerArm/Hand，则严格按映射构造链
// - 否则回退到原有的自动推断 buildArmChains()
function buildArmChainsFromMappingOrAuto() {
  leftArmChain = [];
  rightArmChain = [];

  if (!robot) {
    leftArmChainInfo = buildChainInfo([]);
    rightArmChainInfo = buildChainInfo([]);
    return;
  }

  // 检查是否有完整的四段映射（Shoulder → UpperArm → LowerArm → Hand）
  const hasLeftMapped = MAPPED_JOINTS && 
    MAPPED_JOINTS.leftShoulder && 
    MAPPED_JOINTS.leftUpperArm && 
    MAPPED_JOINTS.leftLowerArm && 
    MAPPED_JOINTS.leftHand;
  const hasRightMapped = MAPPED_JOINTS && 
    MAPPED_JOINTS.rightShoulder && 
    MAPPED_JOINTS.rightUpperArm && 
    MAPPED_JOINTS.rightLowerArm && 
    MAPPED_JOINTS.rightHand;

  // 左臂：按映射 Shoulder → UpperArm → LowerArm → Hand
  if (hasLeftMapped) {
    const shoulder = robot.getObjectByName(MAPPED_JOINTS.leftShoulder);
    const upperArm = robot.getObjectByName(MAPPED_JOINTS.leftUpperArm);
    const lowerArm = robot.getObjectByName(MAPPED_JOINTS.leftLowerArm);
    const hand = robot.getObjectByName(MAPPED_JOINTS.leftHand);
    if (shoulder && upperArm && lowerArm && hand) {
      leftArmChain = [shoulder, upperArm, lowerArm, hand];
  logger.info('[IK] Left arm chain from mapping (4 bones):', leftArmChain.map(b => b.name));
    } else {
  logger.warn('[IK] Left mapped joints not all found, fallback to auto chain', {
        shoulder: !!shoulder,
        upperArm: !!upperArm,
        lowerArm: !!lowerArm,
        hand: !!hand,
      });
    }
  }

  // 右臂：按映射 Shoulder → UpperArm → LowerArm → Hand
  if (hasRightMapped) {
    const shoulder = robot.getObjectByName(MAPPED_JOINTS.rightShoulder);
    const upperArm = robot.getObjectByName(MAPPED_JOINTS.rightUpperArm);
    const lowerArm = robot.getObjectByName(MAPPED_JOINTS.rightLowerArm);
    const hand = robot.getObjectByName(MAPPED_JOINTS.rightHand);
    if (shoulder && upperArm && lowerArm && hand) {
      rightArmChain = [shoulder, upperArm, lowerArm, hand];
  logger.info('[IK] Right arm chain from mapping:', rightArmChain.map(b => b.name));
    } else {
  logger.warn('[IK] Right mapped joints not all found, fallback to auto chain', {
        shoulder: !!shoulder,
        upperArm: !!upperArm,
        lowerArm: !!lowerArm,
        hand: !!hand,
      });
    }
  }

  // 当任一侧未能成功从映射构造时，使用原有自动推断补全
  const needAuto = leftArmChain.length === 0 || rightArmChain.length === 0;
  if (needAuto) {
  logger.info('[IK] Using auto arm chain builder for missing side(s)');
    buildArmChains();
  } else {
    leftArmChainInfo = buildChainInfo(leftArmChain);
    rightArmChainInfo = buildChainInfo(rightArmChain);
  }
}

function buildChainInfo(chain) {
  const info = { bones: chain.slice(), lengths: [], total: 0, restPositions: [] };
  if (!chain || chain.length === 0) return info;
  // world positions
  for (let i = 0; i < chain.length; i++) {
    const p = new THREE.Vector3();
    chain[i].getWorldPosition(p);
    info.restPositions.push(p);
  }
  for (let i = 0; i < chain.length - 1; i++) {
    const a = info.restPositions[i];
    const b = info.restPositions[i+1];
    const len = a.distanceTo(b);
    info.lengths.push(len);
    info.total += len;
  }
  return info;
}

function detectFingerBones() {
  fingerBonesLeft = [];
  fingerBonesRight = [];
  if (!robot) return;
  const fingerKeys = ['thumb','index','middle','ring'];
  robot.traverse((c) => {
    if (!c.name) return;
    const n = c.name;
    const ln = n.toLowerCase();
    for (const k of fingerKeys) {
      if (ln.includes(k)) {
        const last = n.slice(-1).toLowerCase();
        if (last === 'l') fingerBonesLeft.push(c);
        else if (last === 'r') fingerBonesRight.push(c);
      }
    }
  });
}

// Build short finger chains for thumb/index/middle for both sides.
function buildFingerChains() {
  leftFingerChains = {};
  rightFingerChains = {};
  if (!robot) return;
  const fingerKeys = ['thumb','index','middle'];
  const maxChainLen = 3; // 限制短链长度，避免包含 palm
  const buildFor = (bonesArr, outMap) => {
    for (const key of fingerKeys) {
      const tips = bonesArr.filter(b => b.name && b.name.toLowerCase().includes(key));
      if (!tips || tips.length === 0) continue;
      const tip = tips[0];
      // climb ancestors but limit steps and stop before palm/hand/wrist
      const chain = [];
      let cur = tip;
      while (cur && chain.length < maxChainLen) {
        chain.unshift(cur);
        const pname = cur.name || '';
        // stop climbing if parent is palm/hand/wrist or parent is root
        const parent = cur.parent;
        if (!parent) break;
        if (parent.name && /palm|hand|wrist/i.test(parent.name)) break;
        cur = parent;
      }
      // ensure we have at least 2 bones (root + tip)
      if (chain.length >= 2) {
        outMap[key] = { bones: chain, info: buildChainInfo(chain) };
      }
    }
  };
  buildFor(fingerBonesLeft, leftFingerChains);
  buildFor(fingerBonesRight, rightFingerChains);
}

function lockFingers() {
  // 保存当前旋转（备用），但默认在激活 IK 时切换为 open pose
  fingerSavedQuats = {};
  for (const b of fingerBonesLeft.concat(fingerBonesRight)) {
    if (!b || !b.name) continue;
    fingerSavedQuats[b.name] = b.quaternion.clone();
  }
  fingersLocked = true;
}

function unlockFingers() {
  fingerSavedQuats = {};
  fingersLocked = false;
}

function setFingersOpenPose() {
  // 将检测到的每个指骨设置为较为伸直的姿态（简单策略：将局部旋转置为 0 或小角度）
  for (const b of fingerBonesLeft.concat(fingerBonesRight)) {
    if (!b || !b.name) continue;
    try {
      // 保存原始四元数已在 fingerSavedQuats 中
      // 设为局部 identity（可做小幅旋转以适配模型）
      const openQuat = new THREE.Quaternion();
      // 小幅调整：将指节略向外展开（绕 X 轴负方向）
      const e = new THREE.Euler( -0.2, 0, 0, 'XYZ');
      openQuat.setFromEuler(e);
      b.quaternion.copy(openQuat);
      b.updateMatrixWorld(true);
      // 也备份这个姿态以便 render 中锁定使用
      fingerSavedQuats[b.name] = b.quaternion.clone();
    } catch (e) {
      // ignore
    }
  }
}

function createDebugHelpers() {
  if (!robot || !scene) return;
  // SkeletonHelper 显示骨骼线
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    skeletonHelper = null;
  }
  skeletonHelper = new THREE.SkeletonHelper(robot);
  skeletonHelper.visible = false;
  scene.add(skeletonHelper);

  // 创建指关节小球
  const sphereGeo = new THREE.SphereGeometry(0.02, 8, 8);
  const matL = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const matR = new THREE.MeshBasicMaterial({ color: 0x0000ff });
  // 清理旧的球
  for (const s of fingerSpheres) {
    scene.remove(s);
  }
  fingerSpheres = [];
  for (const b of fingerBonesLeft) {
    const m = new THREE.Mesh(sphereGeo, matL);
    m.visible = false;
    scene.add(m);
    fingerSpheres.push({ bone: b, mesh: m });
  }
  for (const b of fingerBonesRight) {
    const m = new THREE.Mesh(sphereGeo, matR);
    m.visible = false;
    scene.add(m);
    fingerSpheres.push({ bone: b, mesh: m });
  }
}

function toggleDebugHelpers(on) {
  if (!skeletonHelper) return;
  skeletonHelper.visible = on;
  for (const o of fingerSpheres) {
    o.mesh.visible = on;
  }
  // collider helpers
  for (const m of colliderMeshes) {
    m.visible = on;
  }
}

function toggleWireframe() {
  // 切换场景中所有 Mesh 的线框状态（保存原始以便恢复）
  scene.traverse((c) => {
    if (c.isMesh) {
      if (!meshWireframePrev.has(c.uuid)) meshWireframePrev.set(c.uuid, c.material.wireframe === true);
      c.material.wireframe = !c.material.wireframe;
    }
  });
}

// CCD-IK 求解器（操作骨骼链以让末端靠近 targetWorldPos）
function solveCCD(chain, endBone, targetWorldPos, maxIter = 12, threshold = 0.01) {
  if (!chain || chain.length === 0 || !endBone) return false;
  const tmpVec1 = new THREE.Vector3();
  const tmpVec2 = new THREE.Vector3();
  const jointWorldPos = new THREE.Vector3();
  const endWorldPos = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const qJointWorld = new THREE.Quaternion();
  const qParentWorld = new THREE.Quaternion();
  const qRot = new THREE.Quaternion();

  endBone.getWorldPosition(endWorldPos);
  if (endWorldPos.distanceTo(targetWorldPos) < threshold) return true;

  const maxAngle = Math.PI / 3; // 每步允许的最大旋转（60度），用来稳定收敛并避免剧烈翻转
  for (let iter = 0; iter < maxIter; iter++) {
    // 从靠近末端的关节向根部遍历
    for (let i = chain.length - 1; i >= 0; i--) {
      const joint = chain[i];
      if (!joint) continue;
      joint.getWorldPosition(jointWorldPos);
      endBone.getWorldPosition(endWorldPos);
      tmpVec1.subVectors(endWorldPos, jointWorldPos); // current effector vector
      tmpVec2.subVectors(targetWorldPos, jointWorldPos); // desired vector
      const len1 = tmpVec1.length();
      const len2 = tmpVec2.length();
      if (len1 < 1e-6 || len2 < 1e-6) continue;
      tmpVec1.normalize();
      tmpVec2.normalize();
      const dot = THREE.MathUtils.clamp(tmpVec1.dot(tmpVec2), -1, 1);
      let angle = Math.acos(dot);
      if (angle < 1e-3) continue;
      axis.crossVectors(tmpVec1, tmpVec2).normalize();
      if (axis.length() < 1e-6) continue;
      // 限制单次旋转角度以保持稳定
      const angleClamp = Math.min(angle, maxAngle);
      qRot.setFromAxisAngle(axis, angleClamp);
      // world rotations
      joint.getWorldQuaternion(qJointWorld);
      const parent = joint.parent || robot;
      parent.getWorldQuaternion(qParentWorld);
  // new world quat = qRot * jointWorldQuat
  const newWorldQuat = qRot.multiply(qJointWorld.clone());
  // convert back to local by parent inverse
  const localQuat = qParentWorld.clone().invert().multiply(newWorldQuat);
      // 根据关节类型决定是否强制覆盖（upper/lower arm/shoulder 使用强覆盖以避免被手指/掌的动画抵消）
      const jn = joint.name || '';
      let slerpFactor = 0.6;
      if (/shoulder|upperarm|lowerarm/i.test(jn)) slerpFactor = 1.0; // 强制覆盖上/前臂旋转
      // 将 localQuat 转为 Euler 并应用全局角度限制（若匹配 jointLimits）
      try {
        const localEuler = new THREE.Euler().setFromQuaternion(localQuat, 'XYZ');
        for (const rule of jointLimits) {
          if (rule.test.test(jn)) {
            localEuler.x = THREE.MathUtils.clamp(localEuler.x, rule.min[0], rule.max[0]);
            localEuler.y = THREE.MathUtils.clamp(localEuler.y, rule.min[1], rule.max[1]);
            localEuler.z = THREE.MathUtils.clamp(localEuler.z, rule.min[2], rule.max[2]);
          }
        }
        const clampedQuat = new THREE.Quaternion().setFromEuler(localEuler);
        joint.quaternion.slerp(clampedQuat, slerpFactor);
      } catch (e) {
        joint.quaternion.slerp(localQuat, slerpFactor);
      }
      joint.updateMatrixWorld(true);
      endBone.getWorldPosition(endWorldPos);
      if (endWorldPos.distanceTo(targetWorldPos) < threshold) return true;
    }
  }
  // final check
  endBone.getWorldPosition(endWorldPos);
  return endWorldPos.distanceTo(targetWorldPos) < threshold;
}

// FABRIK solver: modifies rotations of bones in chain so end reaches targetWorldPos
function solveFABRIK(chainInfo, targetWorldPos, maxIter = 10, threshold = 0.02) {
  if (!chainInfo || !chainInfo.bones || chainInfo.bones.length < 2) return false;
  const bones = chainInfo.bones;
  const n = bones.length;
  // positions in world space
  const positions = [];
  for (let i = 0; i < n; i++) {
    const p = new THREE.Vector3();
    bones[i].getWorldPosition(p);
    positions.push(p);
  }
  // lengths
  const lengths = chainInfo.lengths && chainInfo.lengths.length ? chainInfo.lengths.slice() : [];
  const totalLength = lengths.reduce((a,b)=>a+b,0);
  const target = targetWorldPos.clone();

  const rootPos = positions[0].clone();
  if (rootPos.distanceTo(target) > totalLength) {
    // stretch towards target
    for (let i = 0; i < n - 1; i++) {
      const r = target.clone().sub(positions[i]).normalize();
      positions[i+1] = positions[i].clone().add(r.multiplyScalar(lengths[i]));
    }
  } else {
    // iterative FABRIK
    let iter = 0;
    const newPos = positions.map(p=>p.clone());
    while (iter < maxIter) {
      // forward
      newPos[n-1] = target.clone();
      for (let i = n - 2; i >= 0; i--) {
        const dir = newPos[i].clone().sub(newPos[i+1]).normalize();
        newPos[i] = newPos[i+1].clone().add(dir.multiplyScalar(lengths[i]));
      }
      // backward
      newPos[0] = rootPos.clone();
      for (let i = 0; i < n -1; i++) {
        const dir = newPos[i+1].clone().sub(newPos[i]).normalize();
        newPos[i+1] = newPos[i].clone().add(dir.multiplyScalar(lengths[i]));
      }
      if (newPos[n-1].distanceTo(target) <= threshold) break;
      iter++;
    }
    // assign newPos to positions
    for (let i = 0; i < n; i++) positions[i].copy(newPos[i]);
  }

  // Now convert position changes into joint rotations
  for (let i = 0; i < n - 1; i++) {
    const joint = bones[i];
    const childPos = positions[i+1];
    const jointPos = positions[i];
    const desiredDir = childPos.clone().sub(jointPos).normalize();

    // current world direction from joint to child
    const curChildWorld = new THREE.Vector3();
    bones[i+1].getWorldPosition(curChildWorld);
    const curDir = curChildWorld.clone().sub(jointPos).normalize();
    if (curDir.length() < 1e-6 || desiredDir.length() < 1e-6) continue;
    const dot = THREE.MathUtils.clamp(curDir.dot(desiredDir), -1, 1);
    const angle = Math.acos(dot);
    if (angle < 1e-3) continue;
    const axis = new THREE.Vector3().crossVectors(curDir, desiredDir).normalize();

    // apply rotation in world space then convert to local
    const qJointWorld = new THREE.Quaternion();
    joint.getWorldQuaternion(qJointWorld);
    const newWorldQuat = qRot.multiply(qJointWorld.clone());
    const parent = joint.parent || robot;
    const qParentWorld = new THREE.Quaternion();
    parent.getWorldQuaternion(qParentWorld);
    const localQuat = qParentWorld.clone().invert().multiply(newWorldQuat);
    // apply with slerp or immediate depending on joint
    const jn = joint.name || '';
    // Avoid strong rotations on palm/hand/wrist bones which tend to deform the mesh
    // for many rigs. For those, either skip or apply a very small slerp so the
    // palm orientation remains mostly driven by the model bind pose/animation.
    let slerpFactor = 0.6;
    if (/shoulder|upperarm|lowerarm/i.test(jn)) slerpFactor = 1.0;
    if (/palm|hand|wrist/i.test(jn)) slerpFactor = 0.12; // very soft influence on palms
    try {
      // Respect joint limits if applicable (same as CCD branch)
      const localEuler = new THREE.Euler().setFromQuaternion(localQuat, 'XYZ');
      for (const rule of jointLimits) {
        if (rule.test.test(jn)) {
          localEuler.x = THREE.MathUtils.clamp(localEuler.x, rule.min[0], rule.max[0]);
          localEuler.y = THREE.MathUtils.clamp(localEuler.y, rule.min[1], rule.max[1]);
          localEuler.z = THREE.MathUtils.clamp(localEuler.z, rule.min[2], rule.max[2]);
        }
      }
      const clampedQuat = new THREE.Quaternion().setFromEuler(localEuler);
      joint.quaternion.slerp(clampedQuat, slerpFactor);
    } catch (e) {
      joint.quaternion.slerp(localQuat, slerpFactor);
    }
    joint.updateMatrixWorld(true);
  }
  // final check
  const endPos = new THREE.Vector3();
  bones[n-1].getWorldPosition(endPos);
  return endPos.distanceTo(target) < Math.max(threshold, 0.01);
}

// Apply short finger IK for per-finger chains (thumb/index/middle)
const FINGER_TARGET_OFFSETS = {
  thumb: new THREE.Vector3(0.04, -0.02, 0.06),
  index: new THREE.Vector3(0.02, 0.02, 0.08),
  middle: new THREE.Vector3(0, 0.03, 0.09)
};

function applyFingerIKForSide(fingerChainsMap, activeController) {
  if (!fingerChainsMap || !activeController) return;
  // Get palm reference (try Palm2 or Palm1)
  const palm = robot.getObjectByName(LEFT_HAND_NAME) || robot.getObjectByName(RIGHT_HAND_NAME);
  // If above fails, try to find any palm bone in robot
  let palmRef = null;
  for (const k in fingerChainsMap) {
    const c = fingerChainsMap[k];
    if (c && c.bones && c.bones.length) {
      const p = c.bones.find(b => /palm|hand|wrist/i.test(b.name));
      if (p) { palmRef = p; break; }
    }
  }
  if (!palmRef) {
    palmRef = palm || robot;
  }
  const palmPos = new THREE.Vector3();
  const palmQuat = new THREE.Quaternion();
  palmRef.getWorldPosition(palmPos);
  palmRef.getWorldQuaternion(palmQuat);

  for (const fname in fingerChainsMap) {
    try {
      const entry = fingerChainsMap[fname];
      if (!entry || !entry.bones || entry.bones.length < 2) continue;
      // Compute desired fingertip target in world space using palm-local offset
      const offset = FINGER_TARGET_OFFSETS[fname] ? FINGER_TARGET_OFFSETS[fname].clone() : new THREE.Vector3(0,0,0.06);
      offset.applyQuaternion(palmQuat);
      const target = palmPos.clone().add(offset);
      // small gating: only IK if controller is reasonably close to palm or if fingertip far from target
      const ctrlPos = new THREE.Vector3();
      activeController.getWorldPosition(ctrlPos);
      const distCtrlPalm = ctrlPos.distanceTo(palmPos);
      const tipWorld = new THREE.Vector3();
      const tip = entry.bones[entry.bones.length - 1];
      tip.getWorldPosition(tipWorld);
      const distTipTarget = tipWorld.distanceTo(target);
      if (distCtrlPalm < 0.45 || distTipTarget > 0.02) {
        // refine target slightly toward controller when controller is close
        if (distCtrlPalm < 0.25) {
          // move target toward the controller a bit
          const dir = ctrlPos.clone().sub(palmPos).normalize();
          target.copy(palmPos).add(dir.multiplyScalar(0.06));
        }
        // run FABRIK on short finger chain
        // rebuild info in case arm IK changed world positions
        entry.info = buildChainInfo(entry.bones);
        // constrain target to be within reachable distance (total length)
        const totalLen = entry.info.total || 0.0;
        const tipPos = new THREE.Vector3();
        entry.bones[0].getWorldPosition(tipPos);
        // if target too far from chain root, bring it closer
        const rootPos = entry.info.restPositions && entry.info.restPositions[0] ? entry.info.restPositions[0].clone() : entry.bones[0].getWorldPosition(new THREE.Vector3()) && entry.bones[0].getWorldPosition(new THREE.Vector3());
        const rootWorld = new THREE.Vector3(); entry.bones[0].getWorldPosition(rootWorld);
        const toTarget = target.clone().sub(rootWorld);
        if (toTarget.length() > totalLen * 1.05) {
          toTarget.setLength(totalLen * 1.05);
          target.copy(rootWorld).add(toTarget);
        }
        solveFABRIK(entry.info, target, 6, 0.008);
      }
    } catch (e) { /* ignore per-finger errors */ }
  }
}

// Initialize simple body colliders (spheres) using major torso bones if present
function initBodyColliders() {
  bodyColliders = [];
  if (!robot) return;
  colliderMeshes.forEach(m => { try { scene.remove(m); } catch(e){} });
  colliderMeshes = [];
  
  // Simple approach: create a few large static spheres at known torso heights
  // relative to robot root, not bones (bones are unreliable)
  const robotPos = new THREE.Vector3();
  robot.getWorldPosition(robotPos);
  
  // Define colliders at fixed heights relative to robot base
  const colliderDefs = [
    { yOffset: 0.2, radius: 0.28, color: 0xff2222 },  // lower hips
    { yOffset: 0.4, radius: 0.38, color: 0xff4444 },  // lower belly
    { yOffset: 0.6, radius: 0.50, color: 0xff6644 },  // mid belly (LARGEST)
    { yOffset: 0.8, radius: 0.46, color: 0xff8844 },  // upper belly
    { yOffset: 1.0, radius: 0.40, color: 0xffaa44 },  // lower chest
    { yOffset: 1.2, radius: 0.32, color: 0xffcc44 }   // upper chest
  ];
  
  for (const def of colliderDefs) {
    const center = robotPos.clone().add(new THREE.Vector3(0, def.yOffset, 0));
    
    bodyColliders.push({
      yOffset: def.yOffset,  // store offset for refresh
      radius: def.radius,
      center: center.clone()
    });
    
    // Visual helper
    const geo = new THREE.SphereGeometry(def.radius, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ 
      color: def.color, 
      transparent: true, 
      opacity: 0.4,
      wireframe: false 
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(center);
    mesh.visible = showDebugHelpers;
    scene.add(mesh);
    colliderMeshes.push(mesh);
  }
  
  logger.info('[COLLIDER] created', bodyColliders.length, 'simple colliders at robot position');
}

// Refresh body collider world centers so they follow robot movement and bone animations
function refreshBodyColliders() {
  if (!bodyColliders || bodyColliders.length === 0 || !robot) return;
  
  const robotPos = new THREE.Vector3();
  robot.getWorldPosition(robotPos);
  
  for (let i = 0; i < bodyColliders.length; i++) {
    const c = bodyColliders[i];
    if (typeof c.yOffset === 'number') {
      // Update center based on current robot position + offset
      const newCenter = robotPos.clone().add(new THREE.Vector3(0, c.yOffset, 0));
      c.center = newCenter;
      
      // Update visual mesh
      const mesh = colliderMeshes[i];
      if (mesh) {
        mesh.position.copy(newCenter);
      }
    }
  }
}

// If target is inside any collider, push it out along vector from collider center
function pushTargetOutOfColliders(targetWorldPos, margin = 0.04) {
  // ensure colliders are refreshed to current world positions (robot may move/animate)
  refreshBodyColliders();
  if (!bodyColliders || bodyColliders.length === 0) return targetWorldPos.clone();
  let adjusted = targetWorldPos.clone();
  let pushed = false;
  let maxAdjust = 0;
  let best = adjusted.clone();
  for (const c of bodyColliders) {
    if (!c.center) continue;
    const v = adjusted.clone().sub(c.center);
    const d = v.length();
    if (d < c.radius + margin) {
      pushed = true;
      const dir = d > 1e-6 ? v.normalize() : new THREE.Vector3(0,1,0);
      const candidate = c.center.clone().add(dir.multiplyScalar(c.radius + margin));
      const adjustDist = candidate.distanceTo(adjusted);
      if (adjustDist > maxAdjust) {
        maxAdjust = adjustDist;
        best.copy(candidate);
      }
    }
  }
  if (pushed) {
  if (showDebugHelpers) logger.debug('[COLLIDE] target pushed out of collider by', maxAdjust.toFixed(3), 'm');
    return best;
  }
  return adjusted;
}

function onControllerConnected(event) {
    const handed = event.data && event.data.handedness;
    showDebug(`✓ ${handed === 'left' ? '左' : '右'}手柄已连接`);
  logger.info(`控制器 ${handed} 已连接`);
    if (!handed || !event.target) return;
    const controller = event.target;
    controller.userData = controller.userData || {};
    controller.userData.handedness = handed;
    controllersByHand[handed] = controller;
    if (controller === controller1) {
      controller1Hand = handed;
    } else if (controller === controller2) {
      controller2Hand = handed;
    }
    showDebug(`[Controller] ${handed} connected (threeIdx=${controller === controller1 ? 0 : controller === controller2 ? 1 : 'dynamic'})`, true);
}

// 根据 handedness 可靠获取对应的 three.js Controller 对象
function getControllerByHand(hand) {
  const candidates = [
    controllersByHand.left,
    controllersByHand.right,
    controller1,
    controller2
  ];
  for (const c of candidates) {
    if (c && c.userData && c.userData.handedness === hand) {
      controllersByHand[hand] = c;
      return c;
    }
  }

  if (hand === 'left' && controller1 && (controller1Hand === 'left')) {
    controller1.userData = controller1.userData || {};
    controller1.userData.handedness = 'left';
    controllersByHand.left = controller1;
    return controller1;
  }
  if (hand === 'right' && controller2 && (controller2Hand === 'right')) {
    controller2.userData = controller2.userData || {};
    controller2.userData.handedness = 'right';
    controllersByHand.right = controller2;
    return controller2;
  }

  try {
    const session = renderer && renderer.xr && renderer.xr.getSession ? renderer.xr.getSession() : null;
    if (session) {
      const inputSources = session.inputSources || [];
      for (let i = 0; i < inputSources.length; i++) {
        const src = inputSources[i];
        if (!src || !src.handedness || src.handedness !== hand) continue;
        if (!renderer || !renderer.xr) continue;
        const controllerRef = renderer.xr.getController(i);
        if (controllerRef) {
          controllerRef.userData = controllerRef.userData || {};
          controllerRef.userData.handedness = hand;
          controllersByHand[hand] = controllerRef;
          return controllerRef;
        }
      }
    }
  } catch (_) {}

  return null;
}

// 读取左手柄摇杆输入（用于控制机器人移动）
function updateJoystickInput() {
  if (!controller1) {
    return; // 静默等待控制器初始化，不显示错误
  }
  
  // WebXR方式：通过XRSession获取输入源
  const session = renderer.xr.getSession();
  if (!session) {
    return; // 静默等待会话激活，不显示错误（这在VR启动初期很正常）
  }
  
  // 获取所有输入源
  const inputSources = session.inputSources;
  if (!inputSources || inputSources.length === 0) {
    showDebug('[摇杆] 等待输入源...');
    return;
  }
  
  showDebug(`[调试] 找到${inputSources.length}个输入源`, true);
  
  let leftInputSource = null;
  
  // 查找左手输入源
  for (let source of inputSources) {
    showDebug(`[调试] 输入源: hand=${source.handedness} hasGamepad=${!!source.gamepad}`, true);
    
    if (source.handedness === 'left' && source.gamepad) {
      leftInputSource = source;
      showDebug(`✓ 找到左手输入源，axes数量:${source.gamepad.axes.length}`);
      break;
    }
  }
  
  if (!leftInputSource || !leftInputSource.gamepad) {
    showDebug('[摇杆] 左手输入源无gamepad');
    return;
  }
  
  const gamepad = leftInputSource.gamepad;
  if (gamepad && gamepad.axes && gamepad.axes.length >= 2) {
    // HTC Vive Focus 3: 摇杆轴通常是 axes[0]=X, axes[1]=Y
    // 但也可能是 axes[2], axes[3]，所以显示所有轴
    const xAxis = gamepad.axes[2] || 0;
    const yAxis = gamepad.axes[3] || 0;
    
    // 应用死区
    leftJoystickAxes.x = Math.abs(xAxis) > 0.15 ? xAxis : 0;
    leftJoystickAxes.y = Math.abs(yAxis) > 0.15 ? yAxis : 0;
    
    // 调试：总是显示所有axes（推动摇杆时能看到哪个索引在变化）
    const axesStr = gamepad.axes.map((a, i) => `[${i}]:${a.toFixed(2)}`).join(' ');
    showDebug(`[摇杆轴] ${axesStr}`, true); // 允许重复显示以实时更新
    
    // 如果检测到输入，额外提示
    if (Math.abs(leftJoystickAxes.x) > 0.01 || Math.abs(leftJoystickAxes.y) > 0.01) {
      showDebug(`→ 已触发 x:${leftJoystickAxes.x.toFixed(2)} y:${leftJoystickAxes.y.toFixed(2)}`, true);
    }
  } else {
    showDebug('[摇杆] gamepad.axes未找到或长度不足');
  }
}

// 每帧读取 XR 按钮状态（当前用于检测握持键触发记录，亦可扩展其他按键逻辑）
function updateXRButtons() {
  if (recordingManager && typeof recordingManager.update === 'function') {
    recordingManager.update();
  }
}

// 根据摇杆输入更新机器人位置和朝向
function updateRobotLocomotion(delta) {
  if (!robot) return;
  
  // 摇杆输入：x=左右，y=前后（前推是正值）
  const moveX = -leftJoystickAxes.x; // 取反：右推应该向右走
  const moveZ = -leftJoystickAxes.y; // 取反：前推(正值)应该是-Z方向
  
  if (Math.abs(moveX) > 0.01 || Math.abs(moveZ) > 0.01) {
    // === 第一步：计算目标朝向（世界坐标系，固定不变） ===
    // 摇杆指示的世界坐标角度（不考虑用户视角）
    const inputAngleWorld = Math.atan2(moveX, moveZ);
    
    // 机器人应该面向的目标角度
    // 因为机器人初始rotation.y = Math.PI（旋转180°才背对用户），
    // 要让机器人朝向摇杆方向，需要加上这个偏移
    const targetRotation = inputAngleWorld + Math.PI;
    
    const robotCurrentAngle = robot.rotation.y;
    
    // 计算需要旋转的角度差（选择最短路径）
    let rotDiff = targetRotation - robotCurrentAngle;
    while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
    while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
    
    const angleDiffDegrees = Math.abs(rotDiff * 180 / Math.PI);
    
    showDebug(`[移动] 摇杆x:${moveX.toFixed(2)} y:${moveZ.toFixed(2)} | 角度差:${angleDiffDegrees.toFixed(0)}°`, true);
    
    // === 第二步：判断是"转身"还是"行走" ===
    const TURN_THRESHOLD = 15; // 角度差大于15度时，原地转身（不前进）
    const isNeedTurning = angleDiffDegrees > TURN_THRESHOLD;
    
    if (isNeedTurning) {
      // 【原地转身模式】：播放原地踏步动画，不移动位置
      showDebug(`→ 原地转身中... (差${angleDiffDegrees.toFixed(0)}°)`, true);
      
      // 平滑旋转
      const rotStep = ROBOT_TURN_SPEED * delta;
      if (Math.abs(rotDiff) < rotStep) {
        robot.rotation.y = targetRotation;
      } else {
        robot.rotation.y += Math.sign(rotDiff) * rotStep;
      }
      
      // 播放走路动画（原地踏步效果）
      if (walkAction && !walkAction.isRunning()) {
        if (idleAction) idleAction.stop();
        walkAction.play();
      }
      
    } else {
      // 【行走模式】：朝向基本正确，可以前进
      showDebug(`→ 前进中`, true);
      
      // 微调朝向（边走边调整）
      const rotStep = ROBOT_TURN_SPEED * delta * 0.3; // 转向速度降低，更平滑
      if (Math.abs(rotDiff) > 0.01) {
        robot.rotation.y += Math.sign(rotDiff) * Math.min(rotStep, Math.abs(rotDiff));
      }
      
      // 移动机器人（沿自身朝向前进）
      // 因为机器人初始rotation.y = Math.PI（模型正面旋转180°后朝向-Z），
      // 模型的"背面"(0,0,1)旋转后实际指向前方
      const forward = new THREE.Vector3(0, 0, 1);
      forward.applyQuaternion(robot.quaternion);
      forward.y = 0;
      forward.normalize();
      
      const moveSpeed = ROBOT_WALK_SPEED * Math.sqrt(moveX * moveX + moveZ * moveZ);
      robot.position.add(forward.multiplyScalar(moveSpeed * delta));
      
      // 播放走路动画
      if (walkAction && !walkAction.isRunning()) {
        if (idleAction) idleAction.stop();
        walkAction.play();
      }
    }
    
    // 播放走路动画
    if (walkAction && !walkAction.isRunning()) {
      if (idleAction) idleAction.stop();
      walkAction.play();
    }
  } else {
    // 无输入 - 播放待机动画
    if (idleAction && !idleAction.isRunning()) {
      if (walkAction) walkAction.stop();
      idleAction.play();
    }
  }
}

// 简单的两关节IK（大臂+小臂），避免使用FABRIK防止网格变形
// 参数说明：
// - shoulder: 实际是 UpperArm（大臂），控制肩关节旋转
// - elbow: 实际是 LowerArm（小臂/前臂），控制肘关节弯曲
// - hand: 手掌/手腕骨骼，作为 IK 的目标末端
// - targetPos: 目标世界坐标位置
let _lastIKLogTime = 0;
function simpleTwoJointIK(shoulder, elbow, hand, targetPos) {
  if (!shoulder || !elbow || !hand) return false;
  
  // 获取世界位置
  const shoulderPos = new THREE.Vector3();
  shoulder.getWorldPosition(shoulderPos);
  const elbowPos = new THREE.Vector3();
  elbow.getWorldPosition(elbowPos);
  const handPos = new THREE.Vector3();
  hand.getWorldPosition(handPos);
  
  // 计算骨骼长度
  const upperArmLen = shoulderPos.distanceTo(elbowPos);
  const lowerArmLen = elbowPos.distanceTo(handPos);
  const totalLen = upperArmLen + lowerArmLen;
  
  // 如果骨骼长度无效，跳过
  if (upperArmLen < 0.001 || lowerArmLen < 0.001) return false;
  
  // 从肩膀到目标的向量和距离
  const toTarget = targetPos.clone().sub(shoulderPos);
  let targetDist = toTarget.length();
  
  // 限制目标距离在可达范围内
  const maxReach = (upperArmLen + lowerArmLen) * 0.999; // 稍微小于最大以避免数值问题
  const minReach = Math.abs(upperArmLen - lowerArmLen) * 1.001; // 稍微大于最小
  
  const wasClampedMax = targetDist > maxReach;
  const wasClampedMin = targetDist < minReach;
  
  if (targetDist > maxReach) {
    targetDist = maxReach;
    toTarget.setLength(targetDist);
  }
  if (targetDist < minReach) {
    targetDist = minReach;
    toTarget.setLength(targetDist);
  }
  
  // === 使用余弦定理计算肘部弯曲角度 ===
  // 三角形：肩膀 - 肘部 - 手掌，已知三边长度
  // a = lowerArmLen (肘到手)
  // b = upperArmLen (肩到肘)  
  // c = targetDist (肩到目标/手)
  // 用余弦定理求肘部内角
  const a = lowerArmLen;
  const b = upperArmLen;
  const c = targetDist;
  
  // cos(肘部角) = (a² + b² - c²) / (2ab)
  let cosElbowAngle = (a * a + b * b - c * c) / (2 * a * b);
  cosElbowAngle = THREE.MathUtils.clamp(cosElbowAngle, -1, 1);
  const elbowAngle = Math.acos(cosElbowAngle); // 肘部内角（弯曲程度）
  
  // cos(肩部角) = (b² + c² - a²) / (2bc)  
  let cosShoulderAngle = (b * b + c * c - a * a) / (2 * b * c);
  cosShoulderAngle = THREE.MathUtils.clamp(cosShoulderAngle, -1, 1);
  const shoulderAngle = Math.acos(cosShoulderAngle); // 肩膀处上臂与目标方向的夹角

  // === 调试输出 ===
  const now = performance.now();
  if (now - _lastIKLogTime > 2000) { // 每2秒输出一次
    _lastIKLogTime = now;
    const elbowAngleDeg = (elbowAngle * 180 / Math.PI).toFixed(1);
    const shoulderAngleDeg = (shoulderAngle * 180 / Math.PI).toFixed(1);
  logger.debug(`[IK调试] 骨骼: ${shoulder.name} → ${elbow.name} → ${hand.name}`);
  logger.debug(`[IK调试] 大臂长=${b.toFixed(3)}m, 小臂长=${a.toFixed(3)}m, 总长=${totalLen.toFixed(3)}m`);
  logger.debug(`[IK调试] 目标距离=${c.toFixed(3)}m, 最大可达=${maxReach.toFixed(3)}m`);
  logger.debug(`[IK调试] 距离被限制: ${wasClampedMax ? '超出最大' : wasClampedMin ? '小于最小' : '正常范围'}`);
  logger.debug(`[IK调试] 计算角度: 肘部内角=${elbowAngleDeg}°, 肩部角=${shoulderAngleDeg}°`);
  logger.debug(`[IK调试] 肘部弯曲程度: ${(180 - parseFloat(elbowAngleDeg)).toFixed(1)}° (180°=伸直, 0°=完全折叠)`);
  logger.debug('---');
  }

  // === 第一步：旋转肩膀（大臂）===
  // 目标方向
  const targetDir = toTarget.clone().normalize();
  
  // 计算肘部应该在的位置（需要考虑弯曲方向）
  // 使用一个"肘部提示向量"来确定弯曲平面，通常肘部向后/向外弯曲
  // 这里使用一个简单的策略：肘部倾向于向后下方弯曲
  const worldUp = new THREE.Vector3(0, 1, 0);
  let bendAxis = new THREE.Vector3().crossVectors(targetDir, worldUp);
  if (bendAxis.length() < 0.001) {
    // 如果目标方向与上方平行，使用前向作为弯曲轴
    bendAxis.set(0, 0, 1);
  }
  bendAxis.normalize();
  
  // 从目标方向旋转 shoulderAngle 得到上臂方向
  const upperArmDir = targetDir.clone();
  const shoulderRotQuat = new THREE.Quaternion().setFromAxisAngle(bendAxis, shoulderAngle);
  upperArmDir.applyQuaternion(shoulderRotQuat);
  
  // 计算肘部目标位置
  const elbowTargetPos = shoulderPos.clone().add(upperArmDir.multiplyScalar(upperArmLen));
  
  // 旋转肩膀使上臂指向肘部目标位置
  const currentUpperArmDir = elbowPos.clone().sub(shoulderPos).normalize();
  const newUpperArmDir = elbowTargetPos.clone().sub(shoulderPos).normalize();
  
  const shoulderRotAxis = new THREE.Vector3().crossVectors(currentUpperArmDir, newUpperArmDir);
  if (shoulderRotAxis.length() > 0.0001) {
    shoulderRotAxis.normalize();
    const shoulderRotAngle = Math.acos(THREE.MathUtils.clamp(currentUpperArmDir.dot(newUpperArmDir), -1, 1));
    
    const rot = new THREE.Quaternion().setFromAxisAngle(shoulderRotAxis, shoulderRotAngle);
    const shoulderWorldQuat = new THREE.Quaternion();
    shoulder.getWorldQuaternion(shoulderWorldQuat);
    const newWorldQuat = rot.multiply(shoulderWorldQuat);
    
    const parent = shoulder.parent || robot;
    const parentWorldQuat = new THREE.Quaternion();
    parent.getWorldQuaternion(parentWorldQuat);
    const localQuat = parentWorldQuat.clone().invert().multiply(newWorldQuat);
    
    shoulder.quaternion.copy(localQuat);
    shoulder.updateMatrixWorld(true);
  }
  
  // === 第二步：旋转肘部（小臂）===
  // 重新获取更新后的位置
  elbow.getWorldPosition(elbowPos);
  hand.getWorldPosition(handPos);
  
  // 小臂当前方向和目标方向
  const currentLowerArmDir = handPos.clone().sub(elbowPos).normalize();
  const targetLowerArmDir = targetPos.clone().sub(elbowPos).normalize();
  
  const elbowRotAxis = new THREE.Vector3().crossVectors(currentLowerArmDir, targetLowerArmDir);
  if (elbowRotAxis.length() > 0.0001) {
    elbowRotAxis.normalize();
    const elbowRotAngle = Math.acos(THREE.MathUtils.clamp(currentLowerArmDir.dot(targetLowerArmDir), -1, 1));
    
    const elbowRot = new THREE.Quaternion().setFromAxisAngle(elbowRotAxis, elbowRotAngle);
    const elbowWorldQuat = new THREE.Quaternion();
    elbow.getWorldQuaternion(elbowWorldQuat);
    const newElbowWorldQuat = elbowRot.multiply(elbowWorldQuat);
    
    const elbowParent = elbow.parent || shoulder;
    const elbowParentWorldQuat = new THREE.Quaternion();
    elbowParent.getWorldQuaternion(elbowParentWorldQuat);
    const elbowLocalQuat = elbowParentWorldQuat.clone().invert().multiply(newElbowWorldQuat);
    
    elbow.quaternion.copy(elbowLocalQuat);
    elbow.updateMatrixWorld(true);
  }
  
  return true;
}

// 左手柄扳机按下时，左手跟随手柄移动（镜像映射模式）
function handleLeftHandFollow() {
  if (!robot || !mirroringActive) return;
  
  const leftHandJoint = findBone(robot, LEFT_HAND_NAME, 'left');
  if (!leftHandJoint) {
  logger.warn('[WARN] left hand joint not found');
    return;
  }
  // 仅使用“左手”控制器
  const activeController = (renderer && renderer.xr && renderer.xr.isPresenting) ? getControllerByHand('left') : null;
  if (!activeController) return;
  if (activeController.userData && activeController.userData.handedness && activeController.userData.handedness !== 'left') {
    return;
  }
  activeController.updateMatrixWorld(true);
  
  // 校准后持续跟随，不在此处做初始化
  
  // === 第二步：计算手柄的相对变化（用户参照系 -> 机器人本地） ===
  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);
  const ctrlWorld = new THREE.Vector3();
  activeController.getWorldPosition(ctrlWorld);
  const currentOffsetWorld = ctrlWorld.sub(camPos);
  // 转到用户参照系（相机初始朝向）下
  const currentLocalUser = currentOffsetWorld.clone().applyQuaternion(invCameraInitialQuat);
  const baseDeltaUser = currentLocalUser.sub(leftControllerInitialLocalUser);
  // 若该控制器几乎未移动，避免对另一只手造成“类似运动”的错觉
  if (baseDeltaUser.lengthSq() < 1e-4) return;
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  // 增益（含上举增强）
  const yGain = baseDeltaUser.y > Y_UP_THRESHOLD ? (FOLLOW_GAIN.y * Y_UP_BOOST) : FOLLOW_GAIN.y;
  const deltaUserGained = new THREE.Vector3(
    baseDeltaUser.x * FOLLOW_GAIN.x,
    baseDeltaUser.y * yGain,
    baseDeltaUser.z * FOLLOW_GAIN.z
  );
  // 用户参照系 -> 世界
  const deltaWorld = deltaUserGained.clone().applyQuaternion(cameraInitialQuat);
  // 世界 -> 机器人本地
  const robotInv = robot.quaternion.clone().invert();
  const deltaRobotLocal = deltaWorld.clone().applyQuaternion(robotInv);
  // RobotExpressive 在加载时旋转了 180°（面向 -Z），需要翻转本地 Z 轴以保持“向前”一致
  deltaRobotLocal.z *= -1;
  
  // 根据机器人手臂长度与人类手臂长度的比例缩放用户位移
  // 这样用户的小幅移动在大机器人上也能产生相应幅度的移动
  const robotArmLen = leftArmChainInfo?.total || HUMAN_ARM_LENGTH;
  const scaleRatio = robotArmLen / HUMAN_ARM_LENGTH;
  deltaRobotLocal.multiplyScalar(scaleRatio);
  
  if (now - lastLeftLogTime > 1000) {
  logger.debug(`[左手] 用户偏移: x=${baseDeltaUser.x.toFixed(3)}, y=${baseDeltaUser.y.toFixed(3)}, z=${baseDeltaUser.z.toFixed(3)}`);
  logger.debug(`[左手] 机器人本地偏移: x=${deltaRobotLocal.x.toFixed(3)}, y=${deltaRobotLocal.y.toFixed(3)}, z=${deltaRobotLocal.z.toFixed(3)}`);
  logger.debug(`[左手] 手臂长度缩放: robotArmLen=${robotArmLen.toFixed(3)}, scaleRatio=${scaleRatio.toFixed(3)}`);
    lastLeftLogTime = now;
  }
  
  const headLocalCurrent = getHeadLocalPosition(new THREE.Vector3());
  const baseLocal = headLocalCurrent.clone().add(leftHandOffsetFromHeadLocal);
  const targetLocal = baseLocal.add(deltaRobotLocal);
  // 转回世界作为 IK 目标
  const targetHandPos = targetLocal.clone();
  robot.localToWorld(targetHandPos);
  
  // 碰撞推出
  // 头顶区域更不容易与躯干相撞，向上举时可适当降低碰撞余量以减少“被顶回去”的感觉
  const upward = targetHandPos.y > (cameraInitialPos.y + 0.2);
  const adjustedTarget = pushTargetOutOfColliders(targetHandPos, upward ? 0.05 : 0.08);
  
  // 使用简单IK（只旋转肩膀和肘部）
  // 骨骼链结构：[0]=Shoulder(锁骨), [1]=UpperArm(大臂), [2]=LowerArm(小臂), [3]=Hand(手掌)
  // IK 需要：UpperArm(肩部旋转), LowerArm(肘部弯曲), Hand(末端目标)
  if (leftArmChain && leftArmChain.length >= 4) {
    const shoulder = leftArmChain[1]; // UpperArmL - 大臂，控制肩部旋转
    const elbow = leftArmChain[2];    // LowerArmL - 小臂，控制肘部弯曲
    const hand = leftArmChain[3];     // Hand - 手掌，IK 目标末端
    if (now - lastLeftLogTime > 1000) {
  logger.info('[IK-L] 4-bone chain, using [1,2,3]:', shoulder?.name, elbow?.name, hand?.name);
    }
    simpleTwoJointIK(shoulder, elbow, hand, adjustedTarget);
  } else if (leftArmChain && leftArmChain.length === 3) {
    // 兼容没有 Shoulder 的 3 段链：UpperArm, LowerArm, Hand
    const shoulder = leftArmChain[0];
    const elbow = leftArmChain[1];
    const hand = leftArmChain[2];
    if (now - lastLeftLogTime > 1000) {
  logger.info('[IK-L] 3-bone chain, using [0,1,2]:', shoulder?.name, elbow?.name, hand?.name);
    }
    simpleTwoJointIK(shoulder, elbow, hand, adjustedTarget);
  } else {
    if (now - lastLeftLogTime > 1000) {
  logger.warn('[IK-L] No valid arm chain! length=', leftArmChain?.length);
    }
  }
}

// 右手柄扳机按下时，右手跟随手柄移动（镜像映射模式）
function handleRightHandFollow() {
  if (!robot || !mirroringActive) return;
  
  const rightHandJoint = findBone(robot, RIGHT_HAND_NAME || RIGHT_HAND_JOINT_NAME, 'right');
  if (!rightHandJoint) {
  logger.warn('[WARN] right hand joint not found');
    return;
  }
  // 仅使用“右手”控制器
  const activeController = (renderer && renderer.xr && renderer.xr.isPresenting) ? getControllerByHand('right') : null;
  if (!activeController) return;
  if (activeController.userData && activeController.userData.handedness && activeController.userData.handedness !== 'right') {
    return;
  }
  activeController.updateMatrixWorld(true);
  
  // 校准后持续跟随，不在此处做初始化
  
  // === 第二步：计算手柄的相对变化（用户参照系 -> 机器人本地） ===
  const camPosR = new THREE.Vector3();
  camera.getWorldPosition(camPosR);
  const ctrlWorldR = new THREE.Vector3();
  activeController.getWorldPosition(ctrlWorldR);
  const currentOffsetWorldR = ctrlWorldR.sub(camPosR);
  const currentLocalUserR = currentOffsetWorldR.clone().applyQuaternion(invCameraInitialQuat);
  const baseDeltaUserR = currentLocalUserR.sub(rightControllerInitialLocalUser);
  if (baseDeltaUserR.lengthSq() < 1e-4) return;
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const yGainR = baseDeltaUserR.y > Y_UP_THRESHOLD ? (FOLLOW_GAIN.y * Y_UP_BOOST) : FOLLOW_GAIN.y;
  const deltaUserGainedR = new THREE.Vector3(
    baseDeltaUserR.x * FOLLOW_GAIN.x,
    baseDeltaUserR.y * yGainR,
    baseDeltaUserR.z * FOLLOW_GAIN.z
  );
  const deltaWorldR = deltaUserGainedR.clone().applyQuaternion(cameraInitialQuat);
  const robotInvR = robot.quaternion.clone().invert();
  const deltaRobotLocalR = deltaWorldR.clone().applyQuaternion(robotInvR);
  deltaRobotLocalR.z *= -1;
  
  // 根据机器人手臂长度与人类手臂长度的比例缩放用户位移
  // 这样用户的小幅移动在大机器人上也能产生相应幅度的移动
  const robotArmLenR = rightArmChainInfo?.total || HUMAN_ARM_LENGTH;
  const scaleRatioR = robotArmLenR / HUMAN_ARM_LENGTH;
  deltaRobotLocalR.multiplyScalar(scaleRatioR);
  
  if (now - lastRightLogTime > 1000) {
  logger.debug(`[右手] 用户偏移: x=${baseDeltaUserR.x.toFixed(3)}, y=${baseDeltaUserR.y.toFixed(3)}, z=${baseDeltaUserR.z.toFixed(3)}`);
  logger.debug(`[右手] 机器人本地偏移: x=${deltaRobotLocalR.x.toFixed(3)}, y=${deltaRobotLocalR.y.toFixed(3)}, z=${deltaRobotLocalR.z.toFixed(3)}`);
  logger.debug(`[右手] 手臂长度缩放: robotArmLen=${robotArmLenR.toFixed(3)}, scaleRatio=${scaleRatioR.toFixed(3)}`);
    lastRightLogTime = now;
  }
  
  const headLocalCurrentR = getHeadLocalPosition(new THREE.Vector3());
  const baseLocalR = headLocalCurrentR.clone().add(rightHandOffsetFromHeadLocal);
  const targetLocalR = baseLocalR.add(deltaRobotLocalR);
  const targetHandPos = targetLocalR.clone();
  robot.localToWorld(targetHandPos);
  
  // 碰撞推出
  const upwardR = targetHandPos.y > (cameraInitialPos.y + 0.2);
  const adjustedTarget = pushTargetOutOfColliders(targetHandPos, upwardR ? 0.05 : 0.08);
  
  // 使用简单IK（只旋转肩膀和肘部）
  // 骨骼链结构：[0]=Shoulder(锁骨), [1]=UpperArm(大臂), [2]=LowerArm(小臂), [3]=Hand(手掌)
  // IK 需要：UpperArm(肩部旋转), LowerArm(肘部弯曲), Hand(末端目标)
  if (rightArmChain && rightArmChain.length >= 4) {
    const shoulder = rightArmChain[1]; // UpperArmR - 大臂，控制肩部旋转
    const elbow = rightArmChain[2];    // LowerArmR - 小臂，控制肘部弯曲
    const hand = rightArmChain[3];     // Hand - 手掌，IK 目标末端
    if (now - lastRightLogTime > 1000) {
  logger.info('[IK-R] 4-bone chain, using [1,2,3]:', shoulder?.name, elbow?.name, hand?.name);
    }
    simpleTwoJointIK(shoulder, elbow, hand, adjustedTarget);
  } else if (rightArmChain && rightArmChain.length === 3) {
    // 兼容没有 Shoulder 的 3 段链：UpperArm, LowerArm, Hand
    const shoulder = rightArmChain[0];
    const elbow = rightArmChain[1];
    const hand = rightArmChain[2];
    if (now - lastRightLogTime > 1000) {
  logger.info('[IK-R] 3-bone chain, using [0,1,2]:', shoulder?.name, elbow?.name, hand?.name);
    }
    simpleTwoJointIK(shoulder, elbow, hand, adjustedTarget);
  } else {
    if (now - lastRightLogTime > 1000) {
  logger.warn('[IK-R] No valid arm chain! length=', rightArmChain?.length);
    }
  }
}

// 机器人朝向同步：让机器人背对用户（这样手臂跟随方向才正确）
// 已废弃 - 现在机器人由摇杆控制，不再跟随用户朝向
function updateRobotOrientationByUser() {
  // 不再自动跟随用户朝向
  return;
}
// 机器人整体跟随用户移动（头显位置）
// 已废弃 - 现在机器人由摇杆控制，不再跟随用户位置
function updateRobotPositionByUser() {
  // 不再自动跟随用户位置
  return;
}

function animate() {
  renderer.setAnimationLoop(render);
}

function render() {
  const delta = clock.getDelta();

  if (mixer) mixer.update(delta);
  
  // 读取左手柄摇杆输入
  updateJoystickInput();
  // 读取 XR 按钮状态（用于双扳机确认）
  updateXRButtons();
  
  // 根据摇杆输入更新机器人移动
  updateRobotLocomotion(delta);

  // 如果 fingers 被锁定，覆盖动画带来的变换以冻结它们
  if (fingersLocked) {
    for (const name in fingerSavedQuats) {
      const obj = robot.getObjectByName(name);
      if (obj) {
        obj.quaternion.copy(fingerSavedQuats[name]);
        obj.updateMatrixWorld(true);
      }
    }
  }

  // 更新调试球位置
  if (skeletonHelper && skeletonHelper.visible) {
    for (const s of fingerSpheres) {
      if (!s.bone || !s.mesh) continue;
      const wp = new THREE.Vector3();
      s.bone.getWorldPosition(wp);
      s.mesh.position.copy(wp);
      s.mesh.updateMatrixWorld(true);
    }
  }

  // 非VR模式：让桌面相机跟随机器人（从后方俯视）
  if (!renderer.xr.isPresenting && robot) {
    const robotPos = new THREE.Vector3();
    robot.getWorldPosition(robotPos);
    
    // 相机在机器人后方3米，高度2.5米
    const backOffset = new THREE.Vector3(0, 0, 3.0);
    backOffset.applyQuaternion(robot.quaternion);
    
    camera.position.copy(robotPos).add(backOffset).add(new THREE.Vector3(0, 2.5, 0));
    camera.lookAt(robotPos.clone().add(new THREE.Vector3(0, 1.0, 0))); // 看向机器人上半身
  }
  
  // VR 模式：更新 3D 调试面板内容（位置固定不动）
  if (renderer.xr.isPresenting && vrDebugPanel && robot) {
    const robotPos = new THREE.Vector3();
    robot.getWorldPosition(robotPos);
    
    // 获取当前模型名称
    let modelName = 'RobotExpressive';
    if (currentAvatarConfig.value) {
      if (currentAvatarConfig.value.fileName) {
        modelName = currentAvatarConfig.value.fileName;
      } else if (currentAvatarConfig.value.presetId) {
        modelName = currentAvatarConfig.value.presetId;
      }
    }
    
    // 手臂跟随状态
    const armFollowStatus = mirroringActive ? 'ON' : 'OFF';
    
    // 更新面板内容
    updateVRDebugPanel([
      'VR Robot Control',
      '---------------------',
      `Pos: (${robotPos.x.toFixed(1)}, ${robotPos.y.toFixed(1)}, ${robotPos.z.toFixed(1)})`,
      `Arm Follow: ${armFollowStatus}`,
  `记录：${lastRecordLabel}`,
      `Model: ${modelName}`
    ]);
  }
  
  // 左右手柄扳机按下时才跟随
  handleLeftHandFollow();
  handleRightHandFollow();

  // 更新镜像视图
  updateMirrorView();

  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
</script>

<style scoped>
#vr-container {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
</style>