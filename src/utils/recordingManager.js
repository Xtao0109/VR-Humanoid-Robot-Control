import * as THREE from 'three';

const DEFAULT_SETTINGS = {
  hotkey: 'F9',
  enableHotkey: true,
  autoExportOnSessionEnd: true,
  autoClearOnExport: false,
  promptOnSessionEnd: true,
  exportPromptMessage: '检测到 VR 记录数据，是否下载文件？',
  filenamePrefix: 'vr-recording',
  triggerHands: ['left', 'right'],
  gripButtonIndex: 1,
  minTriggerValue: 0.2,
  onlyWhenSessionActive: true,
  allowDesktopCapture: false,
  metadataProvider: null,
  onCapture: null,
  onExport: null,
};

function buildFilename(prefix, extension = 'csv') {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}-${timestamp}.${extension}`;
}

function decomposeObject(object3d) {
  if (!object3d) return null;
  const pos = new THREE.Vector3();
  if (object3d.matrixWorldNeedsUpdate) {
    object3d.updateMatrixWorld(true);
  }
  object3d.matrixWorld.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
  return [pos.x, pos.y, pos.z];
}

function poseArray(pose) {
  if (!pose) return ['', '', ''];
  const [px, py, pz] = pose;
  return [px, py, pz];
}

function makeCsv(records) {
  if (!records.length) return '';
  const header = [
    'index', 'reason', 'timestampMs',
    'user_head_px', 'user_head_py', 'user_head_pz',
    'user_left_px', 'user_left_py', 'user_left_pz',
    'user_right_px', 'user_right_py', 'user_right_pz',
    'robot_head_px', 'robot_head_py', 'robot_head_pz',
    'robot_leftShoulder_px', 'robot_leftShoulder_py', 'robot_leftShoulder_pz',
    'robot_leftUpperArm_px', 'robot_leftUpperArm_py', 'robot_leftUpperArm_pz',
    'robot_leftLowerArm_px', 'robot_leftLowerArm_py', 'robot_leftLowerArm_pz',
    'robot_leftHand_px', 'robot_leftHand_py', 'robot_leftHand_pz',
    'robot_rightShoulder_px', 'robot_rightShoulder_py', 'robot_rightShoulder_pz',
    'robot_rightUpperArm_px', 'robot_rightUpperArm_py', 'robot_rightUpperArm_pz',
    'robot_rightLowerArm_px', 'robot_rightLowerArm_py', 'robot_rightLowerArm_pz',
    'robot_rightHand_px', 'robot_rightHand_py', 'robot_rightHand_pz',
    'metadata'
  ];

  const lines = records.map((record) => {
    const { index, reason, timestamp, user, robot, metadata } = record;
    const head = poseArray(user.head);
    const leftCtrl = poseArray(user.leftController);
    const rightCtrl = poseArray(user.rightController);
    const robotHead = poseArray(robot.head);
    const robotLeftShoulder = poseArray(robot.leftShoulder);
    const robotLeftUpper = poseArray(robot.leftUpperArm);
    const robotLeftLower = poseArray(robot.leftLowerArm);
    const robotLeftHand = poseArray(robot.leftHand);
    const robotRightShoulder = poseArray(robot.rightShoulder);
    const robotRightUpper = poseArray(robot.rightUpperArm);
    const robotRightLower = poseArray(robot.rightLowerArm);
    const robotRightHand = poseArray(robot.rightHand);
    const metaJson = metadata != null ? JSON.stringify(metadata) : '';
    const metaCell = metaJson ? `"${metaJson.replace(/"/g, '""')}"` : '';
    const values = [
      index,
      reason,
      timestamp.toFixed(3),
      ...head,
      ...leftCtrl,
      ...rightCtrl,
      ...robotHead,
      ...robotLeftShoulder,
      ...robotLeftUpper,
      ...robotLeftLower,
      ...robotLeftHand,
      ...robotRightShoulder,
      ...robotRightUpper,
      ...robotRightLower,
      ...robotRightHand,
      metaCell,
    ];
    return values.join(',');
  });

  return [header.join(','), ...lines].join('\n');
}

