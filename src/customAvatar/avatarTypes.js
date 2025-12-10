// 类型与常量定义：描述逻辑关节与映射配置
// 
// 逻辑关节命名对应原始 RobotExpressive 模型的骨骼结构：
// - shoulder: 肩部 (ShoulderL/R)
// - upperArm: 大臂 (UpperArmL/R)
// - lowerArm: 小臂 (LowerArmL/R)
// - hand: 手掌 (Palm2L/R 等)

export const LOGICAL_JOINTS = [
  'head',
  'spine',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
];

// 关节映射配置结构：logical joint -> bone name
export function createEmptyMapping() {
  const mapping = {};
  for (const j of LOGICAL_JOINTS) mapping[j] = '';
  return mapping;
}

// AvatarConfig 描述一次完整的自定义模型配置
// - url: 模型 glTF/GLB 的 URL 或本地 blob URL
// - name: 方便显示的名称
// - mapping: 逻辑关节到骨骼名的映射
export function createAvatarConfig({ url = '', name = 'Custom Avatar', mapping = null } = {}) {
  return {
    url,
    name,
    mapping: mapping || createEmptyMapping(),
  };
}
