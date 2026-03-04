<template>
  <div class="config-page">
    <aside v-if="isDesktop" class="left-panel">
      <div class="panel-inner">
        <header class="panel-header">
          <h2>自定义模型关节映射</h2>
          <p>仅在 PC 浏览器中通过上传文件完成映射与保存</p>
        </header>
        <AvatarMappingPanel @confirm="onAvatarConfirm" />
      </div>
    </aside>

    <section class="right-panel">
      <div class="right-card">
        <div class="card-head">
          <div class="badge">Avatar 配置</div>
          <p>方式 A：选择我们的预设机器人，方式 B：在 PC 端上传您自己的模型。</p>
        </div>

        <div class="preset-section">
          <div class="section-title">预设机器人预览</div>
          <div class="preset-preview">
            <div class="preset-image">
              <img v-if="selectedPresetImage" :src="selectedPresetImage" :alt="selectedPreset?.name" />
              <div v-else class="preset-image-placeholder">选择预设后会显示模型预览</div>
            </div>
            <p class="preset-desc">选取下方提供的预设机器人供 VR 头显快速体验。</p>
            <div class="preset-actions">
              <select v-model="selectedPresetId" class="preset-select">
                <option disabled value="">请选择一个 Avatar</option>
                <option v-for="p in presets" :key="p.id" :value="p.id">
                  {{ p.name }}
                </option>
              </select>
              <button type="button" class="primary" :disabled="!selectedPresetId" @click="applyPreset">使用此预设</button>
            </div>
          </div>
        </div>

        <div class="custom-section">
          <div class="section-title">自定义模型（PC 浏览器）</div>
          <p class="custom-desc">请在 PC 浏览器中上传 GLTF/GLB，完成关节映射后即可进入 VR 控制页面。</p>
          <button
            type="button"
            :class="canEnterVR ? 'primary' : 'secondary'"
            :disabled="!canEnterVR"
            @click="goToVR"
          >进入 VR 控制</button>
          <p v-if="!lastConfig" class="note">请先选择预设，或在左侧上传并点击「使用该模型」。</p>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import AvatarMappingPanel from './customAvatar/AvatarMappingPanel.vue';
import { saveCustomAvatarFile, clearCustomAvatarFile } from './utils/avatarStorage.js';
import logger from './utils/logger';

const AVATAR_CONFIG_KEY = 'vr_avatar_config_v1';

const lastConfig = ref(null);
const presets = ref([]);
const presetsLoading = ref(false);
const presetsError = ref('');
const selectedPresetId = ref('');
const canEnterVR = ref(false);

const PRESET_IMAGE_MAP = {
  default: '/robots/RobotExpressive.png',
  lowpoly: '/robots/low_ploy_robot.png',
};

const selectedPreset = computed(() => presets.value.find((p) => p.id === selectedPresetId.value) || null);
const selectedPresetImage = computed(() => PRESET_IMAGE_MAP[selectedPresetId.value] || '');

// 简单判断当前是否为桌面浏览器，用于决定是否展示本地上传入口
const isDesktop = window && window.navigator
  ? !/android|iphone|ipad|quest|vr|headset/i.test(window.navigator.userAgent)
  : true;

function applyPreset() {
  const preset = presets.value.find((p) => p.id === selectedPresetId.value);
  if (!preset) return;

  const stored = {
    presetId: preset.id,
    modelUrl: preset.modelUrl,
    mapping: preset.mapping || {},
    meta: {
      savedAt: Date.now(),
      source: 'preset',
    },
  };

  try {
    localStorage.setItem(AVATAR_CONFIG_KEY, JSON.stringify(stored));
  lastConfig.value = stored;
  logger.info('[ConfigApp] preset avatar saved to localStorage', stored);
    // 使用预设时，清除之前可能存储的自定义模型文件
    clearCustomAvatarFile().catch(() => {});
  } catch (e) {
    logger.error('[ConfigApp] Failed to save preset avatar config', e);
  }
  canEnterVR.value = true;
}

async function onAvatarConfirm(payload) {
  // 1. 把原始模型文件存入 IndexedDB（支持大文件）
  if (payload.fileData && payload.fileName) {
    try {
      await saveCustomAvatarFile(payload.fileData, payload.fileName);
      logger.info('[ConfigApp] Custom avatar file saved to IndexedDB');
    } catch (e) {
      logger.error('[ConfigApp] Failed to save file to IndexedDB', e);
      alert('保存模型文件失败，请重试');
      return;
    }
  }

  // 2. localStorage 只存映射和元信息（不存文件数据）
  const stored = {
    // 标记这是自定义上传的模型
    source: 'custom',
    fileName: payload.fileName || 'custom.glb',
    mapping: payload.mapping || {},
    meta: {
      savedAt: Date.now(),
    },
  };

  try {
    localStorage.setItem(AVATAR_CONFIG_KEY, JSON.stringify(stored));
    lastConfig.value = stored;
    logger.info('[ConfigApp] Custom avatar config saved to localStorage', stored);
    canEnterVR.value = true;
  } catch (e) {
    logger.error('[ConfigApp] Failed to save avatar config', e);
  }
}

