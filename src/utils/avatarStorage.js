/**
 * IndexedDB 封装：用于存储用户上传的自定义 Avatar 模型文件
 * 
 * 为什么用 IndexedDB 而不是 localStorage？
 * - localStorage 有大小限制（通常 5-10MB），且只能存字符串
 * - IndexedDB 可以存储大型二进制数据（ArrayBuffer / Blob），适合 GLB 文件
 * 
 * 数据库结构：
 * - 数据库名：VRAvatarDB
 * - 对象存储：avatarFiles
 * - 主键：id（固定为 'custom' 表示当前自定义模型）
 */

const DB_NAME = 'VRAvatarDB';
const DB_VERSION = 1;
const STORE_NAME = 'avatarFiles';

let dbPromise = null;

/**
 * 打开/初始化数据库
 */
function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[AvatarStorage] Failed to open IndexedDB', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        console.log('[AvatarStorage] Created object store:', STORE_NAME);
      }
    };
  });

  return dbPromise;
}

/**
 * 保存自定义模型文件到 IndexedDB
 * @param {ArrayBuffer} fileData - 模型文件的二进制数据
 * @param {string} fileName - 原始文件名（用于确定 MIME 类型）
 * @returns {Promise<void>}
 */
export async function saveCustomAvatarFile(fileData, fileName) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const record = {
      id: 'custom',
      fileData,
      fileName,
      savedAt: Date.now(),
    };

    const request = store.put(record);

    request.onsuccess = () => {
      console.log('[AvatarStorage] Saved custom avatar file:', fileName, 'size:', fileData.byteLength);
      resolve();
    };

    request.onerror = () => {
      console.error('[AvatarStorage] Failed to save file', request.error);
      reject(request.error);
    };
  });
}

/**
 * 从 IndexedDB 读取自定义模型文件
 * @returns {Promise<{fileData: ArrayBuffer, fileName: string, savedAt: number} | null>}
 */
export async function loadCustomAvatarFile() {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get('custom');

    request.onsuccess = () => {
      const record = request.result;
      if (record) {
        console.log('[AvatarStorage] Loaded custom avatar file:', record.fileName, 'size:', record.fileData.byteLength);
        resolve(record);
      } else {
        resolve(null);
      }
    };

    request.onerror = () => {
      console.error('[AvatarStorage] Failed to load file', request.error);
      reject(request.error);
    };
  });
}

/**
 * 删除 IndexedDB 中的自定义模型文件
 * @returns {Promise<void>}
 */
export async function clearCustomAvatarFile() {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete('custom');

    request.onsuccess = () => {
      console.log('[AvatarStorage] Cleared custom avatar file');
      resolve();
    };

    request.onerror = () => {
      console.error('[AvatarStorage] Failed to clear file', request.error);
      reject(request.error);
    };
  });
}

/**
 * 将 ArrayBuffer 转换为可用于 GLTFLoader 的 blob URL
 * @param {ArrayBuffer} fileData 
 * @param {string} fileName 
 * @returns {string} blob URL
 */
export function createBlobUrlFromArrayBuffer(fileData, fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase() || 'glb';
  const mimeType = ext === 'gltf' ? 'model/gltf+json' : 'model/gltf-binary';
  const blob = new Blob([fileData], { type: mimeType });
  return URL.createObjectURL(blob);
}
