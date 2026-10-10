#!/usr/bin/env node
// Post-process a passing local deterministic render; NEVER overwrites the input.
// Generates an intentionally chosen poster, keeps it as delivered frame zero,
// and optionally muxes an authorized existing audio file. No network requests.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, copyFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { once } from "node:events";

const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const usage =
  "Usage: node package.mjs <render-output> <NEW-delivery-directory> --poster-frame <integer> --share-copy <local.txt> [--audio <file> --audio-credit <provenance>]";
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--help") {
  console.log(usage);
  process.exit(0);
}
assert(argv.length >= 6 && argv.length % 2 === 0, usage);
const [sourceArg, destArg, ...opts] = argv;
const o = new Map();
for (let i = 0; i < opts.length; i += 2) {
  const k = opts[i],
    v = opts[i + 1];
  assert(
    ["--poster-frame", "--share-copy", "--audio", "--audio-credit"].includes(k) &&
      v &&
      !v.startsWith("--") &&
      !o.has(k),
    "Invalid or duplicate option: " + k
  );
  o.set(k, v);
}
assert(o.has("--poster-frame") && o.has("--share-copy"), usage);
assert(
  o.has("--audio") === o.has("--audio-credit"),
  "--audio requires --audio-credit and vice versa"
);
assert(/^(0|[1-9]\d*)$/.test(o.get("--poster-frame")), "Poster frame must be an integer >= 0");
const posterIndex = Number(o.get("--poster-frame"));
const source = await realpath(resolve(sourceArg));
const dest = resolve(destArg);
const rel = relative(source, dest);
assert(
  rel && (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("/")),
  "Delivery must be outside the render source directory"
);
const reportPath = join(source, "report.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert(
  report.mode === "full" && report.technicalPass === true && report.visualReview === "required",
  "Input must have a passing full render report"
);
const meta = report.meta || {};
const { width, height, fps, duration } = meta;
const count = Math.round(duration * fps);
assert(
  [width, height, fps, duration].every(Number.isFinite) &&
    width > 0 &&
    height > 0 &&
    width % 2 === 0 &&
    height % 2 === 0 &&
    fps > 0 &&
    count >= 1 &&
    count <= 18000 &&
    Math.abs(count - fps * duration) < 1e-7 &&
    report.frames === count &&
    posterIndex < count,
  "Invalid video metadata / poster index"
);
const video = join(source, "video.mp4");
const posterFrame = join(source, "frames", String(posterIndex).padStart(6, "0") + ".png");
for (const name of [video, posterFrame]) {
  const x = await stat(name);
  assert(x.isFile() && x.size > 100, "Required source media missing/empty: " + name);
}
const copy = (await readFile(resolve(o.get("--share-copy")), "utf8")).trim();
assert(
  copy.length >= 5 &&
    copy.length <= 2000 &&
    !copy.includes("[TODO]") &&
    !copy.includes("[PLACEHOLDER]"),
  "Share copy must be a finished public-ready draft"
);
const audio = o.has("--audio") ? await realpath(resolve(o.get("--audio"))) : null;
if (audio) {
  assert(
    (await stat(audio)).size > 100 && o.get("--audio-credit").trim().length >= 8,
    "Audio must exist and carry a meaningful attribution/provenance note"
  );
}
function execSync(command, args) {
  const p = spawnSync(command, args, { encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 });
  assert(p.status === 0, command + " failed: " + (p.stderr || "").slice(-500));
  return p.stdout;
}
for (const x of ["ffmpeg", "ffprobe"]) execSync(x, ["-version"]);
function probe(path, countFrames = false) {
  const args = [
    "-v",
    "error",
    ...(countFrames ? ["-count_frames"] : []),
    "-show_entries",
    "format=duration:stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames,channels,sample_rate",
    "-of",
    "json",
    path
  ];
  return JSON.parse(execSync("ffprobe", args));
}
const ratio = (v) => {
  const [a, b = 1] = String(v).split("/").map(Number);
  return a / b;
};
const from = probe(video, true);
const first = from.streams.find((x) => x.codec_type === "video");
assert(
  first &&
    first.codec_name === "h264" &&
    first.width === width &&
    first.height === height &&
    Number(first.nb_read_frames) === count &&
    Math.abs(ratio(first.avg_frame_rate) - fps) < 1e-4 &&
    Math.abs(Number(from.format.duration) - duration) < 1 / fps + 0.01,
  "Source MP4 does not match its passing report"
);
assert(
  !from.streams.some((x) => x.codec_type === "audio"),
  "Input render is expected silent; unexplained audio cannot be mixed"
);
const audioLength = audio ? Number(probe(audio).format.duration) : 0;
if (audio)
  assert(
    Number.isFinite(audioLength) && audioLength + 1 / fps >= duration,
    "Approved audio must cover the whole clip; fix/edit music first"
  );

