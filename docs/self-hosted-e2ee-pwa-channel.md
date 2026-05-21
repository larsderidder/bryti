# Self-hosted `web_e2ee` Bryti channel

Status: research/design

Branch context:
- This branch is based on `fix-node-llama-cpp-optional`.
- The current source tree has no source-level voice/audio channel support.
- Do not rely on stale `dist/` artefacts when planning or implementing this channel.

## 1. Goals and non-goals

### Goals
- Add a self-hosted Bryti-specific end-to-end encrypted web chat channel named `web_e2ee`.
- Keep encrypted payloads encrypted across the web transport; the WebSocket transport carries ciphertext only.
- Allow Bryti to decrypt locally on the self-hosted server because Bryti is the intended plaintext endpoint.
- Keep all plaintext away from external messaging providers.
- Roll our own minimal channel instead of adopting an unknown chat SDK.
- Prefer standard WebCrypto primitives if feasible in both browser and Node.
- Support text chat first.
- Keep audio and assistant voice mode explicitly out of the first implementation slices.
- Support manual / SSH-like pairing first.
- Defer QR pairing and passkeys.
- Keep the web app in this repository.
- Target Tailscale/local deployment first.
- Preserve a clean path to later VPS deployment.
- Allow `web_e2ee` to become the primary/default channel.
- Preserve Telegram and WhatsApp behavior unchanged for existing users.
- Remove hidden Telegram-specific defaults in internal routing so synthetic/system messages reach the correct channel.
- Avoid plaintext transport/channel logs by default.

### Non-goals for initial implementation
- No audio messages.
- No TTS/STT integration.
- No assistant voice mode.
- No multi-device sync design beyond what is minimally required.
- No passkeys.
- No QR onboarding.
- No broad frontend framework adoption unless later justified.
- No dependence on third-party chat protocol SDKs.
- No attempt to hide plaintext from the Bryti host itself after local decrypt.
- No full Signal-style double ratchet in v1.

## 2. Threat model

### In scope
- Passive network observers on the local network, ISP path, reverse proxy path, or hosting network.
- Intermediaries that can see HTTP/WebSocket metadata but should not see message plaintext.
- Misconfigured logging that could accidentally expose plaintext in transport/channel logs.
- Unauthorized browsers attempting to pair.
- Replay of previously captured encrypted frames.
- Basic cross-origin abuse against the browser app or WebSocket endpoint.
- Pairing-time man-in-the-middle risk reduction suitable for Tailscale/local and manual operator workflows.

### Out of scope for v1
- Full host compromise of the Bryti server.
- Full browser/device compromise.
- Memory scraping on the endpoint after decrypt.
- Advanced deniability, perfect forward secrecy ratchets, or post-compromise recovery properties.
- Secure cloud key backup.
- Multi-device consistency and conflict resolution.

## 3. Trust boundary

### Trusted
- The self-hosted Bryti server after local decrypt.
- The local browser instance after local decrypt.
- Operator-managed deployment boundary, initially Tailscale/local.

### Untrusted or less trusted
- The network between browser and Bryti.
- Reverse proxies and network infrastructure.
- Any external messaging provider.
- Any observer of raw WebSocket traffic.

### Plaintext boundary
- Plaintext exists only:
  - in the browser before encrypt and after decrypt
  - on the Bryti host after decrypt and before encrypting replies
- Plaintext must not be present in WebSocket payloads.
- Plaintext must not be emitted into transport/channel logs by default.

## 4. Architecture

High-level design:
- A browser-based installable web app lives in this repo.
- The browser pairs directly with the Bryti host.
- The browser and Bryti derive shared encryption keys using WebCrypto primitives.
- A self-hosted HTTP/WebSocket service is exposed by Bryti.
- Browser-to-server messages are encrypted at the application layer before being sent over WebSocket.
- Server-to-browser replies are encrypted at the application layer before being sent over WebSocket.
- Bryti decrypts locally and feeds plaintext into the existing `IncomingMessage` pipeline.
- Bryti responses are re-encrypted before transport back to the browser.

