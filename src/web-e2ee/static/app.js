import {
  appendLocalMessage,
  clearLocalMessages,
  loadDevicePrivateKey,
  loadPairedState,
  loadRecentMessages,
  saveDeviceKeyPair,
  savePairedState,
} from "./idb.js";

const HKDF_CONTEXT_LABEL = new TextEncoder().encode("bryti/web_e2ee/v1");
const HKDF_INFO_C2S = new TextEncoder().encode("bryti/web_e2ee/v1/c2s");
const HKDF_INFO_S2C = new TextEncoder().encode("bryti/web_e2ee/v1/s2c");

const httpStatusEl = document.getElementById("http-status");
const wsStatusEl = document.getElementById("ws-status");
const serverFingerprintEl = document.getElementById("server-fingerprint");
const protocolVersionEl = document.getElementById("protocol-version");
const pairingStatusEl = document.getElementById("pairing-status");
const pairingMessageEl = document.getElementById("pairing-message");
const deviceLabelEl = document.getElementById("device-label");
const inviteCodeEl = document.getElementById("invite-code");
const pairButtonEl = document.getElementById("pair-button");
const chatInputEl = document.getElementById("chat-input");
const chatSendEl = document.getElementById("chat-send");
const chatLogEl = document.getElementById("chat-log");
const clearChatButtonEl = document.getElementById("clear-chat-button");

const appState = {
  serverInfo: null,
  pairedState: null,
  devicePrivateKey: null,
  derivedKeys: null,
  ws: null,
  wsConnected: false,
  sendingText: false,
  reconnectTimer: null,
  reconnectAttempts: 0,
  reconnectGeneration: 0,
};

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const BIND_ERROR_CODES = new Set(["invalid_frame", "unknown_device", "revoked_device", "replay_detected", "decrypt_failed"]);

function supportsRequiredCrypto() {
  return !!(
    window.indexedDB &&
    window.crypto?.subtle &&
    typeof CryptoKey !== "undefined"
  );
}

function updateAppLayout() {
  document.body.classList.toggle("app-state-paired", !!appState.pairedState);
  document.body.classList.toggle("app-state-unpaired", !appState.pairedState);
}

function updateClearChatAvailability() {
  clearChatButtonEl.disabled = !appState.pairedState;
}

function updateChatAvailability() {
  const enabled = !!(
    appState.pairedState &&
    appState.devicePrivateKey &&
    appState.wsConnected &&
    appState.derivedKeys &&
    !appState.sendingText
  );
  chatInputEl.disabled = !enabled;
  chatSendEl.disabled = !enabled;
  chatInputEl.placeholder = enabled
    ? "Send encrypted text to Bryti"
    : appState.pairedState
      ? "Waiting for encrypted transport to reconnect"
      : "Pair and connect to enable encrypted outbound text";
  updateClearChatAvailability();
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomBase64Url(byteLength) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function concatBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function canonicalHeader(frame) {
  return JSON.stringify({
    v: frame.v,
    kind: frame.kind,
    deviceId: frame.deviceId,
    messageId: frame.messageId,
    counter: frame.counter,
    ts: frame.ts,
    nonce: frame.nonce,
  });
}

function scrollChatToBottom() {
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function renderEmptyChatState() {
  chatLogEl.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "chat-log-empty";
  empty.textContent = appState.pairedState
    ? "Local chat history will appear here on this device."
    : "Pair this browser to start encrypted chat.";
  chatLogEl.append(empty);
}

function appendChatMessage(role, text) {
  const empty = chatLogEl.querySelector(".chat-log-empty");
  if (empty) {
    empty.remove();
  }

  const line = document.createElement("article");
  line.className = `chat-line chat-line-${role}`;

  const label = document.createElement("span");
  label.className = "chat-line-label";
  label.textContent = role === "user" ? "You" : "Bryti";

  const body = document.createElement("p");
  body.textContent = text;
  body.style.margin = "0";

  line.append(label, body);
  chatLogEl.append(line);
  scrollChatToBottom();
}

async function loadChatHistory() {
  if (!appState.pairedState) {
    renderEmptyChatState();
    return;
  }

  const messages = await loadRecentMessages();
  if (!messages.length) {
    renderEmptyChatState();
    return;
  }

  chatLogEl.replaceChildren();
  for (const message of messages) {
    appendChatMessage(message.role, message.text);
  }
}

async function decryptTextFrame(s2cKey, frame) {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(frame.nonce),
      additionalData: new TextEncoder().encode(canonicalHeader(frame)),
    },
    s2cKey,
    base64UrlToBytes(frame.ciphertext),
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext));
  if (!payload || payload.kind !== "text" || typeof payload.text !== "string") {
    throw new Error("Invalid encrypted payload");
  }
  const trimmed = payload.text.trim();
  if (!trimmed) {
    throw new Error("Encrypted text payload is empty");
  }
  if (trimmed.length > 10_000) {
    throw new Error("Encrypted text payload exceeds 10000 characters");
  }
  return { kind: "text", text: payload.text };
}