function goToVR() {
  // 跳转到主 VR 控制页面（当前入口的根路径）
  window.location.href = '/';
}

onMounted(() => {
  // 加载服务器预设列表
  presetsLoading.value = true;
  fetch('/avatars.json')
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then((data) => {
      presets.value = Array.isArray(data) ? data : [];
    })
    .catch((e) => {
      logger.error('[ConfigApp] Failed to load avatars.json', e);
      presetsError.value = '预设列表加载失败';
    })
    .finally(() => {
      presetsLoading.value = false;
    });

  // 如果本地已经有配置，读出来以便按钮可用
  try {
    const raw = localStorage.getItem(AVATAR_CONFIG_KEY);
    if (raw) {
      lastConfig.value = JSON.parse(raw);
    }
  } catch (e) {
    logger.warn('[ConfigApp] Failed to read existing avatar config', e);
  }
});
</script>

<style scoped>
  :global(body) {
    margin: 0;
    min-height: 100vh;
    background-image: linear-gradient(180deg, rgba(3, 10, 23, 0.7) 0%, rgba(6, 12, 28, 0.8) 60%, rgba(3, 10, 23, 0.95) 100%),
      url(/backgrounds/Config-bg.png);
    background-size: cover;
    background-position: center;
  }

  .config-page {
    min-height: 100vh;
    width: 100%;
    padding: 40px clamp(24px, 6vw, 72px);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    gap: 28px;
    box-sizing: border-box;
    color: #e8f0ff;
  }

.left-panel {
  width: 340px;
  background: rgba(9, 14, 32, 0.8);
  border-radius: 28px;
  box-shadow: 0 30px 70px rgba(4, 13, 37, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.07);
  padding: 22px;
  backdrop-filter: blur(24px);
}

.panel-inner {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.panel-header h2 {
  margin: 0;
  font-size: 20px;
  color: #f3f7ff;
}

.panel-header p {
  margin: 6px 0 0;
  font-size: 12px;
  color: #9cb1d4;
}

.right-panel {
  flex: 1;
  max-width: 560px;
}

.right-card {
  background: rgba(12, 23, 50, 0.85);
  border-radius: 30px;
  padding: 32px;
  box-shadow: 0 30px 70px rgba(8, 17, 48, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  flex-direction: column;
  gap: 26px;
}

.card-head {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 20px;
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.badge {
  font-size: 20px;
  font-weight: 700;
  color: #fefefe;
}

.card-head p {
  margin: 10px 0 0;
  font-size: 14px;
  color: #c5d9ff;
  line-height: 1.6;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #f6fbff;
  margin-bottom: 12px;
}

.preset-section,
.custom-section {
  border-radius: 22px;
  padding: 20px;
  background: rgba(5, 10, 28, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.preset-preview {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.preset-image {
  height: 320px;
  width: min(240px, 100%);
  margin: 0 auto;
  border-radius: 20px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(22, 30, 58, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
}

.preset-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.preset-image-placeholder {
  color: #9cb1d3;
  font-size: 12px;
  text-align: center;
  padding: 0 12px;
  line-height: 1.4;
}

.preset-desc,
.custom-desc {
  margin: 0;
  color: #b8c7e3;
  font-size: 13px;
  line-height: 1.6;
}

.preset-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.preset-select {
  width: 100%;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(3, 5, 16, 0.9);
  font-size: 14px;
  color: #edf2ff;
}

button.primary,
button.secondary {
  border-radius: 14px;
  border: none;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  padding: 14px 20px;
  transition: transform 0.15s ease, opacity 0.15s ease;
}

button.primary {
  background: linear-gradient(135deg, #5bc3ff, #2b8dff);
  color: #021228;
  box-shadow: 0 14px 28px rgba(43, 141, 255, 0.4);
}

button.secondary {
  background: rgba(255, 255, 255, 0.08);
  color: #e5edff;
  border: 1px solid rgba(255, 255, 255, 0.2);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}

button:not(:disabled):hover { transform: translateY(-2px); }

.note {
  margin: 10px 0 0;
  font-size: 12px;
  color: #95a2c0;
}

@media (max-width: 1100px) {
  .config-page {
    flex-direction: column;
    align-items: center;
    padding: 32px 24px;
  }
  .left-panel,
  .right-panel {
    width: 100%;
    max-width: 720px;
  }
}

@media (max-width: 640px) {
  .right-card {
    padding: 20px;
  }
  .preset-actions { gap: 8px; }
  .left-panel {
    width: 100%;
    padding: 18px;
  }
}
</style>