Conceptual components:
- `web_e2ee` channel bridge in Bryti source.
- Static web app served by Bryti.
- Manual pairing flow.
- Persistent server key material.
- Persistent paired-device registry.
- Channel-neutral internal routing for synthetic/system messages.

Important compatibility rule:
- Telegram and WhatsApp remain available and unchanged.
- `web_e2ee` must integrate as another `ChannelBridge`, not as a replacement architecture.

## 5. Protocol envelope

The exact frame schema may evolve, but v1 should follow this shape.

### Transport
- WebSocket for duplex transport.
- WSS preferred whenever TLS is available.
- Tailscale/local deployment may initially rely on a trusted private network, but the message payloads remain application-encrypted regardless.

### Envelope goals
- Versioned.
- Compact.
- Direction-aware.
- Replay-resistant.
- Suitable for text-only payloads in v1.

### Suggested outer frame fields
- `v`: protocol version
- `kind`: frame type
- `deviceId`: paired browser device identifier
- `messageId`: sender-generated unique message id
- `counter`: monotonically increasing per-device counter
- `ts`: sender timestamp
- `nonce`: AEAD nonce
- `ciphertext`: encrypted payload

### Suggested frame types
- `pair_init`
- `pair_complete`
- `msg`
- `ack`
- `typing`
- `error`

### Suggested encrypted plaintext payload for `msg`
- `text`
- optional future metadata fields

### Required properties
- WebSocket transport carries ciphertext only for message content.
- Message metadata should be minimized.
- Additional authenticated data should cover unencrypted header fields where applicable.
- Replayed or out-of-order frames beyond policy should be rejected.

## 6. Key management

### Principles
- Use standard WebCrypto primitives if feasible in both browser and Node.
- Avoid introducing unknown chat SDKs.
- Keep private keys out of config files.
- Persist only what is necessary.

### Proposed v1 approach
- One long-term server keypair for the Bryti instance.
- One long-term device keypair per paired browser install.
- Pairing stores the browser public key on the server.
- Shared secret derived using ECDH.
- Directional symmetric keys derived from the shared secret using HKDF.
- Payload encryption performed with an AEAD cipher such as AES-GCM if supported cleanly by WebCrypto in both environments.

### Server-side persistence
Store under `data/` rather than in `config.yml`.

Suggested persisted state:
- server private/public key material
- paired device public keys and metadata
- pairing invites or one-time pairing tokens
- replay/counter tracking state as needed

### Browser-side persistence
- Device private key stored locally in browser-managed storage.
- Paired server identity and device id stored locally.
- Prefer non-extractable key storage where practical.

### Explicit non-goal for v1
- No double ratchet.
- No rotation choreography beyond what is required to recover from explicit re-pairing.

## 7. Manual / SSH-like pairing flow

Manual pairing is the first supported onboarding flow.

### Goals
- Keep the first implementation simple and auditable.
- Work well for Tailscale/local deployments.
- Provide a human-verifiable trust step.

### Operator flow
1. Operator starts Bryti with `web_e2ee` enabled.
2. Bryti exposes a server identity fingerprint.
3. Operator creates a short-lived one-time pairing invite/token.
4. Operator delivers the invite/token to the user out of band.
5. User opens the local/Tailscale-hosted web app.
6. Browser generates a local device keypair.
7. Browser submits pairing token and device public key.
8. Server validates the token, stores the device public key, and returns server public key material and identity metadata.
9. Browser stores paired state locally.
10. Both sides display enough identity information for a manual trust check.

### SSH-like analogy
- Trust-on-first-use is acceptable for the first dev-oriented version.
- The operator and user can compare a displayed server fingerprint manually when needed.
- Later QR and passkey flows may improve this, but they are deferred.