function assertValidInboundFrame(frame) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    throw new Error("Invalid encrypted frame");
  }
  if (frame.v !== 1 || frame.kind !== "msg") {
    throw new Error("Invalid encrypted frame");
  }
  if (typeof frame.deviceId !== "string" || !frame.deviceId) {
    throw new Error("Invalid encrypted frame");
  }
  if (typeof frame.messageId !== "string" || !frame.messageId) {
    throw new Error("Invalid encrypted frame");
  }
  if (typeof frame.counter !== "number" || !Number.isInteger(frame.counter) || frame.counter <= 0) {
    throw new Error("Invalid encrypted frame");
  }
  if (typeof frame.ts !== "string" || !frame.ts) {
    throw new Error("Invalid encrypted frame");
  }
  if (typeof frame.nonce !== "string" || !frame.nonce) {
    throw new Error("Invalid encrypted frame");
  }
  if (typeof frame.ciphertext !== "string" || !frame.ciphertext) {
    throw new Error("Invalid encrypted frame");
  }
  return frame;
}

function webSocketUrl(pathPrefix) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const prefix = !pathPrefix || pathPrefix === "/"
    ? ""
    : pathPrefix.endsWith("/") ? pathPrefix.slice(0, -1) : pathPrefix;
  return `${protocol}//${window.location.host}${prefix}/ws`;
}

async function importServerPublicKey(jwk) {
  return await crypto.subtle.importKey("jwk", jwk, { name: "X25519" }, true, []);
}

function publicKeyJwkToRawBytes(jwk) {
  if (jwk?.kty !== "OKP" || jwk?.crv !== "X25519" || typeof jwk?.x !== "string") {
    throw new Error("Invalid X25519 public JWK");
  }
  return base64UrlToBytes(jwk.x);
}

async function deriveKeyContextSalt(serverPublicKeyJwk, devicePublicKeyJwk) {
  const context = concatBytes(
    HKDF_CONTEXT_LABEL,
    publicKeyJwkToRawBytes(serverPublicKeyJwk),
    publicKeyJwkToRawBytes(devicePublicKeyJwk),
  );
  return new Uint8Array(await crypto.subtle.digest("SHA-256", context));
}

async function deriveDirectionalKeys(devicePrivateKey, serverPublicKeyJwk, devicePublicKeyJwk) {
  const serverPublicKey = await importServerPublicKey(serverPublicKeyJwk);
  const secretBits = await crypto.subtle.deriveBits({ name: "X25519", public: serverPublicKey }, devicePrivateKey, 256);
  const salt = await deriveKeyContextSalt(serverPublicKeyJwk, devicePublicKeyJwk);
  const hkdfBaseKey = await crypto.subtle.importKey("raw", secretBits, "HKDF", false, ["deriveKey"]);
  const [c2sKey, s2cKey] = await Promise.all([
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: HKDF_INFO_C2S },
      hkdfBaseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: HKDF_INFO_S2C },
      hkdfBaseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
  ]);
  return { c2sKey, s2cKey };
}