async function digest(path) {
  const h = createHash("sha256");
  for await (const b of createReadStream(path)) h.update(b);
  return h.digest("hex");
}
const sourceHash = await digest(video);
assert(sourceHash === report.videoSha256, "Input video does not match original SHA-256");
async function run(command, args, timeout) {
  const p = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let error = "";
  p.stderr.on("data", (x) => {
    error = (error + String(x)).slice(-2000);
  });
  let timer;
  try {
    const result = await Promise.race([
      once(p, "close"),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          p.kill("SIGTERM");
          reject(new Error(command + " timeout"));
        }, timeout);
      })
    ]);
    assert(result[0] === 0, command + " exit " + result[0] + ": " + error.slice(-1200));
  } finally {
    clearTimeout(timer);
  }
}
// Error-before-mkdir guarantees bad source data never produces a misleading delivery.
await mkdir(dirname(dest), { recursive: true });
await mkdir(dest); // EEXIST deliberately blocks overwrite.
const poster = join(dest, "poster.jpg");
const packaged = join(dest, "launch.mp4");
await run(
  "ffmpeg",
  [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-n",
    "-i",
    posterFrame,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    poster
  ],
  60000
);
// Overlay only output frame 0 with selected settled still; never insert extra frame.
const ffargs = [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-n",
  "-i",
  video,
  "-loop",
  "1",
  "-framerate",
  String(fps),
  "-i",
  posterFrame,
  ...(audio ? ["-i", audio] : []),
  "-filter_complex",
  "[0:v][1:v]overlay=x=0:y=0:shortest=1:enable='eq(n,0)'[v]",
  "-map",
  "[v]",
  ...(audio ? ["-map", "2:a:0"] : ["-an"]),
  "-frames:v",
  String(count),
  "-r",
  String(fps),
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  ...(audio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : []),
  "-t",
  String(duration),
  "-movflags",
  "+faststart",
  packaged
];
await run("ffmpeg", ffargs, Math.max(180000, count * 300));
const result = probe(packaged, true);
const v = result.streams.find((x) => x.codec_type === "video");
const a = result.streams.find((x) => x.codec_type === "audio");
assert(
  v &&
    v.codec_name === "h264" &&
    v.pix_fmt === "yuv420p" &&
    v.width === width &&
    v.height === height &&
    Number(v.nb_read_frames) === count &&
    Math.abs(ratio(v.avg_frame_rate) - fps) < 1e-4 &&
    Math.abs(Number(result.format.duration) - duration) < 1 / fps + 0.03,
  "Packaged video contract mismatch"
);
assert(
  audio ? Boolean(a && a.codec_name === "aac" && a.channels === 2) : !a,
  "Packaged audio mismatch"
);
await run(
  "ffmpeg",
  ["-v", "error", "-nostdin", "-i", packaged, "-f", "null", "-"],
  Math.max(180000, count * 200)
);
await copyFile(resolve(o.get("--share-copy")), join(dest, "share-copy.txt"));
const delivery = {
  schemaVersion: 1,
  status: "technically-passed-creative-approval-pending",
  technicalPass: true,
  factualReview: "required",
  visualReview: "required",
  sourceRenderDirectory: basename(source), // no absolute owner path in shareable delivery
  sourceReportSha256: await digest(reportPath),
  sourceVideoSha256: sourceHash,
  meta,
  frames: count,
  posterFrame: posterIndex,
  posterTimeSeconds: posterIndex / fps,
  audio: audio
    ? {
        filename: basename(audio),
        sha256: await digest(audio),
        duration: audioLength,
        credit: o.get("--audio-credit")
      }
    : { present: false },
  assets: {
    "launch.mp4": await digest(packaged),
    "poster.jpg": await digest(poster),
    "share-copy.txt": await digest(join(dest, "share-copy.txt"))
  },
  checks: ["sha256-source", "codec-size-fps-duration-frame-count", "full-decode"],
  node: process.version,
  ffmpeg: execSync("ffmpeg", ["-version"]).split("\n")[0]
};
await writeFile(join(dest, "delivery-report.json"), JSON.stringify(delivery, null, 2) + "\n");
console.log(
  JSON.stringify({
    stage: "packaged",
    output: dest,
    frames: count,
    posterFrame: posterIndex,
    audio: !!audio,
    visualReview: "required"
  })
);