### Pairing constraints
- Pairing tokens must be short-lived.
- Pairing tokens must be single-use.
- Unpaired browsers must not be able to send normal chat traffic.
- Re-pairing should be explicit.

## 8. Proposed `web_e2ee` config shape

This is the proposed configuration shape to implement later. This doc does not itself change runtime config.

```yml
web_e2ee:
  enabled: false
  listen_host: "127.0.0.1"
  listen_port: 8787
  public_origin: "https://bryti.tailnet.ts.net"
  allowed_origins:
    - "https://bryti.tailnet.ts.net"
  path_prefix: "/"
  pairing:
    invite_ttl_minutes: 10
```

### Notes
- `web_e2ee` is the channel/config name.
- Key material and paired-device state must not live in this config block.
- Tailscale/local deployment is the primary initial target.
- Later VPS deployment should remain possible without redesigning the protocol.

## 9. File layout

Planned source layout for later slices:

```text
src/
  channels/
    pwa.ts                      # initial working name during planning; may be renamed to web-e2ee.ts or similar
  pwa/
    types.ts
    crypto.ts
    encoding.ts
    protocol.ts
    pairing-store.ts
    device-store.ts
    invite-store.ts
    http-server.ts
    ws-server.ts
    static/
      index.html
      app.js
      styles.css
      manifest.json
      sw.js
  routing.ts                    # or similar channel-neutral route resolver

docs/
  self-hosted-e2ee-pwa-channel.md

data/
  web-e2ee/                     # exact directory name to be finalized in implementation
    server-key.json
    devices.json
    invites.json
```

### Naming note
- The runtime channel/config name is `web_e2ee`.
- Source file names may use `web-e2ee` or `web_e2ee` consistently when implementation begins.
- This document uses `web_e2ee` for channel semantics and leaves exact file naming to the implementation plan.

## 10. Implementation slices

### Slice 0 — design only
- Write and approve this design document.
- No runtime changes.

### Slice 1 — config and channel plumbing
- Add `web_e2ee` config parsing and validation.
- Add `web_e2ee` as a `Platform`/`ChannelBridge` option.
- Allow Bryti to start with `web_e2ee` as the only configured channel.
- Begin removing hidden Telegram-only routing assumptions for synthetic/system messages.

### Slice 2 — key storage and pairing state
- Add server-side key generation/loading.
- Add paired-device registry.
- Add one-time invite storage.
- Add manual pairing state machine.

### Slice 3 — static web app and transport shell
- Serve static web app from the repo.
- Add HTTP endpoints needed for pairing/bootstrap.
- Add WebSocket connection handling.
- No plaintext logging of channel payloads.

### Slice 4 — encrypted text roundtrip
- Encrypt browser outbound text.
- Decrypt into Bryti locally.
- Re-encrypt Bryti replies back to the browser.
- Add replay/counter checks.
- Keep text-only scope.

### Slice 5 — operator tooling and route cleanup
- Add operator commands for pairing/device inspection/revocation.
- Make `web_e2ee` viable as primary/default channel.
- Route scheduler/event/worker/system follow-ups through the correct channel.

### Slice 6 — hardening and deployment polish
- Tighten CSP/origin policy/logging behavior.
- Improve reconnect behavior.
- Preserve a clear path from Tailscale/local to later VPS deployment.

### Slice 7 — later audio / assistant mode
- Add source-level audio attachment support.
- Add STT/TTS integration.
- Add optional voice reply/assistant mode.
- This slice depends on source changes not present on the current branch.

## 11. Acceptance criteria per slice

### Slice 0
- This document exists.
- The branch remains research/design only.
- No runtime files, config, packages, or dependencies are changed.

### Slice 1
- `web_e2ee` can be configured as the only enabled channel.
- Telegram and WhatsApp startup behavior remains unchanged.
- Hidden Telegram routing assumptions have an explicit replacement plan.

