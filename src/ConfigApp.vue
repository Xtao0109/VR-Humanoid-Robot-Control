<template>
  <div class="config-root">
    <h1 class="title">Avatar 配置</h1>
    <p class="hint">
      方式 A：在下方选择一个服务器预设的机器人模型，适合 VR 头显直接访问。<br />
      方式 B：在 PC 浏览器中，通过本地文件上传自定义模型并完成关节映射。
    </p>

    <!-- 预设 Avatar 选择（任何设备都可用，不依赖文件上传） -->
    <section class="section presets">
      <h2 class="section-title">预设机器人</h2>
      <div v-if="presetsLoading" class="status">正在加载预设列表...</div>
      <div v-else-if="presetsError" class="status error">{{ presetsError }}</div>
      <div v-else>
        <select v-model="selectedPresetId" class="select">
          <option disabled value="">请选择一个预设 Avatar</option>
          <option v-for="p in presets" :key="p.id" :value="p.id">
            {{ p.name }}
          </option>
        </select>
        <button
          type="button"
          class="primary"
          :disabled="!selectedPresetId"
          @click="applyPreset"
        >
          使用此预设
        </button>
      </div>
    </section>

    <!-- 高级：仅在 PC 浏览器中使用自定义模型上传（头显浏览器通常不支持文件选择） -->
    <section v-if="isDesktop" class="section custom-upload">
      <h2 class="section-title">自定义模型（PC 浏览器）</h2>
      <p class="hint small">
        仅推荐在 PC 浏览器中使用本地文件上传功能，头显浏览器通常无法正常弹出文件选择窗口。
      </p>
      <AvatarMappingPanel @confirm="onAvatarConfirm" />
    </section>

    <div class="footer">
      <button type="button" class="primary" :disabled="!lastConfig" @click="goToVR">
        进入 VR 控制
      </button>
      <span v-if="!lastConfig" class="note">请先选择一个预设，或在 PC 浏览器中上传并点击「使用该模型」</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AvatarMappingPanel from './customAvatar/AvatarMappingPanel.vue';
import { saveCustomAvatarFile, clearCustomAvatarFile } from './utils/avatarStorage.js';

const AVATAR_CONFIG_KEY = 'vr_avatar_config_v1';

const lastConfig = ref(null);
const presets = ref([]);
const presetsLoading = ref(false);
const presetsError = ref('');
const selectedPresetId = ref('');

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
    console.log('[ConfigApp] preset avatar saved to localStorage', stored);
    // 使用预设时，清除之前可能存储的自定义模型文件
    clearCustomAvatarFile().catch(() => {});
  } catch (e) {
    console.error('[ConfigApp] Failed to save preset avatar config', e);
  }
}

async function onAvatarConfirm(payload) {
  // 1. 把原始模型文件存入 IndexedDB（支持大文件）
  if (payload.fileData && payload.fileName) {
    try {
      await saveCustomAvatarFile(payload.fileData, payload.fileName);
      console.log('[ConfigApp] Custom avatar file saved to IndexedDB');
    } catch (e) {
      console.error('[ConfigApp] Failed to save file to IndexedDB', e);
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
    console.log('[ConfigApp] Custom avatar config saved to localStorage', stored);
  } catch (e) {
    console.error('[ConfigApp] Failed to save avatar config', e);
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
      console.error('[ConfigApp] Failed to load avatars.json', e);
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
    console.warn('[ConfigApp] Failed to read existing avatar config', e);
  }
});
</script>

<style scoped>
.config-root {
  box-sizing: border-box;
  padding: 16px;
  color: #fff;
  background: #000;
  min-height: 100vh;
}

.title {
  margin: 0 0 8px;
  font-size: 20px;
}

.hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: #ccc;
}

.footer {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

button.primary {
  padding: 6px 14px;
  border-radius: 4px;
  border: none;
  background: #2ecc71;
  color: #000;
  font-size: 14px;
  cursor: pointer;
}

button.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.note {
  font-size: 12px;
  color: #aaa;
}
</style>
