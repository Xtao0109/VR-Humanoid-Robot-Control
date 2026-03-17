import * as THREE from 'three';
import logger from './logger';

// ============================================================================
// Isaac Sim Imitation Learning Data Collection — Recording Manager
// ============================================================================
// 导出格式：
//   session.json    — 会话 & 机器人描述元数据 & 坐标系定义
//   episodes.jsonl  — 帧级数据（含关节局部旋转、夹爪状态、action、episode 划分）
//   events.jsonl    — 离散事件流（grasp、episode 边界等）
// ============================================================================

const DEFAULT_SETTINGS = {
  filenamePrefix: 'vr-demonstrations',
  enableFrameCapture: true,
  enableEventCapture: true,
  frameRate: 30,
  onlyWhenSessionActive: true,
  allowDesktopCapture: false,
  autoClearOnSessionStart: true,
  autoExportOnSessionEnd: false,
  promptOnSessionEnd: true,
  exportPromptMessage: '检测到示教数据，是否下载数据集？',
  coordinateSystem: {
    convention: 'Y-up right-hand (three.js)',
    up: [0, 1, 0],
    forward: [0, 0, -1],
    units: 'meters',
    note: 'Isaac Sim uses Z-up; post-processing rotation required: R = Rx(-90deg)',
  },
  metadataProvider: null,
  onCapture: null,
  onExport: null,
};

// ---- Utility Functions ----