async function encryptFrame(c2sKey, pairedState, kind, payload) {
  const frame = {
    v: 1,
    kind,
    deviceId: pairedState.deviceId,
    messageId: `msg_${randomBase64Url(12)}`,
    counter: pairedState.nextOutboundCounter,
    ts: new Date().toISOString(),
    nonce: randomBase64Url(12),
  };
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(frame.nonce),
      additionalData: new TextEncoder().encode(canonicalHeader(frame)),
    },
    c2sKey,
    plaintextBytes,
  );
  return {
    ...frame,
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

async function loadServerInfo() {
  try {
    const response = await fetch("api/server-info", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const info = await response.json();
    httpStatusEl.textContent = "Connected";
    serverFingerprintEl.textContent = info.serverPublicFingerprint || "Unavailable";
    protocolVersionEl.textContent = `v${info.protocolVersion} (${info.designVersion})`;
    appState.serverInfo = info;
    return info;
  } catch (error) {
    httpStatusEl.textContent = "Failed";
    serverFingerprintEl.textContent = "Unavailable";
    protocolVersionEl.textContent = "Unavailable";
    pairingMessageEl.textContent = `Could not load server info: ${error instanceof Error ? error.message : String(error)}`;
    return null;
  }
}

async function restorePairedState() {
  const state = await loadPairedState();
  const privateKey = await loadDevicePrivateKey();
  if (!state || !privateKey) {
    pairingStatusEl.textContent = "Not paired";
    updateAppLayout();
    renderEmptyChatState();
    return null;
  }

  appState.pairedState = state;
  appState.devicePrivateKey = privateKey;
  appState.derivedKeys = await deriveDirectionalKeys(privateKey, state.serverPublicKeyJwk, state.devicePublicKeyJwk);
  pairingStatusEl.textContent = `Paired as ${state.deviceId}`;
  pairingMessageEl.textContent = `Stored server fingerprint: ${state.serverPublicFingerprint}`;
  if (state.label) {
    deviceLabelEl.value = state.label;
  }
  updateAppLayout();
  await loadChatHistory();
  return state;
}

async function generateDeviceKeyPair() {
  // Chromium WebCrypto allows exporting the generated public key JWK while
  // keeping the private key non-extractable, which is the desired v1 behavior.
  return await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
}

async function handleInboundEncryptedFrame(frame) {
  if (!appState.pairedState || !appState.derivedKeys) {
    throw new Error("Paired state not available");
  }

  const validFrame = assertValidInboundFrame(frame);
  if (validFrame.deviceId !== appState.pairedState.deviceId) {
    throw new Error("Encrypted frame deviceId mismatch");
  }
  if (validFrame.counter <= appState.pairedState.lastInboundCounter) {
    throw new Error("Encrypted frame replay detected");
  }

  const payload = await decryptTextFrame(appState.derivedKeys.s2cKey, validFrame);
  const nextState = {
    ...appState.pairedState,
    lastInboundCounter: validFrame.counter,
  };
  await savePairedState(nextState);
  appState.pairedState = nextState;
  await appendLocalMessage({
    id: validFrame.messageId,
    role: "assistant",
    text: payload.text,
    createdAt: validFrame.ts,
  });
  appendChatMessage("assistant", payload.text);
}

function clearReconnectTimer() {
  if (appState.reconnectTimer) {
    clearTimeout(appState.reconnectTimer);
    appState.reconnectTimer = null;
  }
}

function scheduleReconnect(pathPrefix) {
  if (!appState.pairedState || appState.reconnectTimer) {
    return;
  }
  const delayMs = Math.min(
    RECONNECT_MIN_DELAY_MS * (2 ** Math.min(appState.reconnectAttempts, 4)),
    RECONNECT_MAX_DELAY_MS,
  );
  appState.reconnectAttempts += 1;
  appState.reconnectTimer = window.setTimeout(() => {
    appState.reconnectTimer = null;
    connectWebSocket(pathPrefix);
  }, delayMs);
}

async function sendReservedEncryptedFrame(kind, payload) {
  if (!appState.pairedState || !appState.derivedKeys || !appState.ws || appState.ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket is not connected");
  }

  const currentState = await loadPairedState();
  if (!currentState) {
    throw new Error("Paired state not found.");
  }

  const currentCounter = Number.isInteger(currentState.nextOutboundCounter)
    ? currentState.nextOutboundCounter
    : 1;
  const reservedState = {
    ...currentState,
    nextOutboundCounter: currentCounter + 1,
  };
  await savePairedState(reservedState);
  appState.pairedState = reservedState;

  const frame = await encryptFrame(appState.derivedKeys.c2sKey, {
    ...currentState,
    nextOutboundCounter: currentCounter,
  }, kind, payload);
  appState.ws.send(JSON.stringify(frame));
  return frame;
}

function connectWebSocket(pathPrefix) {
  if (!appState.pairedState) {
    return;
  }

  appState.reconnectGeneration += 1;
  const generation = appState.reconnectGeneration;
  clearReconnectTimer();

  if (appState.ws) {
    try {
      appState.ws.close();
    } catch {
      // ignore close failures
    }
  }

  const ws = new WebSocket(webSocketUrl(pathPrefix));
  appState.ws = ws;
  wsStatusEl.textContent = "Connecting";
  appState.wsConnected = false;
  updateChatAvailability();

  ws.addEventListener("open", () => {
    void (async () => {
      if (generation !== appState.reconnectGeneration || appState.ws !== ws) {
        return;
      }
      appState.wsConnected = true;
      wsStatusEl.textContent = "Connected";
      updateChatAvailability();
      try {
        await sendReservedEncryptedFrame("bind", { kind: "bind" });
        appState.reconnectAttempts = 0;
        pairingMessageEl.textContent = "Encrypted text roundtrip is enabled.";
      } catch (error) {
        pairingMessageEl.textContent = error instanceof Error ? error.message : String(error);
        try {
          ws.close();
        } catch {
          // ignore close failures
        }
      }
    })();
  });

  ws.addEventListener("message", (event) => {
    void (async () => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.kind === "hello") {
          wsStatusEl.textContent = "Connected";
          return;
        }
        if (payload.kind === "error") {
          pairingMessageEl.textContent = `Transport error: ${payload.code}`;
          if (BIND_ERROR_CODES.has(payload.code)) {
            appState.wsConnected = false;
            updateChatAvailability();
            try {
              ws.close();
            } catch {
              // ignore close failures
            }
          }
          return;
        }
        if (payload.kind === "msg") {
          await handleInboundEncryptedFrame(payload);
          pairingMessageEl.textContent = "Encrypted text roundtrip is enabled.";
          return;
        }
      } catch (error) {
        pairingMessageEl.textContent = error instanceof Error ? error.message : String(error);
      }
      wsStatusEl.textContent = "Connected";
    })();
  });

  ws.addEventListener("close", () => {
    if (appState.ws === ws) {
      appState.ws = null;
    }
    appState.wsConnected = false;
    wsStatusEl.textContent = "Closed";
    updateChatAvailability();
    if (generation === appState.reconnectGeneration && appState.pairedState) {
      scheduleReconnect(pathPrefix);
    }
  });

  ws.addEventListener("error", () => {
    appState.wsConnected = false;
    wsStatusEl.textContent = "Error";
    updateChatAvailability();
  });
}

