<template>
  <div class="avatar-mapping-panel">
    <h2>自定义模型关节映射</h2>

    <div class="section">
      <label class="label">模型文件 (glTF / GLB)</label>
      <input type="file" accept=".gltf,.glb" @change="onFileChange" />
    </div>

    <div v-if="loading" class="status">正在加载模型...</div>
    <div v-if="error" class="status error">{{ error }}</div>

    <div v-if="bonesSummary.length" class="section">
      <div class="bones-list">
        <h3>骨骼列表 ({{ bonesSummary.length }})</h3>
        <ul>
          <li v-for="b in bonesSummary" :key="b.name">{{ b.name }}</li>
        </ul>
      </div>

      <div class="mapping-table">
        <h3>关节映射</h3>
        <table>
          <thead>
            <tr>
              <th>逻辑关节</th>
              <th>骨骼名称</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="joint in logicalJoints" :key="joint">
              <td class="joint-name">{{ joint }}</td>
              <td>
                <select v-model="localMapping[joint]">
                  <option value="">(未选择)</option>
                  <option v-for="b in bonesSummary" :key="b.name" :value="b.name">
                    {{ b.name }}
                  </option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="buttons">
          <button type="button" @click="applyAutoSuggest" :disabled="!bonesSummary.length">
            自动建议映射
          </button>
          <button type="button" class="primary" @click="emitConfirm" :disabled="!modelUrl">
            使用该模型
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { LOGICAL_JOINTS, createEmptyMapping } from './avatarTypes.js';
import { loadAvatarModel, summarizeBones, suggestMappingFromBones } from './avatarLoader.js';

const emit = defineEmits([
  // 当用户完成选择并点击“使用该模型”时发出
  // payload: { url, mapping, raw: { gltf, scene, bones, nodes } }
  'confirm',
]);

const logicalJoints = LOGICAL_JOINTS;

const loading = ref(false);
const error = ref('');
const bonesSummary = ref([]);
const modelUrl = ref('');
const localMapping = ref(createEmptyMapping());
const lastLoaded = ref(null); // { gltf, scene, bones, nodes }
const lastFileData = ref(null); // ArrayBuffer - 原始文件数据，用于持久化存储
const lastFileName = ref('');   // 原始文件名

async function onFileChange(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  error.value = '';
  loading.value = true;

  try {
    // 1. 读取文件为 ArrayBuffer（用于后续存储到 IndexedDB）
    const arrayBuffer = await file.arrayBuffer();
    lastFileData.value = arrayBuffer;
    lastFileName.value = file.name;

    // 2. 通过 blob URL 加载本地文件（用于 three.js 解析）
    const url = URL.createObjectURL(file);
    const result = await loadAvatarModel(url);

    modelUrl.value = url;
    lastLoaded.value = result;
    bonesSummary.value = summarizeBones(result.bones);

    // 每次加载新模型重置映射
    localMapping.value = createEmptyMapping();
  } catch (e) {
    console.error('[AvatarMappingPanel] load error', e);
    error.value = e?.message || '模型加载失败';
    lastFileData.value = null;
    lastFileName.value = '';
  } finally {
    loading.value = false;
  }
}

function applyAutoSuggest() {
  if (!lastLoaded.value) return;
  const suggestions = suggestMappingFromBones(lastLoaded.value.bones || []);
  localMapping.value = {
    ...localMapping.value,
    ...suggestions,
  };
}

function emitConfirm() {
  if (!modelUrl.value || !lastLoaded.value) return;

  emit('confirm', {
    url: modelUrl.value,
    mapping: { ...localMapping.value },
    raw: lastLoaded.value,
    // 新增：传递原始文件数据，供 ConfigApp 存入 IndexedDB
    fileData: lastFileData.value,
    fileName: lastFileName.value,
  });
}
</script>

<style scoped>
.avatar-mapping-panel {
  position: absolute;
  top: 10px;
  left: 10px;
  max-width: 420px;
  max-height: 90vh;
  overflow: auto;
  padding: 12px;
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  font-size: 12px;
  border-radius: 8px;
  z-index: 2000;
}

.section {
  margin-bottom: 10px;
}

.label {
  display: block;
  margin-bottom: 4px;
  font-weight: bold;
}

.status {
  margin: 6px 0;
  color: #ffda79;
}

.status.error {
  color: #ff6b6b;
}

.bones-list {
  max-height: 160px;
  overflow-y: auto;
  margin-bottom: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 4px;
}

.bones-list ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.bones-list li {
  padding: 2px 0;
}

.mapping-table {
  border-top: 1px solid rgba(255, 255, 255, 0.2);
  padding-top: 8px;
}

.mapping-table table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 6px;
}

.mapping-table th,
.mapping-table td {
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  padding: 2px 4px;
}

.joint-name {
  width: 36%;
  font-weight: bold;
}

select {
  width: 100%;
  background: #111;
  color: #fff;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.3);
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

button {
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  background: #222;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
}

button.primary {
  background: #2ecc71;
  border-color: #2ecc71;
  color: #000;
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
