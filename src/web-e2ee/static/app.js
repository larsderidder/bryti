import {
  loadDevicePrivateKey,
  loadPairedState,
  loadUiPrefs,
  saveDeviceKeyPair,
  savePairedState,
  saveUiPrefs,
} from "./idb.js";

const HKDF_CONTEXT_LABEL = new TextEncoder().encode("bryti/web_e2ee/v1");
const HKDF_INFO_C2S = new TextEncoder().encode("bryti/web_e2ee/v1/c2s");
const HKDF_INFO_S2C = new TextEncoder().encode("bryti/web_e2ee/v1/s2c");

const appShellEl = document.getElementById("app-shell");
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
const recordStartEl = document.getElementById("record-start");
const recordStopEl = document.getElementById("record-stop");
const recordingStatusEl = document.getElementById("recording-status");
const chatLogEl = document.getElementById("chat-log");
const chatClearEl = document.getElementById("chat-clear");
const autoPlayVoiceRepliesEl = document.getElementById("auto-play-voice-replies");

const appState = {
  serverInfo: null,
  pairedState: null,
  devicePrivateKey: null,
  derivedKeys: null,
  ws: null,
  wsConnected: false,
  sendingText: false,
  sendingAudio: false,
  mediaRecorder: null,
  mediaStream: null,
  recordingChunks: [],
  recordingMimeType: "",
  recordingStartedAt: 0,
  recordingStopTimer: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  reconnectGeneration: 0,
  assistantAudioObjectUrls: new Set(),
  uiPrefs: {
    autoPlayVoiceReplies: false,
  },
};

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const WEB_E2EE_MAX_AUDIO_DURATION_SECONDS = 60;
const WEB_E2EE_MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const WEB_E2EE_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg",
  "audio/opus",
];
const BIND_ERROR_CODES = new Set(["invalid_frame", "unknown_device", "revoked_device", "replay_detected", "decrypt_failed"]);

function syncPairedLayout() {
  appShellEl.classList.toggle("paired", !!appState.pairedState);
}

function supportsRequiredCrypto() {
  return !!(
    window.indexedDB &&
    window.crypto?.subtle &&
    typeof CryptoKey !== "undefined"
  );
}