async function pairDevice(info) {
  if (!supportsRequiredCrypto()) {
    pairingMessageEl.textContent = "This browser is not supported. Use a current Chromium-based browser.";
    return;
  }

  const label = deviceLabelEl.value.trim();
  const code = inviteCodeEl.value.trim();
  if (!label || !code) {
    pairingMessageEl.textContent = "Device label and invite code are required.";
    return;
  }

  pairButtonEl.disabled = true;
  pairingMessageEl.textContent = "Generating device keypair…";

  try {
    const keyPair = await generateDeviceKeyPair();
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

    pairingMessageEl.textContent = "Submitting pairing request…";
    const response = await fetch("api/pairing/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, label, publicKeyJwk }),
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }

    await saveDeviceKeyPair({ privateKey: keyPair.privateKey, publicKey: keyPair.publicKey });
    const pairedState = {
      deviceId: body.deviceId,
      label,
      protocolVersion: body.protocolVersion,
      pathPrefix: body.pathPrefix,
      serverPublicFingerprint: body.serverPublicFingerprint,
      serverPublicKeyJwk: body.serverPublicKeyJwk,
      devicePublicKeyJwk: publicKeyJwk,
      pairedAt: new Date().toISOString(),
      nextOutboundCounter: 1,
      lastInboundCounter: 0,
    };
    await savePairedState(pairedState);

    appState.pairedState = pairedState;
    appState.devicePrivateKey = keyPair.privateKey;
    appState.derivedKeys = await deriveDirectionalKeys(keyPair.privateKey, body.serverPublicKeyJwk, publicKeyJwk);

    updateAppLayout();
    await loadChatHistory();
    pairingStatusEl.textContent = `Paired as ${body.deviceId}`;
    pairingMessageEl.textContent = `Paired successfully. Server fingerprint: ${body.serverPublicFingerprint}`;
    serverFingerprintEl.textContent = body.serverPublicFingerprint || info.serverPublicFingerprint || "Unavailable";
    connectWebSocket(body.pathPrefix || info.pathPrefix);
  } catch (error) {
    pairingMessageEl.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    pairButtonEl.disabled = false;
    updateChatAvailability();
  }
}

