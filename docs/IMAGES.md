# Images in chat

Use this guide when you want an AI to inspect a PNG/JPEG from the gateway and, optionally,
show that image in your chat.

## Before you start

- The connection must use **Full** and have file-read authority.
- The file must be accessible under the current gateway authority and OS permissions.
- The AI client must preserve MCP image blocks and the model must accept image input.
- To show the image to you, the client must also support attachments or embedded images.

Ask the agent to call `core.ping` and check whether `media.read_image` is advertised.
Source files or this guide do not prove which build is running.

## Ask the agent to read and show an image

For example: “Read this PNG from my project, describe it, and attach it in your final reply.”

The agent should bootstrap its Full connection, call `media.read_image` with the absolute
gateway file path, and use the returned image block as model input. If you requested display,
it should attach/embed the actual image in its final answer.

A successful read and a correct description do not prove that your chat UI displayed the image.
If either model input or attachment display is unsupported, the agent should report that limitation.

## Formats and limits

| Property                | Behavior                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| Formats                 | PNG and JPEG with supported SOF0/SOF1/SOF2 frame headers; identified by content  |
| Maximum file size       | 4 MiB                                                                            |
| Maximum declared pixels | 25,000,000                                                                       |
| Processing              | Original bytes/EXIF preserved; no resize, crop, OCR or orientation normalization |
| Validation              | Container/header checks; not a full pixel decode                                 |
| Result                  | One MCP image block plus path, MIME, dimensions, byte count and SHA-256 metadata |

Renaming a file does not convert its format. Supply a smaller supported image if it exceeds
the limits. Malformed pixels may still pass header checks and then fail in a client's decoder.

## If it does not work

| Symptom                                | Action                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Tool is missing                        | Check Full/Gateway-only profile, read authority and running version; refresh client discovery after changes |
| `core.read` rejects the image as UTF-8 | Use `media.read_image`; `core.read` reads text                                                              |
| `too_large`                            | Resize/compress the source with an appropriate image tool before reading                                    |
| Access denied                          | Check Paths, protected names, symlinks and OS permissions                                                   |
| Model sees it, but you do not          | Ask for an actual final-answer attachment through the client's file workflow                                |
| Broken `sandbox:` link                 | The file must exist in the current chat's local attachment runtime, not only on the remote gateway          |
| Model cannot consume the result        | Check that the client forwards `content[]` image blocks and the selected model accepts images               |

See [Troubleshooting](TROUBLESHOOTING.md) for related diagnostics.

## Client integration notes

For clients with a local file/attachment runtime, materialize the image block as a local PNG/JPEG,
verify its SHA-256 against the gateway result, then attach that file. A sandbox-capable client may
embed a real local attachment as `![image](sandbox:/actual/local/attachment/image.png)`.
Do not invent an attachment path or use a remote gateway path as a local chat path.

Gateway paths and chat attachment paths are different filesystems. Sandbox links are client-specific;
they are not universal MCP download URLs.

For developer validation, run the fixture-based authenticated MCP test on supported Node 22/24:

```bash
node node_modules/vitest/vitest.mjs run tests/conformance/media-image-e2e.test.ts
```

An optional `SLNCTRZ_IMAGE_SMOKE_PATH` selects an explicitly authorized local image.
The test starts an isolated server; it does not deploy or restart a live gateway.
Record installed-artifact model perception and user display separately using
[Release Acceptance](RELEASE_ACCEPTANCE.md).

## Audio

This tool reads images. File transport or user audio playback does not establish model hearing,
and this feature supplies no audio reader or transcription service.

See also [User Guide](USER_GUIDE.md).