function downloadBlob(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function createRecordingManager(initialSettings = {}) {
  let settings = { ...DEFAULT_SETTINGS, ...initialSettings };
  let deps = null;
  let records = [];
  let isSessionActive = false;
  const gripState = { left: false, right: false };
  const cleanupFns = [];

  function resetGripState() {
    gripState.left = false;
    gripState.right = false;
  }

  function getSession() {
    if (!deps || !deps.renderer || !deps.renderer.xr) return null;
    if (typeof deps.renderer.xr.getSession === 'function') {
      return deps.renderer.xr.getSession();
    }
    return null;
  }

  function handleHotkey(evt) {
    if (!settings.enableHotkey || !settings.hotkey) return;
    if (evt.key !== settings.hotkey) return;
    capture('hotkey');
  }

  function handleSessionStart() {
    isSessionActive = true;
    resetGripState();
  }

  function handleSessionEnd() {
    isSessionActive = false;
    resetGripState();
    if (!records.length) return;

    const canPrompt = typeof window !== 'undefined' && typeof window.confirm === 'function';
    if (settings.promptOnSessionEnd && canPrompt) {
      const message = settings.exportPromptMessage || '检测到记录数据，是否下载？';
      const confirmed = window.confirm(message);
      if (confirmed) {
        exportRecords();
      } else {
        console.log('[RecordingManager] 用户取消下载记录，可稍后通过 window.__vrRecordingManager.export() 手动导出');
      }
      return;
    }

    if (settings.autoExportOnSessionEnd) {
      exportRecords();
    }
  }

  function registerListeners() {
    if (settings.enableHotkey && settings.hotkey) {
      const listener = handleHotkey;
      window.addEventListener('keydown', listener);
      cleanupFns.push(() => window.removeEventListener('keydown', listener));
    }

    const xr = deps?.renderer?.xr;
    if (xr && typeof xr.addEventListener === 'function') {
      xr.addEventListener('sessionstart', handleSessionStart);
      xr.addEventListener('sessionend', handleSessionEnd);
      cleanupFns.push(() => {
        xr.removeEventListener('sessionstart', handleSessionStart);
        xr.removeEventListener('sessionend', handleSessionEnd);
      });
    }
  }

  function init(initDeps, initSettings = {}) {
    deps = initDeps;
    settings = { ...settings, ...initSettings };
    if (!deps || !deps.renderer) {
      console.warn('[RecordingManager] renderer 未提供，部分功能不可用');
    }
    registerListeners();
    return api;
  }

  function capture(reason = 'manual', extra = {}) {
    if (!deps) return null;
    if (settings.onlyWhenSessionActive && !isSessionActive) {
      if (!settings.allowDesktopCapture) return null;
    }

    const timestamp = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const metadata = typeof settings.metadataProvider === 'function' ? settings.metadataProvider() : null;

    const getPart = (name) => (typeof deps.getRobotPart === 'function' ? decomposeObject(deps.getRobotPart(name)) : null);

    const record = {
      index: records.length + 1,
      reason,
      timestamp,
      metadata,
      extra,
      user: {
        head: typeof deps.getUserHeadObject === 'function' ? decomposeObject(deps.getUserHeadObject()) : null,
        leftController: typeof deps.getControllerObject === 'function' ? decomposeObject(deps.getControllerObject('left')) : null,
        rightController: typeof deps.getControllerObject === 'function' ? decomposeObject(deps.getControllerObject('right')) : null,
      },
      robot: {
        head: getPart('head'),
        leftShoulder: getPart('leftShoulder'),
        leftUpperArm: getPart('leftUpperArm'),
        leftLowerArm: getPart('leftLowerArm'),
        leftHand: getPart('leftHand'),
        rightShoulder: getPart('rightShoulder'),
        rightUpperArm: getPart('rightUpperArm'),
        rightLowerArm: getPart('rightLowerArm'),
        rightHand: getPart('rightHand'),
      },
    };

    records.push(record);

    if (typeof settings.onCapture === 'function') {
      try {
        settings.onCapture(record);
      } catch (err) {
        console.warn('[RecordingManager] onCapture 回调出错', err);
      }
    }

    return record;
  }

  function update() {
    const session = getSession();
    if (!session) return;
    if (settings.onlyWhenSessionActive && !isSessionActive) return;

    const triggerHands = settings.triggerHands || [];

    for (const source of session.inputSources) {
      if (!source || !source.handedness) continue;
      const hand = source.handedness;
      if (!triggerHands.includes(hand)) continue;
      if (!source.gamepad || !source.gamepad.buttons) continue;
      const button = source.gamepad.buttons[settings.gripButtonIndex];
      if (!button) continue;
      const pressed = !!button.pressed || (typeof button.value === 'number' && button.value > settings.minTriggerValue);
      const prev = gripState[hand];
      if (pressed && !prev) {
        capture(`${hand}-grip`);
      }
      gripState[hand] = pressed;
    }
  }

  function exportRecords(options = {}) {
    if (!records.length) {
      console.warn('[RecordingManager] 没有可导出的记录');
      return null;
    }
    const { format = 'csv', filename: customFilename } = options;
    let filename = customFilename;
    if (!filename) {
      filename = buildFilename(settings.filenamePrefix, format === 'json' ? 'json' : 'csv');
    }

    if (format === 'json') {
      const json = JSON.stringify(records, null, 2);
      downloadBlob(json, filename, 'application/json');
    } else {
      const csv = makeCsv(records);
      downloadBlob(csv, filename, 'text/csv');
    }

    if (typeof settings.onExport === 'function') {
      try {
        settings.onExport({ filename, format, count: records.length });
      } catch (err) {
        console.warn('[RecordingManager] onExport 回调出错', err);
      }
    }

    if (settings.autoClearOnExport) {
      clear();
    }

    return filename;
  }

  function clear() {
    records = [];
  }

  function dispose() {
    while (cleanupFns.length) {
      const fn = cleanupFns.pop();
      try {
        fn();
      } catch (err) {
        console.warn('[RecordingManager] 清理监听出现问题', err);
      }
    }
    clear();
  }

  const api = {
    init,
    update,
    capture,
    export: exportRecords,
    clear,
    dispose,
    getRecords: () => records.slice(),
    setSettings(partial) {
      settings = { ...settings, ...partial };
    },
    getSettings: () => ({ ...settings }),
    get isSessionActive() {
      return isSessionActive;
    },
  };

  return api;
}

export default createRecordingManager;