async function sendEncryptedText() {
  if (appState.sendingText) {
    return;
  }
  if (!appState.pairedState || !appState.devicePrivateKey || !appState.derivedKeys || !appState.ws || !appState.wsConnected) {
    pairingMessageEl.textContent = "Pair and connect before sending encrypted text.";
    return;
  }

  const text = chatInputEl.value;
  if (!text.trim()) {
    pairingMessageEl.textContent = "Message text is required.";
    return;
  }

  appState.sendingText = true;
  updateChatAvailability();

  try {
    const frame = await sendReservedEncryptedFrame("msg", { kind: "text", text });
    await appendLocalMessage({
      id: frame.messageId,
      role: "user",
      text,
      createdAt: frame.ts,
    });
    chatInputEl.value = "";
    appendChatMessage("user", text);
    pairingMessageEl.textContent = "Encrypted text roundtrip is enabled.";
  } catch (error) {
    pairingMessageEl.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    appState.sendingText = false;
    updateChatAvailability();
  }
}

async function init() {
  if (!supportsRequiredCrypto()) {
    pairingMessageEl.textContent = "This browser is not supported. Use a current Chromium-based browser.";
    pairButtonEl.disabled = true;
    return;
  }

  const info = await loadServerInfo();
  if (!info) {
    pairButtonEl.disabled = true;
    return;
  }

  const restored = await restorePairedState();
  if (restored) {
    connectWebSocket(restored.pathPrefix || info.pathPrefix);
  } else {
    renderEmptyChatState();
  }
  updateChatAvailability();

  pairButtonEl.addEventListener("click", () => {
    void pairDevice(info);
  });
  chatSendEl.addEventListener("click", () => {
    void sendEncryptedText();
  });
  chatInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !chatSendEl.disabled) {
      event.preventDefault();
      void sendEncryptedText();
    }
  });
  clearChatButtonEl.addEventListener("click", () => {
    void (async () => {
      if (!appState.pairedState) {
        return;
      }
      const confirmed = window.confirm("Clear local chat history from this device only?");
      if (!confirmed) {
        return;
      }
      await clearLocalMessages();
      renderEmptyChatState();
      pairingMessageEl.textContent = "Local chat history cleared on this device.";
    })();
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

void init();
