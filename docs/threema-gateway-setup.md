# Threema Gateway E2E setup for Bryti

This guide prepares a local Threema Gateway end-to-end (E2E) setup for Bryti without storing real credentials in the repository.

Official Threema reference:
- https://gateway.threema.ch/en/developer/howto/create-keys/python

## Security rules

- Never commit `privateKey.txt`.
- Never commit a real Threema API secret.
- Never paste a private key or API secret into chat, GitHub, logs, issues, PRs, or screenshots.
- Keep the private key local and back it up securely.
- If you lose the E2E private key, the Gateway ID becomes unusable.

## What each value means

### Gateway ID
- Your Threema Gateway identity.
- Usually starts with `*` and is 8 characters long.
- Used by Bryti as `threema.gateway_id` / `THREEMA_GATEWAY_ID`.

Example placeholder:
- `*YOURID`

### API secret
- The Threema Gateway API authentication secret.
- Used for API authentication, callback MAC verification, blob upload/download auth, and `/send_e2e` calls.
- Obtained from the **Threema Gateway admin/account UI** after your E2E Gateway ID is approved.
- It does **not** come from the normal Threema Desktop or Android app.
- It is **not** the same as the private key.

Example placeholder:
- `replace_me`

### Public key
- Generated locally as part of the E2E keypair.
- Safe to submit to the Threema Gateway admin when requesting your E2E Gateway ID.
- Stored locally in `data/private/threema/publicKey.txt` if you use the helper script.

### Private key
- Generated locally as part of the E2E keypair.
- Must remain local.
- Used by Bryti to decrypt incoming E2E messages and encrypt outgoing E2E payloads.
- Configure Bryti with the file path via `threema.private_key_path` / `THREEMA_PRIVATE_KEY_PATH`.

### Allowed sender ID
- The Threema ID of the person allowed to message Bryti through the Gateway.
- This is your personal Threema ID from your regular Threema app.
- In Bryti, this goes into `threema.allowed_senders`.
- It is **not** the Gateway ID.

Example placeholder:
- `YOUR_PERSONAL_THREEMA_ID`

## Local key generation

Use the local-only helper script:

```bash
bash scripts/threema-generate-keys.sh
```

What it does:
- creates `data/private/threema/`
- creates/uses a Python venv in `data/private/threema/venv`
- installs the official Python package `threema.gateway`
- generates:
  - `data/private/threema/privateKey.txt`
  - `data/private/threema/publicKey.txt`

The script refuses to overwrite existing key files unless you pass `--force`:

```bash
bash scripts/threema-generate-keys.sh --force
```

## Request the E2E Gateway ID

After generating keys:

1. Log in to the Threema Gateway admin/account site.
2. Go to the area for requesting or managing IDs.
3. Request a new Threema ID.
4. Choose **End-to-End mode**.
5. Paste the contents of `publicKey.txt` into the Gateway admin.
6. Wait for Threema to review and approve the ID.
7. After approval, obtain the **API secret** from the Gateway admin.

Do not paste `privateKey.txt` into the admin.

## Where to keep the private key

Recommended local path:

```text
/absolute/path/to/bryti-voice/data/private/threema/privateKey.txt
```

This path is inside `data/`, which is gitignored in this repo.

Back it up securely. If it is lost, the E2E Gateway ID cannot be recovered for use with the original keypair.

## Bryti config values

Use placeholders only until you manually fill in real values locally.

### Environment placeholders

```dotenv
THREEMA_ENABLED=true
THREEMA_GATEWAY_ID=*YOURID
THREEMA_SECRET=replace_me
THREEMA_PRIVATE_KEY_PATH=/absolute/path/to/privateKey.txt
THREEMA_ALLOWED_SENDERS=YOUR_PERSONAL_THREEMA_ID
```

Do not commit real values.

### `config.yml` / `config.example.yml` shape

```yml
threema:
  enabled: true
  gateway_id: "${THREEMA_GATEWAY_ID}"
  secret: "${THREEMA_SECRET}"
  private_key_path: "${THREEMA_PRIVATE_KEY_PATH}"
  allowed_senders: ["${THREEMA_ALLOWED_SENDERS}"]
  api_base_url: "https://msgapi.threema.ch"
  callback:
    host: "127.0.0.1"
    port: 8787
    path: "/threema/callback"
```

## Callback URL setup

For incoming messages, Threema Gateway calls an HTTPS callback URL that you configure in the Gateway admin.

Bryti needs:
- a callback path, for example `/threema/callback`
- a local listener host and port, for example `127.0.0.1:8787`
- an externally reachable HTTPS URL in front of that local service

Example deployment shape:
- public callback URL in Gateway admin:
  - `https://bryti.example.com/threema/callback`
- reverse proxy forwards to local Bryti process:
  - `http://127.0.0.1:8787/threema/callback`

Notes:
- The externally configured callback URL should be HTTPS.
- Bryti verifies the callback MAC using the API secret.
- `gateway_id` identifies Bryti's Gateway identity in the callback payload.

## Recommended allowed_senders setup

Set `allowed_senders` to your own personal Threema ID first while testing.

Example:

```yml
threema:
  allowed_senders: ["YOUR_PERSONAL_THREEMA_ID"]
```

This reduces exposure compared with allowing arbitrary senders.

## What Bryti needs to work

Minimum Threema inputs for this repo:
- an approved E2E Gateway ID
- the API secret from the Threema Gateway admin
- the local private key file path
- callback URL configured in the Gateway admin
- allowed sender IDs

## What not to do

- Do not commit `privateKey.txt` or `publicKey.txt`.
- Do not commit a real `THREEMA_SECRET`.
- Do not paste private keys or API secrets into chat.
- Do not paste them into shell history snippets you plan to share.
- Do not put them in GitHub issues, PRs, CI logs, or screenshots.
- Do not use the normal Threema app as the source of the Gateway API secret.
