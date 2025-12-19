<template>
  <div class="avatar-mapping-panel" @drop.prevent="handleDrop" @dragover.prevent="handleDragOver" @dragenter.prevent="handleDragEnter" @dragleave.prevent="handleDragLeave">
    <div class="upload-area" :class="{ 'is-dragging': isDragging }">
      <div class="upload-icon">⬆</div>
      <p class="upload-title">拖拽上传模型文件</p>
      <p class="upload-sub">支持 glTF / GLB</p>
      <button type="button" class="ghost-btn" @click="triggerFileInput">选取文件</button>
      <input ref="fileInputRef" type="file" accept=".gltf,.glb" class="file-input" @change="handleFileChange" />
      <p class="upload-hint">上传后可自动识别骨骼，也可手动选择</p>
    </div>

    <div class="bones-section">
      <div class="section-title">骨骼列表 ({{ bonesSummary.length }})</div>
      <div class="bones-list">
        <div v-if="!bonesSummary.length" class="bone-empty">暂无模型，上传后显示</div>
        <div v-for="b in bonesSummary" :key="b.name" class="bone-item">{{ b.name }}</div>
      </div>
    </div>

    <div class="mapping-section">
      <div class="section-title">关节映射</div>
      <div class="mapping-list">
        <div v-for="joint in logicalJoints" :key="joint" class="mapping-row">
          <span class="joint-label">{{ joint }}</span>
          <select v-model="localMapping[joint]">
            <option value="">(未选择)</option>
            <option v-for="b in bonesSummary" :key="joint + b.name" :value="b.name">{{ b.name }}</option>
          </select>
        </div>
      </div>
      <div class="mapping-actions">
        <button type="button" class="ghost-btn" :disabled="!bonesSummary.length" @click="applyAutoSuggest">自动识别骨骼</button>
        <button type="button" class="primary" :disabled="!modelUrl" @click="emitConfirm">使用该模型</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { LOGICAL_JOINTS, createEmptyMapping } from './avatarTypes.js';
import { loadAvatarModel, summarizeBones, suggestMappingFromBones } from './avatarLoader.js';
import logger from '../utils/logger';

const emit = defineEmits([
  'confirm',
]);

const logicalJoints = LOGICAL_JOINTS;

const loading = ref(false);
const error = ref('');
const bonesSummary = ref([]);
const modelUrl = ref('');
const localMapping = ref(createEmptyMapping());
const lastLoaded = ref(null);
const lastFileData = ref(null);
const lastFileName = ref('');
const isDragging = ref(false);
const fileInputRef = ref(null);

function handleFileChange(event) {
  const file = event.target.files && event.target.files[0];
  processFile(file);
}

function triggerFileInput() {
  fileInputRef.value && fileInputRef.value.click();
}

function handleDragOver() {
  isDragging.value = true;
}

function handleDragEnter() {
  isDragging.value = true;
}

function handleDragLeave() {
  isDragging.value = false;
}

function handleDrop(event) {
  const file = event.dataTransfer?.files?.[0];
  isDragging.value = false;
  processFile(file);
}

async function processFile(file) {
  if (!file) return;
  error.value = '';
  loading.value = true;

  try {
    const arrayBuffer = await file.arrayBuffer();
    lastFileData.value = arrayBuffer;
    lastFileName.value = file.name;

    const url = URL.createObjectURL(file);
    const result = await loadAvatarModel(url);

    modelUrl.value = url;
    lastLoaded.value = result;
    bonesSummary.value = summarizeBones(result.bones);
    localMapping.value = createEmptyMapping();
  } catch (e) {
    logger.error('[AvatarMappingPanel] load error', e);
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
    fileData: lastFileData.value,
    fileName: lastFileName.value,
  });
}
</script>

<style scoped>
.avatar-mapping-panel {
  background: #0f172d;
  border-radius: 20px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 12px 30px rgba(15, 23, 45, 0.35);
}

.upload-area {
  border: 2px dashed rgba(255, 255, 255, 0.4);
  border-radius: 16px;
  padding: 20px;
  text-align: center;
  color: #e2e7ff;
  transition: border-color 0.2s ease, background 0.2s ease;
}

.upload-area.is-dragging {
  border-color: #5bb8ff;
  background: rgba(91, 184, 255, 0.06);
}

.upload-icon {
  font-size: 28px;
  margin-bottom: 8px;
}

.upload-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.upload-sub {
  margin: 4px 0 10px;
  font-size: 12px;
  color: #9fb4ea;
}

.file-input {
  display: none;
}

.ghost-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.5);
  color: #f0f5ff;
  padding: 8px 14px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.upload-hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: #95a6c9;
}

.bones-section,
.mapping-section {
  background: #11192f;
  border-radius: 16px;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.section-title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: #f1f5ff;
}

.bones-list {
  max-height: 140px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bone-item {
  padding: 6px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  color: #d9e5ff;
  font-size: 12px;
}

.bone-empty {
  font-size: 12px;
  color: #7b86a1;
  text-align: center;
}

.mapping-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mapping-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.joint-label {
  width: 110px;
  color: #cfd8ff;
}

.mapping-row select {
  flex: 1;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: #111f3d;
  color: #f4f8ff;
  font-size: 12px;
}

.mapping-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.ghost-btn.primary {
  border-color: #4b8fff;
  color: #4b8fff;
}

.primary {
  background: #2ea6ff;
  border-radius: 12px;
  border: none;
  padding: 8px 20px;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  box-shadow: 0 8px 18px rgba(46, 166, 255, 0.4);
}

.primary:disabled,
.ghost-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  box-shadow: none;
}

.primary:not(:disabled):hover,
.ghost-btn:not(:disabled):hover {
  transform: translateY(-1px);
}

.ghost-btn {
  transition: transform 0.15s ease;
}

@media (max-width: 800px) {
  .avatar-mapping-panel {
    border-radius: 16px;
    padding: 14px;
  }
}
</style>