### Slice 2
- Bryti creates or loads persistent server key material.
- Pairing tokens are single-use and time-limited.
- Unpaired devices cannot chat.
- Paired device metadata survives restart.

### Slice 3
- Browser app is served from this repo.
- WebSocket endpoint accepts connections only from allowed origins/policies.
- Channel transport logging does not include plaintext payload content by default.

### Slice 4
- Browser-to-server message content is encrypted before transport.
- Server-to-browser reply content is encrypted before transport.
- Bryti receives plaintext only after local decrypt.
- Replayed frames are rejected.
- Text chat works end-to-end.

### Slice 5
- Synthetic/internal messages route through the correct channel.
- `web_e2ee` can act as primary/default channel.
- Telegram and WhatsApp still work without changed user-facing behavior.

### Slice 6
- Deployment remains practical for Tailscale/local first.
- Later VPS deployment is still feasible without redesigning the core protocol.
- Logging and browser security posture are tightened.

### Slice 7
- Audio and assistant mode are implemented only after source-level voice/audio support exists in `src/`.
- No implementation depends on stale `dist/` artefacts.

## 12. What depends on future audio/voice source changes

The current branch does not have source-level voice/audio support in `src/`.
Any real audio plan must wait for explicit source changes.

Future audio/voice work depends on adding at least:
- source-level audio attachment types in channel interfaces
- source-level message pipeline support for audio inputs
- source-level voice/STT/TTS config and service wiring
- optional channel methods for audio replies where appropriate
- browser capture/upload UX in the web app

Until those source changes exist:
- `web_e2ee` v1 is text-only
- audio is design-only
- assistant voice mode is design-only

## 13. How to preserve Telegram/WhatsApp compatibility

Compatibility requirement:
- Telegram and WhatsApp must keep working unchanged.

### Rules
- Keep the existing `ChannelBridge` architecture.
- Add `web_e2ee` as an additional bridge, not a replacement.
- Do not change Telegram/WhatsApp message semantics unless required for channel-neutral abstractions.
- Refactor hidden Telegram defaults only where internal routing currently hardcodes Telegram.

### Known compatibility issue to address later
Some synthetic/internal messages currently assume Telegram defaults in source, for example:
- scheduler-generated messages
- events-watcher generated messages
- worker-trigger follow-ups
- compaction/system follow-ups
- CLI defaults that assume a Telegram user

### Required preservation behavior
- Existing Telegram deployments keep their current behavior.
- Existing WhatsApp deployments keep their current behavior.
- New `web_e2ee` deployments can become primary/default without breaking the others.

## 14. Risks and deferred items

### Main risks
- Hidden Telegram-specific assumptions outside the bridge layer could make `web_e2ee` incomplete unless routing is abstracted.
- Browser key storage behavior differs across platforms and may affect UX.
- Manual pairing introduces TOFU-style trade-offs.
- WebSocket metadata still exists even when payloads are encrypted.
- Host compromise still exposes plaintext after local decrypt.
- Static long-term keys without a ratchet provide weaker properties than modern secure messengers.

### Deferred items
- QR-based pairing
- passkeys
- multi-device sync
- advanced ratcheting / post-compromise recovery
- audio messaging
- assistant voice mode
- richer browser UI
- offline-first message sync semantics
- attachment/file support beyond text

### Logging rule
- No plaintext transport/channel logs by default.
- If debugging requires payload visibility later, it must be explicit and opt-in.

## Summary

`web_e2ee` is intended to become a first-class Bryti channel for self-hosted encrypted web chat. The first implementation should be minimal, auditable, text-only, and compatible with Tailscale/local deployment. Bryti remains the intended plaintext endpoint after local decrypt. Telegram and WhatsApp remain supported unchanged. Audio and assistant voice mode are intentionally deferred until source-level voice/audio support exists in `src/` and should not be inferred from stale `dist/` artefacts.
