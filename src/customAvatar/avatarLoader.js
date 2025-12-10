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
// 按照原始 RobotExpressive 的骨骼结构：Shoulder → UpperArm → LowerArm → Palm/Hand
export function suggestMappingFromBones(bones) {
  const suggestions = {};
  const boneList = bones.map((b) => ({ name: b.name, lower: b.name.toLowerCase() }));

  // 辅助函数：在骨骼列表中查找匹配的名称
  // side: 'left' | 'right' | null
  function findMatch(keywords, side = null) {
    const sideHints = side === 'left' ? ['left', '_l', '.l', 'l_', '-l'] 
                    : side === 'right' ? ['right', '_r', '.r', 'r_', '-r'] 
                    : [];
    
    // 优先找同时匹配关键字和侧向提示的
    if (side) {
      const match = boneList.find((b) => 
        keywords.some((k) => b.lower.includes(k)) &&
        sideHints.some((s) => b.lower.includes(s) || b.name.endsWith(s.toUpperCase().slice(-1)))
      );
      if (match) return match.name;
    }
    
    // 回退：只匹配关键字
    return boneList.find((b) => keywords.some((k) => b.lower.includes(k)))?.name || '';
  }

  suggestions.head = findMatch(['head']);
  suggestions.spine = findMatch(['spine', 'hips', 'pelvis']);
  
  // 左臂链
  suggestions.leftShoulder = findMatch(['shoulder', 'clavicle'], 'left');
  suggestions.leftUpperArm = findMatch(['upperarm', 'upper_arm', 'arm'], 'left');
  suggestions.leftLowerArm = findMatch(['lowerarm', 'lower_arm', 'forearm'], 'left');
  suggestions.leftHand = findMatch(['hand', 'wrist', 'palm'], 'left');
  
  // 右臂链
  suggestions.rightShoulder = findMatch(['shoulder', 'clavicle'], 'right');
  suggestions.rightUpperArm = findMatch(['upperarm', 'upper_arm', 'arm'], 'right');
  suggestions.rightLowerArm = findMatch(['lowerarm', 'lower_arm', 'forearm'], 'right');
  suggestions.rightHand = findMatch(['hand', 'wrist', 'palm'], 'right');

  return suggestions;
}
