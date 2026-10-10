import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/package.mjs");
const SKILL_ROOT = resolve(dirname(script), "..");
const videoMeta = {
  width: 320,
  height: 180,
  duration: 2,
  fps: 6,
  scenes: [{ name: "Demo", start: 0, end: 2 }]
};
function call(command, args) {
  const p = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(p.status, 0, command + " error: " + p.stderr);
  return p.stdout;
}
function packageIt(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 90000 });
}
function rgbFrame(path) {
  const p = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-v",
      "error",
      "-nostdin",
      "-i",
      path,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "-"
    ],
    { maxBuffer: 2 * 1024 * 1024, timeout: 15000 }
  );
  assert.equal(p.status, 0, String(p.stderr));
  assert.equal(p.stdout.length, 320 * 180 * 3);
  return p.stdout;
}
function pixelDifference(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-video-package-test-"));
  const source = join(root, "render");
  const frames = join(source, "frames");
  await mkdir(frames, { recursive: true });
  call("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=6:duration=2",
    "-threads",
    "1",
    "-start_number",
    "0",
    "-frames:v",
    "12",
    join(frames, "%06d.png")
  ]);
  call("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-framerate",
    "6",
    "-start_number",
    "0",
    "-i",
    join(frames, "%06d.png"),
    "-frames:v",
    "12",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "6",
    join(source, "video.mp4")
  ]);
  const sourceBuffer = await readFile(join(source, "video.mp4"));
  const sha = createHash("sha256").update(sourceBuffer).digest("hex");
  const rep = {
    mode: "full",
    technicalPass: true,
    visualReview: "required",
    meta: videoMeta,
    frames: 12,
    videoSha256: sha
  };
  await writeFile(join(source, "report.json"), JSON.stringify(rep));
  const copy = join(root, "share-copy.txt");
  await writeFile(copy, "AI can do the work on your own machine. Approve the actions.");
  return { root, source, copy, sha };
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
test("creative skill links instructions and mode-specific gates", async () => {
  const read = async (p) => readFile(join(SKILL_ROOT, p), "utf8");
  const skill = await read("SKILL.md");
  assert.match(skill, /^---\nname: render-technical-video\n/m);
  for (const path of [
    "references/creative.md",
    "references/production.md",
    "references/delivery.md",
    "references/audio.md",
    "references/quality.md"
  ]) {
    assert.ok(await exists(join(SKILL_ROOT, path)), path);
    assert.ok(skill.includes(path), path);
  }
  assert.match(skill, /styleframes/i);
  assert.match(skill, /visual approval/i);
  assert.match(skill, /native Blender/i);
  assert.match(skill, /render\(t\)/i);
});
test("reject preview-only or unverified source and never create output", async () => {
  const x = await fixture();
  const src = join(x.source, "report.json");
  const obj = JSON.parse(await readFile(src));
  obj.mode = "preview";
  await writeFile(src, JSON.stringify(obj));
  const destination = join(x.root, "dest");
  const p = packageIt([x.source, destination, "--poster-frame", "1", "--share-copy", x.copy]);
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /passing full render report/);
  assert.equal(await exists(destination), false);
});
test("choose approved poster, embed frame zero, preserve duration and silent codec", async () => {
  const x = await fixture();
  const destination = join(x.root, "delivery");
  const p = packageIt([x.source, destination, "--poster-frame", "5", "--share-copy", x.copy]);
  assert.equal(p.status, 0, p.stderr);
  assert.ok(await exists(join(destination, "launch.mp4")));
  assert.ok(await exists(join(destination, "poster.jpg")));
  const info = JSON.parse(await readFile(join(destination, "delivery-report.json"), "utf8"));
  assert.equal(info.meta.fps, 6);
  assert.equal(info.posterFrame, 5);
  assert.equal(info.visualReview, "required");
  assert.equal(info.technicalPass, true);
  assert.equal(info.audio.present, false);
  assert.equal(info.sourceRenderDirectory, "render");
  assert.ok(
    !JSON.stringify(info).includes(x.root),
    "Shareable report must not expose absolute local paths"
  );
  assert.equal(info.assets["launch.mp4"].length, 64);
  const meta = JSON.parse(
    call("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,nb_read_frames",
      "-of",
      "json",
      join(destination, "launch.mp4")
    ])
  );
  assert.equal(Number(meta.format.duration), 2);
  assert.equal(Number(meta.streams[0].nb_read_frames), 12);
  assert.equal(meta.streams.filter((s) => s.codec_type === "audio").length, 0);
  const firstVideoFrame = rgbFrame(join(destination, "launch.mp4"));
  const chosenPoster = rgbFrame(join(x.source, "frames", "000005.png"));
  const originalFirst = rgbFrame(join(x.source, "frames", "000000.png"));
  assert.ok(
    pixelDifference(firstVideoFrame, chosenPoster) <
      pixelDifference(firstVideoFrame, originalFirst) * 0.8,
    "MP4 first frame must actually display the chosen settled poster"
  );
  const conflict = packageIt([
    x.source,
    destination,
    "--poster-frame",
    "5",
    "--share-copy",
    x.copy
  ]);
  assert.notEqual(conflict.status, 0);
  assert.ok(await exists(join(destination, "launch.mp4"))); // existing deliverable not overwritten
});
test("audio license note mandatory; authorized soundtrack gives AAC stereo", async () => {
  const x = await fixture();
  const wave = join(x.root, "score.wav");
  call("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    wave
  ]);
  const dest = join(x.root, "with-audio");
  const base = [x.source, dest, "--poster-frame", "7", "--share-copy", x.copy, "--audio", wave];
  const denied = packageIt(base);
  assert.notEqual(denied.status, 0);
  assert.equal(await exists(dest), false);
  const ok = packageIt([...base, "--audio-credit", "Original synthesized score, owned by creator"]);
  assert.equal(ok.status, 0, ok.stderr);
  const info = JSON.parse(await readFile(join(dest, "delivery-report.json")));
  assert.match(info.audio.credit, /Original synthesized/);
  assert.equal(info.audio.filename, "score.wav");
  assert.equal(info.audio.sha256.length, 64);
  assert.ok(
    !JSON.stringify(info).includes(x.root),
    "Audio report must not expose absolute local paths"
  );
  const pr = JSON.parse(
    call("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,channels,sample_rate:format=duration",
      "-of",
      "json",
      join(dest, "launch.mp4")
    ])
  );
  assert.ok(
    pr.streams.some((s) => s.codec_name === "aac" && s.channels === 2 && s.sample_rate === "48000")
  );
  assert.ok(Math.abs(Number(pr.format.duration) - 2) < 0.04);
});