function buildFilename(prefix, extension = 'json') {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}-${ts}.${extension}`;
}

/** World-space pose {p:[x,y,z], q:[qx,qy,qz,qw]} */
function decomposeObjectFull(object3d) {
  if (!object3d) return null;
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  if (object3d.matrixWorldNeedsUpdate) object3d.updateMatrixWorld(true);
  object3d.matrixWorld.decompose(pos, quat, new THREE.Vector3());
  return { p: [pos.x, pos.y, pos.z], q: [quat.x, quat.y, quat.z, quat.w] };
}

/** Convert pose object {p,q} to vectors */
function poseToVectors(pose) {
  if (!pose || !Array.isArray(pose.p) || !Array.isArray(pose.q)) return null;
  if (pose.p.length !== 3 || pose.q.length !== 4) return null;
  return {
    p: new THREE.Vector3(pose.p[0], pose.p[1], pose.p[2]),
    q: new THREE.Quaternion(pose.q[0], pose.q[1], pose.q[2], pose.q[3]),
  };
}

/** Estimate linear & angular velocity from two poses */
function estimatePoseVelocity(curPose, prevPose, dt) {
  if (!curPose || !prevPose || !(dt > 0)) {
    return {
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    };
  }
  const cur = poseToVectors(curPose);
  const prev = poseToVectors(prevPose);
  if (!cur || !prev) {
    return {
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    };
  }

  const dv = new THREE.Vector3().subVectors(cur.p, prev.p).multiplyScalar(1 / dt);

  // q_delta = q_cur * inv(q_prev)
  const qDelta = cur.q.clone().multiply(prev.q.clone().invert());
  const qw = Math.max(-1, Math.min(1, qDelta.w));
  let angle = 2 * Math.acos(qw);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  const s = Math.sqrt(Math.max(1 - qw * qw, 0));

  let axis = new THREE.Vector3(0, 0, 0);
  if (s > 1e-6) {
    axis.set(qDelta.x / s, qDelta.y / s, qDelta.z / s);
  }
  const omega = axis.multiplyScalar(angle / dt);

  return {
    linearVelocity: [dv.x, dv.y, dv.z],
    angularVelocity: [omega.x, omega.y, omega.z],
  };
}

/** Joint local quaternion (relative to parent) [qx, qy, qz, qw] */
function getLocalQuaternion(object3d) {
  if (!object3d) return null;
  const q = object3d.quaternion;
  return [q.x, q.y, q.z, q.w];
}

/** Joint local Euler angles (rad) [rx, ry, rz] — XYZ order */
function getLocalEuler(object3d) {
  if (!object3d) return null;
  const e = new THREE.Euler().setFromQuaternion(object3d.quaternion, 'XYZ');
  return [e.x, e.y, e.z];
}

/** Pose relative to a base frame {p:[x,y,z], q:[qx,qy,qz,qw]} */
function poseRelativeToBase(object3d, baseObject3d) {
  if (!object3d || !baseObject3d) return null;
  if (object3d.matrixWorldNeedsUpdate) object3d.updateMatrixWorld(true);
  if (baseObject3d.matrixWorldNeedsUpdate) baseObject3d.updateMatrixWorld(true);
  const invBase = new THREE.Matrix4().copy(baseObject3d.matrixWorld).invert();
  const relMatrix = new THREE.Matrix4().multiplyMatrices(invBase, object3d.matrixWorld);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  relMatrix.decompose(pos, quat, new THREE.Vector3());
  return { p: [pos.x, pos.y, pos.z], q: [quat.x, quat.y, quat.z, quat.w] };
}

function makeJsonl(items) {
  if (!items || !items.length) return '';
  return items.map((item) => JSON.stringify(item)).join('\n');
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

// ---- Main Module ----

export function createRecordingManager(initialSettings = {}) {
  let settings = { ...DEFAULT_SETTINGS, ...initialSettings };
  let deps = null;

  // Data storage
  let frames = [];
  let events = [];
  let sessionInfo = null;
  let isSessionActive = false;
  let frameIndex = 0;
  let eventIndex = 0;

  // Episode management
  let currentEpisodeId = 0;
  let episodeCounter = 0;
  let episodeStartTime = 0;
  let episodeFrameStart = 0;

  // Gripper state (per-frame continuous signal, 0.0=open, 1.0=closed)
  let gripperState = { left: 0.0, right: 0.0 };

  // Previous frame cache for velocity & action delta computation
  let prevJointEulers = {};
  let prevFrameTimestamp = 0;
  let prevUserPose = { head: null, left: null, right: null };

  const cleanupFns = [];

  // ---- Internal ----

  function getSession() {
    if (!deps || !deps.renderer || !deps.renderer.xr) return null;
    if (typeof deps.renderer.xr.getSession === 'function') return deps.renderer.xr.getSession();
    return null;
  }

  function handleSessionStart() {
    isSessionActive = true;
    gripperState = { left: 0.0, right: 0.0 };
    if (settings.autoClearOnSessionStart) clear();
    const metadata = typeof settings.metadataProvider === 'function' ? settings.metadataProvider() : null;
    sessionInfo = {
      createdAt: Date.now(),
      schemaVersion: 'v2_human_motion_input',
      coordinateSystem: settings.coordinateSystem,
      settings: { frameRate: settings.frameRate, filenamePrefix: settings.filenamePrefix },
      recordedChannels: {
        userPose: true,
        userMotion: true,
        userInput: true,
        robotJointState: true,
        robotActionJointDelta: true,
        taskObservation: typeof deps?.getTaskObservation === 'function',
      },
      metadata,
      robotDescription: typeof deps.getRobotDescription === 'function' ? deps.getRobotDescription() : null,
    };
  }

  function handleSessionEnd() {
    isSessionActive = false;
    gripperState = { left: 0.0, right: 0.0 };
    if (currentEpisodeId > 0) endEpisode('session_end');
    if (!frames.length && !events.length) return;
    const canPrompt = typeof window !== 'undefined' && typeof window.confirm === 'function';
    if (settings.promptOnSessionEnd && canPrompt) {
      const confirmed = window.confirm(settings.exportPromptMessage);
      if (confirmed) exportDataset();
      else logger.info('[RecordingManager] Export cancelled. Use window.__vrRecordingManager.exportDataset() later.');
      return;
    }
    if (settings.autoExportOnSessionEnd) exportDataset();
  }

  function registerListeners() {
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

  // ---- Public API ----

  function init(initDeps, initSettings = {}) {
    deps = initDeps;
    settings = { ...settings, ...initSettings };
    if (!deps || !deps.renderer) logger.warn('[RecordingManager] renderer not provided');
    registerListeners();
    return api;
  }

  /** Start a new episode (one complete demonstration) */
  function startEpisode(taskDescription = '') {
    if (currentEpisodeId > 0) endEpisode('auto_end_by_new_start');
    episodeCounter += 1;
    currentEpisodeId = episodeCounter;
    episodeStartTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    episodeFrameStart = frameIndex;
    prevJointEulers = {};
    prevFrameTimestamp = 0;
    prevUserPose = { head: null, left: null, right: null };
    recordEvent('episode_start', { episodeId: currentEpisodeId, task: taskDescription });
    logger.info(`[RecordingManager] Episode #${currentEpisodeId} started: ${taskDescription || '(no description)'}`);
    return currentEpisodeId;
  }

  /** End current episode */
  function endEpisode(outcome = 'success') {
    if (currentEpisodeId <= 0) return;
    const duration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - episodeStartTime;
    const frameCount = frameIndex - episodeFrameStart;
    recordEvent('episode_end', { episodeId: currentEpisodeId, outcome, durationMs: duration, frameCount });
    logger.info(`[RecordingManager] Episode #${currentEpisodeId} ended: ${outcome} (${frameCount} frames, ${(duration / 1000).toFixed(1)}s)`);
    currentEpisodeId = 0;
  }

  /** Set gripper state (continuous, per hand) */
  function setGripperState(hand, value) {
    if (hand === 'left' || hand === 'right') {
      gripperState[hand] = typeof value === 'number' ? value : (value ? 1.0 : 0.0);
    }
  }

  /** Core frame recording — captures full observation + action per tick */
  function recordFrame(reason = 'tick', extra = {}) {
    if (!deps) return null;
    if (!settings.enableFrameCapture) return null;
    if (settings.onlyWhenSessionActive && !isSessionActive && !settings.allowDesktopCapture) return null;
    // 仅记录 episode 内数据：episode 外数据不写入训练集
    if (currentEpisodeId <= 0) return null;

    const timestamp = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const dt = prevFrameTimestamp > 0 ? (timestamp - prevFrameTimestamp) / 1000 : 0;

    // ---- User VR devices ----
    const userHead = typeof deps.getUserHeadObject === 'function' ? decomposeObjectFull(deps.getUserHeadObject()) : null;
    const userLeftCtrl = typeof deps.getControllerObject === 'function' ? decomposeObjectFull(deps.getControllerObject('left')) : null;
    const userRightCtrl = typeof deps.getControllerObject === 'function' ? decomposeObjectFull(deps.getControllerObject('right')) : null;
    const userLeftInput = typeof deps.getControllerInput === 'function' ? (deps.getControllerInput('left') || null) : null;
    const userRightInput = typeof deps.getControllerInput === 'function' ? (deps.getControllerInput('right') || null) : null;

    const userMotion = {
      head: estimatePoseVelocity(userHead, prevUserPose.head, dt),
      leftController: estimatePoseVelocity(userLeftCtrl, prevUserPose.left, dt),
      rightController: estimatePoseVelocity(userRightCtrl, prevUserPose.right, dt),
    };

    prevUserPose.head = userHead;
    prevUserPose.left = userLeftCtrl;
    prevUserPose.right = userRightCtrl;

    // ---- Robot joints ----
    const robotBase = typeof deps.getRobotBase === 'function' ? deps.getRobotBase() : null;
    const jointNames = typeof deps.getJointNames === 'function' ? deps.getJointNames() : [];
    const getJoint = typeof deps.getRobotPart === 'function' ? deps.getRobotPart : () => null;

    const jointLocalQuats = {};
    const jointLocalEulers = {};
    const jointBaseRelPoses = {};

    for (const name of jointNames) {
      const obj = getJoint(name);
      if (!obj) continue;
      jointLocalQuats[name] = getLocalQuaternion(obj);
      jointLocalEulers[name] = getLocalEuler(obj);
      if (robotBase) jointBaseRelPoses[name] = poseRelativeToBase(obj, robotBase);
    }

    // ---- End-effector poses (relative to robot base) ----
    const leftHandObj = getJoint('leftHand');
    const rightHandObj = getJoint('rightHand');
    const eeLeft = robotBase && leftHandObj ? poseRelativeToBase(leftHandObj, robotBase) : null;
    const eeRight = robotBase && rightHandObj ? poseRelativeToBase(rightHandObj, robotBase) : null;

    // ---- Joint angular velocity (finite difference) ----
    const jointVelocities = {};
    if (dt > 0) {
      for (const name of jointNames) {
        const cur = jointLocalEulers[name];
        const prev = prevJointEulers[name];
        if (cur && prev) {
          jointVelocities[name] = [
            (cur[0] - prev[0]) / dt,
            (cur[1] - prev[1]) / dt,
            (cur[2] - prev[2]) / dt,
          ];
        }
      }
    }

    // ---- Action: joint angle delta (current - previous) ----
    const actionJointDelta = {};
    for (const name of jointNames) {
      const cur = jointLocalEulers[name];
      const prev = prevJointEulers[name];
      if (cur && prev) {
        actionJointDelta[name] = [cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]];
      }
    }

    // Update cache
    for (const name of jointNames) {
      if (jointLocalEulers[name]) prevJointEulers[name] = jointLocalEulers[name].slice();
    }
    prevFrameTimestamp = timestamp;

    // ---- Task observation (optional) ----
    let taskObs = null;
    if (typeof deps.getTaskObservation === 'function') {
      try {
        taskObs = deps.getTaskObservation();
      } catch (e) {
        taskObs = null;
      }
    }

    const frame = {
      index: (frameIndex += 1),
      episodeId: currentEpisodeId,
      reason,
      timestamp,
      dt,

      // === Observation ===
      obs: {
        user: { head: userHead, leftController: userLeftCtrl, rightController: userRightCtrl },
        userMotion,
        userInput: { leftController: userLeftInput, rightController: userRightInput },
        jointPositions: jointLocalEulers,
        jointQuaternions: jointLocalQuats,
        jointVelocities,
        endEffector: { left: eeLeft, right: eeRight },
        gripperState: { ...gripperState },
        jointBaseRelPoses,
        ...(taskObs ? { task: taskObs } : {}),
      },

      // === Action (for policy learning) ===
      action: {
        jointDelta: actionJointDelta,
        gripperCommand: { ...gripperState },
      },

      metadata: typeof settings.metadataProvider === 'function' ? settings.metadataProvider() : null,
      extra,
    };

    frames.push(frame);
    if (typeof settings.onCapture === 'function') {
      try { settings.onCapture(frame); } catch (e) { /* ignore */ }
    }
    return frame;
  }

  /** Record a discrete event */
  function recordEvent(type, payload = {}, extra = {}) {
    if (!deps) return null;
    if (!settings.enableEventCapture) return null;
    if (settings.onlyWhenSessionActive && !isSessionActive && !settings.allowDesktopCapture) return null;
    const timestamp = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const event = {
      index: (eventIndex += 1),
      episodeId: currentEpisodeId,
      type,
      timestamp,
      payload,
      extra,
    };
    events.push(event);
    return event;
  }

  /** Export the complete dataset */
  function exportDataset(options = {}) {
    const prefix = options.filenamePrefix || settings.filenamePrefix || 'vr-demonstrations';

    // session.json
    const sessionPayload = {
      ...(sessionInfo || {}),
      createdAt: sessionInfo?.createdAt || Date.now(),
      coordinateSystem: settings.coordinateSystem,
      robotDescription: typeof deps?.getRobotDescription === 'function' ? deps.getRobotDescription() : (sessionInfo?.robotDescription || null),
      totalEpisodes: episodeCounter,
      totalFrames: frames.length,
      totalEvents: events.length,
      frameRate: settings.frameRate,
      exportedAt: Date.now(),
    };
    const sessionFilename = buildFilename(prefix + '-session', 'json');
    downloadBlob(JSON.stringify(sessionPayload, null, 2), sessionFilename, 'application/json');

    // episodes.jsonl
    const framesFilename = buildFilename(prefix + '-episodes', 'jsonl');
    downloadBlob(makeJsonl(frames), framesFilename, 'application/jsonl');

    // events.jsonl
    const eventsFilename = buildFilename(prefix + '-events', 'jsonl');
    downloadBlob(makeJsonl(events), eventsFilename, 'application/jsonl');

    logger.info(`[RecordingManager] Dataset exported: ${frames.length} frames, ${events.length} events, ${episodeCounter} episodes`);
    if (typeof settings.onExport === 'function') {
      try { settings.onExport({ sessionFilename, framesFilename, eventsFilename, count: frames.length }); }
      catch (e) { /* ignore */ }
    }
    return { sessionFilename, framesFilename, eventsFilename };
  }

  function clear() {
    frames = [];
    events = [];
    frameIndex = 0;
    eventIndex = 0;
    currentEpisodeId = 0;
    episodeCounter = 0;
    prevJointEulers = {};
    prevFrameTimestamp = 0;
    prevUserPose = { head: null, left: null, right: null };
    gripperState = { left: 0.0, right: 0.0 };
  }

  function dispose() {
    while (cleanupFns.length) {
      const fn = cleanupFns.pop();
      try { fn(); } catch (e) { /* ignore */ }
    }
    clear();
  }

  const api = {
    init,
    recordFrame,
    recordEvent,
    exportDataset,
    startEpisode,
    endEpisode,
    setGripperState,
    clear,
    dispose,
    getFrames: () => frames.slice(),
    getEvents: () => events.slice(),
    setSettings(partial) { settings = { ...settings, ...partial }; },
    getSettings: () => ({ ...settings }),
    get isSessionActive() { return isSessionActive; },
    get currentEpisodeId() { return currentEpisodeId; },
    get episodeCount() { return episodeCounter; },
    get frameCount() { return frames.length; },
  };

  return api;
}

export default createRecordingManager;
