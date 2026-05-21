const DB_NAME = "bryti-web-e2ee";
const DB_VERSION = 2;
const PAIRED_STATE_STORE = "pairedState";
const CRYPTO_KEYS_STORE = "cryptoKeys";
const MESSAGES_STORE = "messages";
const MESSAGE_HISTORY_LIMIT = 100;

export function openWebE2EEDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAIRED_STATE_STORE)) {
        db.createObjectStore(PAIRED_STATE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(CRYPTO_KEYS_STORE)) {
        db.createObjectStore(CRYPTO_KEYS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        db.createObjectStore(MESSAGES_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
  });
}

async function put(storeName, value) {
  const db = await openWebE2EEDatabase();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`Failed to write ${storeName}`));
  });
}

async function get(storeName, key) {
  const db = await openWebE2EEDatabase();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error(`Failed to read ${storeName}`));
  });
}

export async function loadPairedState() {
  return await get(PAIRED_STATE_STORE, "primary");
}

export async function savePairedState(state) {
  await put(PAIRED_STATE_STORE, { ...state, id: "primary" });
}

export async function saveDeviceKeyPair({ privateKey, publicKey }) {
  await put(CRYPTO_KEYS_STORE, { id: "devicePrivateKey", key: privateKey });
  await put(CRYPTO_KEYS_STORE, { id: "devicePublicKey", key: publicKey });
}

export async function loadDevicePrivateKey() {
  const record = await get(CRYPTO_KEYS_STORE, "devicePrivateKey");
  return record?.key || null;
}

export async function loadRecentMessages() {
  const db = await openWebE2EEDatabase();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE, "readonly");
    const request = tx.objectStore(MESSAGES_STORE).getAll();
    request.onsuccess = () => {
      const messages = Array.isArray(request.result) ? request.result : [];
      messages.sort((left, right) => {
        if (left.createdAt === right.createdAt) {
          return String(left.id).localeCompare(String(right.id));
        }
        return String(left.createdAt).localeCompare(String(right.createdAt));
      });
      resolve(messages.slice(-MESSAGE_HISTORY_LIMIT));
    };
    request.onerror = () => reject(request.error || new Error("Failed to read messages"));
  });
}

export async function appendLocalMessage(message) {
  const db = await openWebE2EEDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE, "readwrite");
    const store = tx.objectStore(MESSAGES_STORE);
    store.put(message);
    const allRequest = store.getAll();
    allRequest.onsuccess = () => {
      const messages = Array.isArray(allRequest.result) ? allRequest.result : [];
      messages.sort((left, right) => {
        if (left.createdAt === right.createdAt) {
          return String(left.id).localeCompare(String(right.id));
        }
        return String(left.createdAt).localeCompare(String(right.createdAt));
      });
      const overflow = messages.length - MESSAGE_HISTORY_LIMIT;
      if (overflow > 0) {
        for (const stale of messages.slice(0, overflow)) {
          store.delete(stale.id);
        }
      }
    };
    allRequest.onerror = () => reject(allRequest.error || new Error("Failed to trim messages"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to write messages"));
  });
}

export async function clearLocalMessages() {
  const db = await openWebE2EEDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE, "readwrite");
    tx.objectStore(MESSAGES_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to clear messages"));
  });
}

export async function clearPairedState() {
  const db = await openWebE2EEDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([PAIRED_STATE_STORE, CRYPTO_KEYS_STORE], "readwrite");
    tx.objectStore(PAIRED_STATE_STORE).delete("primary");
    tx.objectStore(CRYPTO_KEYS_STORE).delete("devicePrivateKey");
    tx.objectStore(CRYPTO_KEYS_STORE).delete("devicePublicKey");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to clear paired state"));
  });
}
