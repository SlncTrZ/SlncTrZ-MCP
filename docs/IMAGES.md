# Images in chat

## Status and scope

The image reader was implemented in source commit `e06abc6a360c183c40cfd5b96337b31d6b6f08ab`
on `feat/media-read-image`. At the 2026-09-09 documentation check, the live gateway still
reported build `fe291d9eea3633032730be67f90974dcaa71f29f`; this work has not deployed the image tool.

Check the running catalog, not the existence of source files, before invoking `media.read_image`.
The gateway's model help is `core.ping` plus `docs/MODEL_GUIDE.md` (embedded in standalone builds).
`slnctrz-mcp --help` points to it. A connected provider's `.help` covers only that provider.

## Reader contract

`media.read_image({"path": "/authorized/path/image.png"})` is a built-in read-only tool using
the existing `core.read` authority, including multi-root and documentation-only restrictions.
It is not a CLI command or a separate provider requiring configuration.

| Property   | Initial implementation                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| Formats    | PNG; JPEG with supported SOF0/SOF1/SOF2 frame headers, identified by content                         |
| Limits     | 4 MiB of file bytes; 25,000,000 declared pixels                                                      |
| Processing | Original bytes/EXIF preserved; no resize, crop, OCR or orientation normalization                     |
| Validation | Container/header checks; not full pixel decoding or complete corruption detection                    |
| Payload    | One `content[]` image block with `data` (base64) and `mimeType`                                      |
| Metadata   | Path/name, bytes, MIME, width/height, SHA-256, `transformed: false`, validation and display guidance |
| Audit      | Invocation metadata; no raw image/base64 payload                                                     |

`core.ping.structuredContent.media` reports actual advertisement, limits and display guidance.
That summary grants no additional authority. Metadata is not a substitute for the image block.

## Model perception and user display are separate

1. Read the image through the gateway.
2. Forward the returned image block to the model through the client's image-input mechanism.
3. If the user asked to see it, use the client's attachment mechanism to embed it in the final answer.
4. Verify model perception and user-visible display separately. Report either unsupported part honestly.

The server cannot force a client UI to show an image or force a model to follow guidance.
The tool description, tool response and model guide instruct the agent to complete the display step.

### Verified ChatGPT Work attachment workflow

When the client provides a local filesystem and attachments:

- Decode the returned base64 data to a real local PNG/JPEG, without changing its bytes.
- Verify the local SHA-256 against the gateway result.
- Save/attach it through the environment's supported file workflow.
- Embed the actual local attachment in the **final answer**:

```markdown
![image.png](sandbox:/actual/local/attachment/image.png)
[image.png](sandbox:/actual/local/attachment/image.png)
```

The path is illustrative. Use a file that exists in the current chat runtime; the gateway's
remote filesystem and the chat runtime filesystem are different. Sandbox paths are not universal
MCP URLs and should not be reused across sessions.

The initial tool-output image was perceptible to the model but invisible to the owner.
Attaching the file and embedding it in the final answer made it visible. No public media endpoint,
browser extension, device targeting or timed Chrome window was needed.

### Before the image tool is deployed

The verified fallback used the already authorized `core.exec` command `base64`, with
`args: ["-w", "0", "/authorized/path/image.png"]` on the GNU/Linux gateway.

Check file size first, choose bounded `maxOutputBytes` sufficient for base64 (about 4/3 of file
size), and require `exitCode === 0` and `stdoutTruncated === false`.
Keep the string in programmatic tool-result handling; do not print it into the model's text context.
Use `sha256sum` on the source to verify the decoded attachment. Commands must already be authorized.
This GNU command syntax is not a cross-platform contract; prefer the new reader when available.

## Evidence and validation

On 2026-09-08 the owner confirmed both image perception and final-answer display:

| Source under `/mnt/pc-dev/AI-Apps/SlncTrZ_VMK/test/` | Evidence                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `vmk_live_clean.png`                                 | Red teapot, plant by a window; model described it; owner confirmed visibility after attachment |
| `girl_model.png`                                     | Portrait in dark green clothing; source/copy SHA-256 matched; owner confirmed                  |

Both demonstrations used legacy `core.exec`, not a deployed `media.read_image`.
The image tool separately passed isolated authenticated HTTP MCP tests including exact-byte/hash
comparison with the owner's `vmk_live_clean.png`.

For source validation, use the project's supported Node 22/24 environment. Run the focused
conformance suite with an optional read-only owner-image smoke:

```bash
SLNCTRZ_IMAGE_SMOKE_PATH=/absolute/path/image.png \
  node node_modules/vitest/vitest.mjs run tests/conformance/media-image-e2e.test.ts
```

Only set that variable to an image the caller is authorized to read. Without it, the owner-image
case is skipped; fixture-based conformance still runs. The smoke starts its own loopback server
with test authentication and does not restart or configure the live gateway.

For an installed release, collect [release acceptance](RELEASE_ACCEPTANCE.md#image-reading-and-display-acceptance)
on each claimed client/device. A successful Work session is not a universal ChatGPT/Claude claim.

## Audio boundary

In the same session, the owner could play an attached WAV, but the active model runtime rejected
audio input. This establishes file transport/user playback only, not model hearing. The owner
stopped the audio experiment; this image work adds no audio tool or transcription service.

## Knowledge references

KB topic: `mcp_image_reading_chat_display`.

- Workflow: `35f45cb6-4eae-401b-9c9b-4074cdbe3eec`
- Evidence: `55b2d405-ce30-4c7e-b5ce-d245e13a4bd1`
- Implementation: `eab6c025-c9e4-457f-a82a-002a5609d673`
- Validation/status: `0b54c4ec-635d-472b-84ea-1057e146e8e1`

See also [troubleshooting](TROUBLESHOOTING.md#image-reading-and-chat-display) and
[user guide](USER_GUIDE.md#6-view-an-image-together-with-your-agent).
