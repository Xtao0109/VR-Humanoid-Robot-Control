// 负责加载 glTF/GLB 模型并提取骨骼/节点信息

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';

// 加载模型并返回 { scene, bones, nodes }
// bones 尽量兼容多种导出方式：
// 1) 直接的 Bone 节点 (obj.isBone === true)
// 2) Mesh.skeleton.bones 中的骨骼（很多模型不会把 Bone 挂在 scene 根上）
export async function loadAvatarModel(url) {
  if (!url) throw new Error('Avatar URL is empty');

  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load(
      url,
      (g) => resolve(g),
      undefined,
      (err) => reject(err)
    );
  });

  const scene = gltf.scene || gltf.scenes?.[0];
  if (!scene) throw new Error('GLTF has no scene');

  const bones = [];
  const nodes = [];

  scene.traverse((obj) => {
    if (!obj || !obj.name) return;
    nodes.push(obj);
    // 1) 直接的 Bone
    if (obj.isBone) {
      bones.push(obj);
    }
    // 2) Mesh.skeleton 中的骨骼
    if (obj.isMesh && obj.skeleton && Array.isArray(obj.skeleton.bones)) {
      for (const b of obj.skeleton.bones) {
        if (b && b.name) bones.push(b);
      }
    }
  });

  // 去重：有些骨骼既在 scene.traverse 中出现，又在 skeleton.bones 中出现
  const uniqueBones = [];
  const seen = new Set();
  for (const b of bones) {
    if (!b || !b.name) continue;
    const key = b.uuid || b.name;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueBones.push(b);
  }

  return {
    gltf,
    scene,
    bones: uniqueBones,
    nodes,
  };
}

// 将 three.js 对象数组转换为简洁的描述，便于 UI 显示
export function summarizeBones(bones) {
  return bones.map((b) => ({
    name: b.name,
  }));
}

export function summarizeNodes(nodes) {
  return nodes.map((n) => ({
    name: n.name,
    isBone: !!n.isBone,
  }));
}

// 非必须：提供一个简单的自动建议函数，根据名称猜测匹配
export function suggestMappingFromBones(bones) {
  const suggestions = {};
  const lowerNames = bones.map((b) => ({ name: b.name, lower: b.name.toLowerCase() }));

  function findMatch(keywords) {
    return (
      lowerNames.find((b) => keywords.some((k) => b.lower.includes(k)))?.name || ''
    );
  }

  suggestions.head = findMatch(['head']);
  suggestions.spine = findMatch(['spine', 'hips', 'pelvis']);
  suggestions.leftShoulder = findMatch(['shoulder', 'clavicle', 'arm', 'l']);
  suggestions.leftElbow = findMatch(['elbow', 'forearm', 'lowerarm', 'l']);
  suggestions.leftHand = findMatch(['hand', 'wrist', 'palm', 'l']);
  suggestions.rightShoulder = findMatch(['shoulder', 'clavicle', 'arm', 'r']);
  suggestions.rightElbow = findMatch(['elbow', 'forearm', 'lowerarm', 'r']);
  suggestions.rightHand = findMatch(['hand', 'wrist', 'palm', 'r']);

  return suggestions;
}
