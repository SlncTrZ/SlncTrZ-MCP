import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageDimensions, readContainedImage, MAX_IMAGE_BYTES } from "../../src/kernel/fs-image.js";

const dirs: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  "base64"
);
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

describe("bounded image reader", () => {
  it("rejects truncated containers and unsupported signatures", () => {
    for (const data of [
      Buffer.from("GIF89a"),
      png.subarray(0, 24),
      png.subarray(0, png.length - 1),
      Buffer.from([255, 216, 255, 217])
    ]) {
      expect(() => imageDimensions(data)).toThrow("Unsupported or malformed");
    }
  });
  it("bounds declared pixel count before a client decodes it", () => {
    const big = Buffer.from(png);
    big.writeUInt32BE(100000, 16);
    expect(() => imageDimensions(big)).not.toThrow();
    big.writeUInt32BE(100000, 20);
    expect(() => imageDimensions(big)).toThrow("megapixel");
  });
  it("recognizes JPEG frame dimensions and rejects truncated segment lengths", () => {
    // Minimal container fixture tests header inspection, not pixel decoding.
    const jpeg = Buffer.from([
      255, 216, 255, 192, 0, 11, 8, 0, 2, 0, 3, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 1,
      255, 217
    ]);
    expect(imageDimensions(jpeg)).toEqual({ mimeType: "image/jpeg", width: 3, height: 2 });
    jpeg.writeUInt16BE(65535, 4);
    expect(() => imageDimensions(jpeg)).toThrow();
  });
  it("enforces file byte limits, protects secrets, and honours cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-image-unit-"));
    dirs.push(root);
    await writeFile(join(root, "large.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    await writeFile(join(root, ".env"), png);
    await writeFile(join(root, "image.png"), png);
    await expect(readContainedImage(root, "large.png")).rejects.toMatchObject({
      code: "too_large"
    });
    await expect(readContainedImage(root, ".env")).rejects.toMatchObject({
      code: "permission_denied"
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      readContainedImage(root, "image.png", { signal: controller.signal })
    ).rejects.toMatchObject({ code: "cancelled" });
    expect((await readContainedImage(root, "image.png")).data).toBe(png.toString("base64"));
  });
});