function supportsMediaRecorder() {
  return !!(
    navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

function supportedRecordingMimeType() {
  if (!supportsMediaRecorder()) {
    return "";
  }
  for (const mimeType of WEB_E2EE_AUDIO_MIME_TYPES) {
    if (typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return "";
}

function resizeChatInput() {
  chatInputEl.style.height = "auto";
  const maxHeight = Number.parseFloat(window.getComputedStyle(chatInputEl).maxHeight);
  const contentHeight = chatInputEl.scrollHeight;
  const nextHeight = Number.isFinite(maxHeight)
    ? Math.min(contentHeight, maxHeight)
    : contentHeight;
  chatInputEl.style.height = `${nextHeight}px`;
  chatInputEl.style.overflowY = Number.isFinite(maxHeight) && contentHeight > maxHeight ? "auto" : "hidden";
}

function updateChatAvailability() {
  const connected = !!(
    appState.pairedState &&
    appState.devicePrivateKey &&
    appState.wsConnected &&
    appState.derivedKeys
  );
  const textEnabled = connected && !appState.sendingText && !appState.sendingAudio && !appState.mediaRecorder;
  const audioSupported = !!supportedRecordingMimeType();
  const canStartRecording = connected && audioSupported && !appState.sendingText && !appState.sendingAudio && !appState.mediaRecorder;
  const canStopRecording = !!appState.mediaRecorder;

  chatInputEl.disabled = !textEnabled;
  chatSendEl.disabled = !textEnabled;
  recordStartEl.disabled = !canStartRecording;
  recordStopEl.disabled = !canStopRecording;
  chatInputEl.placeholder = textEnabled
    ? "Send encrypted text to Bryti"
    : "Pair and connect to enable encrypted outbound text";
  if (!audioSupported) {
    recordingStatusEl.textContent = "Browser audio input is unavailable in this browser.";
  }
  if (recordStartEl.disabled) {
    recordStartEl.classList.remove("voice-ready-highlight");
  }
  syncPairedLayout();
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

function appendChatMessage(role, text) {
  const line = document.createElement("p");
  line.className = `chat-line chat-line-${role}`;
  line.textContent = `${role === "user" ? "You" : "Bryti"}: ${text}`;
  chatLogEl.append(line);
}

function trackAssistantAudioObjectUrl(objectUrl) {
  appState.assistantAudioObjectUrls.add(objectUrl);
}

function revokeAssistantAudioObjectUrls() {
  for (const objectUrl of appState.assistantAudioObjectUrls) {
    URL.revokeObjectURL(objectUrl);
  }
  appState.assistantAudioObjectUrls.clear();
}

function clearLocalChat() {
  revokeAssistantAudioObjectUrls();
  chatLogEl.replaceChildren();
}

function clearVoiceReadyHighlight() {
  recordStartEl.classList.remove("voice-ready-highlight");
}

function applyVoiceReadyHighlight() {
  clearVoiceReadyHighlight();
  if (recordStartEl.disabled) {
    return;
  }
  recordStartEl.classList.add("voice-ready-highlight");
  window.setTimeout(() => {
    recordStartEl.classList.remove("voice-ready-highlight");
  }, 2200);
}

function setVoiceReadyStatus() {
  recordingStatusEl.textContent = "Reply finished. Ready for your next voice message.";
  if (!recordStopEl.disabled) {
    recordStopEl.disabled = true;
  }
  applyVoiceReadyHighlight();
}

function appendAssistantAudioMessage(objectUrl) {
  const line = document.createElement("div");
  line.className = "chat-line chat-line-assistant chat-line-audio";

  const label = document.createElement("div");
  label.className = "chat-audio-label";
  label.textContent = "Bryti: [Voice reply]";

  const status = document.createElement("div");
  status.className = "chat-audio-status";
  status.textContent = "Tap Play to listen.";

  const player = document.createElement("audio");
  player.className = "chat-audio-player";
  player.controls = true;
  player.preload = "none";
  player.src = objectUrl;

  let playbackEnded = false;
  player.addEventListener("play", () => {
    playbackEnded = false;
    clearVoiceReadyHighlight();
  });
  player.addEventListener("ended", () => {
    playbackEnded = true;
    setVoiceReadyStatus();
  });
  player.addEventListener("pause", () => {
    if (!playbackEnded) {
      clearVoiceReadyHighlight();
    }
  });
  player.addEventListener("error", () => {
    recordingStatusEl.textContent = "Could not play voice reply. Use the audio control or send text.";
    clearVoiceReadyHighlight();
  });

  line.append(label, status, player);
  chatLogEl.append(line);
  return { player, status };
}

function stopRecordingStream() {
  if (appState.mediaStream) {
    for (const track of appState.mediaStream.getTracks()) {
      track.stop();
    }
    appState.mediaStream = null;
  }
}

function clearRecordingStopTimer() {
  if (appState.recordingStopTimer) {
    clearTimeout(appState.recordingStopTimer);
    appState.recordingStopTimer = null;
  }
}

function resetRecordingState() {
  clearRecordingStopTimer();
  stopRecordingStream();
  appState.mediaRecorder = null;
  appState.recordingChunks = [];
  appState.recordingStartedAt = 0;
  appState.recordingMimeType = "";
}

function base64ToBytes(text) {
  if (typeof text !== "string" || !text) {
    throw new Error("Encrypted audio payload is empty");
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function assertValidInboundPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid encrypted payload");
  }
  if (payload.kind === "text") {
    if (typeof payload.text !== "string") {
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
  if (payload.kind === "audio") {
    if (typeof payload.mimeType !== "string" || !WEB_E2EE_AUDIO_MIME_TYPES.includes(payload.mimeType)) {
      throw new Error("Invalid encrypted audio payload mimeType");
    }
    if (typeof payload.dataBase64 !== "string" || !payload.dataBase64) {
      throw new Error("Encrypted audio payload is empty");
    }
    const bytes = base64ToBytes(payload.dataBase64);
    if (!(bytes.byteLength > 0)) {
      throw new Error("Encrypted audio payload is empty");
    }
    if (bytes.byteLength > WEB_E2EE_MAX_AUDIO_BYTES) {
      throw new Error(`Encrypted audio payload exceeds ${WEB_E2EE_MAX_AUDIO_BYTES} bytes`);
    }
    if (payload.durationSeconds !== undefined && typeof payload.durationSeconds !== "number") {
      throw new Error("Invalid encrypted audio payload durationSeconds");
    }
    if (payload.fileName !== undefined && typeof payload.fileName !== "string") {
      throw new Error("Invalid encrypted audio payload fileName");
    }
    return {
      kind: "audio",
      mimeType: payload.mimeType,
      dataBase64: payload.dataBase64,
      durationSeconds: payload.durationSeconds,
      fileName: payload.fileName,
      bytes,
    };
  }
  throw new Error("Invalid encrypted payload");
}

async function decryptInboundFramePayload(s2cKey, frame) {
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
  return assertValidInboundPayload(payload);
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

async function restoreUiPrefs() {
  const uiPrefs = await loadUiPrefs();
  appState.uiPrefs = {
    autoPlayVoiceReplies: !!uiPrefs?.autoPlayVoiceReplies,
  };
  if (autoPlayVoiceRepliesEl) {
    autoPlayVoiceRepliesEl.checked = appState.uiPrefs.autoPlayVoiceReplies;
  }
}

async function setAutoPlayVoiceReplies(enabled) {
  const nextPrefs = {
    autoPlayVoiceReplies: !!enabled,
  };
  appState.uiPrefs = nextPrefs;
  if (autoPlayVoiceRepliesEl) {
    autoPlayVoiceRepliesEl.checked = nextPrefs.autoPlayVoiceReplies;
  }
  await saveUiPrefs(nextPrefs);
}

async function restorePairedState() {
  const state = await loadPairedState();
  const privateKey = await loadDevicePrivateKey();
  if (!state || !privateKey) {
    pairingStatusEl.textContent = "Not paired";
    syncPairedLayout();
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
  syncPairedLayout();
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

  const payload = await decryptInboundFramePayload(appState.derivedKeys.s2cKey, validFrame);
  const nextState = {
    ...appState.pairedState,
    lastInboundCounter: validFrame.counter,
  };
  await savePairedState(nextState);
  appState.pairedState = nextState;

  if (payload.kind === "text") {
    appendChatMessage("assistant", payload.text);
    return;
  }

  const objectUrl = URL.createObjectURL(new Blob([payload.bytes], { type: payload.mimeType }));
  trackAssistantAudioObjectUrl(objectUrl);
  const { player, status } = appendAssistantAudioMessage(objectUrl);
  if (!appState.uiPrefs.autoPlayVoiceReplies) {
    return;
  }
  try {
    await player.play();
    status.textContent = "Auto-played.";
  } catch {
    status.textContent = "Auto-play was blocked. Tap Play.";
  }
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

    pairingStatusEl.textContent = `Paired as ${body.deviceId}`;
    pairingMessageEl.textContent = `Paired successfully. Server fingerprint: ${body.serverPublicFingerprint}`;
    serverFingerprintEl.textContent = body.serverPublicFingerprint || info.serverPublicFingerprint || "Unavailable";
    syncPairedLayout();
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
    await sendReservedEncryptedFrame("msg", { kind: "text", text });
    chatInputEl.value = "";
    resizeChatInput();
    appendChatMessage("user", text);
    pairingMessageEl.textContent = "Encrypted text roundtrip is enabled.";
  } catch (error) {
    pairingMessageEl.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    appState.sendingText = false;
    updateChatAvailability();
  }
}

function recordingDurationSeconds() {
  if (!appState.recordingStartedAt) {
    return 0;
  }
  return Math.max(1, Math.round((Date.now() - appState.recordingStartedAt) / 1000));
}

async function sendEncryptedAudioBlob(blob, durationSeconds, mimeType) {
  if (!appState.wsConnected) {
    throw new Error("Pair and connect before sending browser audio.");
  }
  if (!(blob.size > 0)) {
    throw new Error("Recorded audio is empty.");
  }
  if (blob.size > WEB_E2EE_MAX_AUDIO_BYTES) {
    throw new Error(`Recorded audio exceeds ${WEB_E2EE_MAX_AUDIO_BYTES} bytes.`);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await sendReservedEncryptedFrame("msg", {
    kind: "audio",
    mimeType,
    durationSeconds,
    dataBase64: bytesToBase64(bytes),
    fileName: `recording${mimeType.includes("ogg") ? ".ogg" : mimeType.includes("opus") ? ".opus" : ".webm"}`,
  });
}

async function startRecording() {
  if (appState.mediaRecorder || appState.sendingAudio) {
    return;
  }
  if (!supportsMediaRecorder()) {
    recordingStatusEl.textContent = "Browser audio input is unavailable in this browser.";
    return;
  }
  if (!appState.wsConnected || !appState.pairedState || !appState.derivedKeys) {
    pairingMessageEl.textContent = "Pair and connect before recording browser audio.";
    return;
  }

  const mimeType = supportedRecordingMimeType();
  if (!mimeType) {
    recordingStatusEl.textContent = "This browser does not support the allowed recording formats.";
    updateChatAvailability();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const recorder = new MediaRecorder(stream, { mimeType });
    appState.mediaStream = stream;
    appState.mediaRecorder = recorder;
    appState.recordingChunks = [];
    appState.recordingMimeType = mimeType;
    appState.recordingStartedAt = Date.now();
    recordingStatusEl.textContent = "Recording… tap Stop to send. Max 60 seconds.";
    clearRecordingStopTimer();
    appState.recordingStopTimer = window.setTimeout(() => {
      recordingStatusEl.textContent = "Recording stopped at 60 seconds. Sending…";
      void stopRecording();
    }, WEB_E2EE_MAX_AUDIO_DURATION_SECONDS * 1000);

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        appState.recordingChunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", () => {
      void (async () => {
        const chunks = appState.recordingChunks.slice();
        const durationSeconds = Math.min(recordingDurationSeconds(), WEB_E2EE_MAX_AUDIO_DURATION_SECONDS);
        const recordedMimeType = appState.recordingMimeType || mimeType;
        resetRecordingState();
        updateChatAvailability();
        if (chunks.length === 0) {
          recordingStatusEl.textContent = "No audio captured.";
          return;
        }

        appState.sendingAudio = true;
        updateChatAvailability();
        recordingStatusEl.textContent = "Sending recorded audio…";
        try {
          const blob = new Blob(chunks, { type: recordedMimeType });
          await sendEncryptedAudioBlob(blob, durationSeconds, recordedMimeType);
          appendChatMessage("user", `[Voice message: ${durationSeconds}s]`);
          recordingStatusEl.textContent = `Voice message sent (${durationSeconds}s).`;
          pairingMessageEl.textContent = "Encrypted text roundtrip is enabled.";
        } catch (error) {
          recordingStatusEl.textContent = error instanceof Error ? error.message : String(error);
          pairingMessageEl.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          appState.sendingAudio = false;
          updateChatAvailability();
        }
      })();
    });

    recorder.start();
    updateChatAvailability();
  } catch (error) {
    resetRecordingState();
    recordingStatusEl.textContent = error instanceof Error ? error.message : String(error);
    updateChatAvailability();
  }
}

async function stopRecording() {
  const recorder = appState.mediaRecorder;
  if (!recorder) {
    return;
  }
  clearRecordingStopTimer();
  if (recorder.state !== "inactive") {
    recorder.stop();
  }
  recordingStatusEl.textContent = "Stopping recording…";
  updateChatAvailability();
}

async function init() {
  syncPairedLayout();
  await restoreUiPrefs();
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
  }
  if (!supportsMediaRecorder()) {
    recordingStatusEl.textContent = "Browser audio input requires MediaRecorder microphone support.";
  } else if (!supportedRecordingMimeType()) {
    recordingStatusEl.textContent = "This browser does not support the allowed recording formats.";
  }
  updateChatAvailability();

  pairButtonEl.addEventListener("click", () => {
    void pairDevice(info);
  });
  chatSendEl.addEventListener("click", () => {
    void sendEncryptedText();
  });
  recordStartEl.addEventListener("click", () => {
    void startRecording();
  });
  recordStopEl.addEventListener("click", () => {
    void stopRecording();
  });
  chatClearEl?.addEventListener("click", () => {
    clearLocalChat();
  });
  autoPlayVoiceRepliesEl?.addEventListener("change", () => {
    void setAutoPlayVoiceReplies(autoPlayVoiceRepliesEl.checked);
  });
  chatInputEl.addEventListener("input", () => {
    resizeChatInput();
  });
  chatInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !chatSendEl.disabled) {
      event.preventDefault();
      void sendEncryptedText();
    }
  });
  resizeChatInput();
}

window.addEventListener("beforeunload", () => {
  revokeAssistantAudioObjectUrls();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

void init();
