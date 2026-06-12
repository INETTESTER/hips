import http from "k6/http";
import { sleep, check } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";
import exec from "k6/execution";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/2.4.0/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

const PLAYLIST_URL =
  __ENV.PLAYLIST_URL ||
  "https://www.hips-stream.com/hls/live/sk_bEygY58kpX5TMx2NuE--3oAAjfJh4XtO_360p/index.m3u8";
const VIEWER_PRESET = String(__ENV.VIEWER_PRESET || __ENV.MAX_USERS || "100").trim();
const VIEWER_PROFILES = {
  "100": { maxUsers: 100, rampUp: "10s", hold: "1m", rampDown: "10s", watchSeconds: 60 },
  "250": { maxUsers: 250, rampUp: "20s", hold: "2m", rampDown: "15s", watchSeconds: 90 },
  "500": { maxUsers: 500, rampUp: "40s", hold: "3m", rampDown: "20s", watchSeconds: 120 },
  "1000": { maxUsers: 1000, rampUp: "60s", hold: "5m", rampDown: "30s", watchSeconds: 180 },
};

function parsePositiveInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildCustomProfile(maxUsers) {
  const safeUsers = Math.max(1, Number(maxUsers) || 1);
  return {
    maxUsers: safeUsers,
    rampUp: safeUsers <= 100 ? "10s" : safeUsers <= 250 ? "20s" : safeUsers <= 500 ? "40s" : "60s",
    hold: safeUsers <= 100 ? "1m" : safeUsers <= 250 ? "2m" : safeUsers <= 500 ? "3m" : "5m",
    rampDown: safeUsers <= 100 ? "10s" : safeUsers <= 250 ? "15s" : safeUsers <= 500 ? "20s" : "30s",
    watchSeconds: safeUsers <= 100 ? 60 : safeUsers <= 250 ? 90 : safeUsers <= 500 ? 120 : safeUsers <= 1000 ? 180 : 150,
  };
}

const MAX_USERS_ENV = parsePositiveInt(__ENV.MAX_USERS);
const PRESET_PROFILE = VIEWER_PROFILES[VIEWER_PRESET];
const CUSTOM_MAX_USERS =
  MAX_USERS_ENV !== null ? MAX_USERS_ENV : parsePositiveInt(VIEWER_PRESET);
const IS_STANDARD_PRESET = Boolean(PRESET_PROFILE) && MAX_USERS_ENV === null;
const VIEWER_PROFILE =
  PRESET_PROFILE || buildCustomProfile(CUSTOM_MAX_USERS !== null ? CUSTOM_MAX_USERS : 100);
const MAX_USERS = CUSTOM_MAX_USERS !== null ? CUSTOM_MAX_USERS : VIEWER_PROFILE.maxUsers;
const RAMP_UP = __ENV.RAMP_UP || VIEWER_PROFILE.rampUp;
const HOLD = __ENV.HOLD || VIEWER_PROFILE.hold;
const RAMP_DOWN = __ENV.RAMP_DOWN || VIEWER_PROFILE.rampDown;
const WATCH_SECONDS = Number(__ENV.WATCH_SECONDS || VIEWER_PROFILE.watchSeconds);
const VIEWER_LABEL = IS_STANDARD_PRESET ? `preset:${VIEWER_PRESET}` : `custom:${MAX_USERS}`;
const HLS_VARIANT = String(__ENV.HLS_VARIANT || "lowest").trim().toLowerCase();

const rawInitialSegments = parsePositiveInt(__ENV.INITIAL_SEGMENTS);
const INITIAL_SEGMENTS = rawInitialSegments !== null ? rawInitialSegments : 1;

const errors401 = new Counter("errors_401_total");
const errors4xx = new Counter("errors_4xx_total");
const errors5xx = new Counter("errors_5xx_total");
const playlistDuration = new Trend("playlist_load_ms", true);
const segmentDuration = new Trend("segment_load_ms", true);
const segmentBytes = new Counter("segment_bytes_total");
const segmentsDownloaded = new Counter("segments_downloaded_total");
const playbackSuccess = new Rate("playback_success_rate");

export const options = {
  scenarios: {
    streaming_viewers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: MAX_USERS },
        { duration: HOLD, target: MAX_USERS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulStop: "3m30s",
      gracefulRampDown: "3m30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.10"],
    errors_401_total: ["count<1"],
    playlist_load_ms: ["p(95)<3000"],
    segment_load_ms: ["p(95)<5000"],
    playback_success_rate: ["rate>0.95"],
  },
  discardResponseBodies: false,
  noConnectionReuse: false,
  noVUConnectionReuse: false,
};

export function setup() {
  console.log(`▶ Target: ${PLAYLIST_URL}`);
  console.log(`▶ Max VUs: ${MAX_USERS}, watch ${WATCH_SECONDS}s/iter`);
  console.log(`▶ Viewer mode: ${VIEWER_LABEL}`);
  console.log(`▶ HLS variant: ${HLS_VARIANT}, initial segments: ${INITIAL_SEGMENTS}`);
  return { startTs: Date.now() };
}

export default function () {
  const startedAt = Date.now();
  let manifestUrl = PLAYLIST_URL;
  let mediaPlaylistUrl = null;
  let lastSegmentUrl = null;
  let iterationSuccess = true;

  // 1) ดึง master playlist — retry จนกว่าจะได้หรือ WATCH_SECONDS หมด
  let masterRes = null;
  while ((Date.now() - startedAt) / 1000 < WATCH_SECONDS) {
    masterRes = fetchPlaylist(manifestUrl);
    if (masterRes) break;
    sleep(2);
  }
  if (!masterRes) {
    playbackSuccess.add(false);
    return;
  }

  // ถ้าเป็น master playlist (มี variant streams) → เลือกตาม HLS_VARIANT
  mediaPlaylistUrl = resolveMediaPlaylist(masterRes, manifestUrl);

  // 2) วน playback loop
  while ((Date.now() - startedAt) / 1000 < WATCH_SECONDS) {
    const mediaRes = fetchPlaylist(mediaPlaylistUrl);
    if (!mediaRes) {
      iterationSuccess = false;
      sleep(2);
      continue;
    }

    const segments = parseSegments(mediaRes.body, mediaPlaylistUrl);
    if (segments.length === 0) {
      console.warn(`⚠️ VU:${__VU} no segments parsed from ${mediaPlaylistUrl}`);
      sleep(2);
      continue;
    }

    // ดาวน์โหลดเฉพาะ segment ใหม่ (เลียนแบบ player ที่ไม่โหลดซ้ำ)
    // Bug fix: indexOf=-1 เมื่อ segment expire → fallback ไปโหลดแค่ตัวสุดท้ายตัวเดียว
    let newSegments;
    if (!lastSegmentUrl) {
      newSegments = segments.slice(-INITIAL_SEGMENTS);
    } else {
      const idx = segments.indexOf(lastSegmentUrl);
      newSegments = idx >= 0 ? segments.slice(idx + 1) : segments.slice(-1);
    }

    for (const segUrl of newSegments) {
      downloadSegment(segUrl);
      lastSegmentUrl = segUrl;
    }

    // playlist live ปกติ refresh ทุก target duration (~6s)
    sleep(4);
  }

  // นับ success/fail ต่อ iteration (ไม่ใช่ต่อ poll)
  playbackSuccess.add(iterationSuccess);
}

function fetchPlaylist(url) {
  const res = http.get(url, {
    timeout: "15s",
    tags: { type: "playlist", name: "playlist" },
  });
  playlistDuration.add(res.timings.duration);
  trackErrors(res, url);

  const ok = check(res, {
    "playlist 200": (r) => r.status === 200,
    "playlist has body": (r) => r.body && r.body.length > 0,
  });
  return ok ? res : null;
}

function downloadSegment(url) {
  const res = http.get(url, {
    timeout: "20s",
    tags: { type: "segment", name: "segment" },
    responseType: "binary",
  });
  segmentDuration.add(res.timings.duration);
  trackErrors(res, url);

  if (res.status === 200) {
    segmentBytes.add(res.headers["Content-Length"]
      ? Number(res.headers["Content-Length"])
      : (res.body ? res.body.byteLength || res.body.length || 0 : 0));
    segmentsDownloaded.add(1);
  }
}

function trackErrors(res, url) {
  if (res.status === 401) {
    errors401.add(1, { vu: __VU });
    const elapsed = ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
    console.error(
      `🚨 401 | VU:${__VU} | iter:${__ITER} | t+${elapsed}s | url:${truncate(url)}`,
    );
  } else if (res.status >= 500) {
    errors5xx.add(1);
    console.warn(`⚠️ ${res.status} | VU:${__VU} | ${truncate(url)}`);
  } else if (res.status >= 400) {
    errors4xx.add(1);
    console.warn(`⚠️ ${res.status} | VU:${__VU} | ${truncate(url)}`);
  }
}

function resolveMediaPlaylist(res, baseUrl) {
  const body = res.body || "";
  if (body.includes("#EXT-X-STREAM-INF")) {
    const lines = body.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF") && lines[i + 1]) {
        variants.push({
          bandwidth: parseBandwidth(lines[i]),
          url: absoluteUrl(lines[i + 1].trim(), baseUrl),
        });
      }
    }
    if (variants.length === 0) return baseUrl;
    if (HLS_VARIANT === "first") return variants[0].url;
    variants.sort((a, b) => a.bandwidth - b.bandwidth);
    if (HLS_VARIANT === "highest") return variants[variants.length - 1].url;
    return variants[0].url;
  }
  return baseUrl;
}

function parseBandwidth(streamInfLine) {
  const match = streamInfLine.match(/BANDWIDTH=(\d+)/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function parseSegments(body, baseUrl) {
  const segments = [];
  const lines = (body || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      segments.push(absoluteUrl(trimmed, baseUrl));
    }
  }
  return segments;
}

function absoluteUrl(maybeRelative, baseUrl) {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  const base = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
  return base + maybeRelative;
}

function truncate(s) {
  return s.length > 80 ? s.substring(0, 77) + "..." : s;
}

export function handleSummary(data) {
  const c401 =
    (data.metrics.errors_401_total &&
      data.metrics.errors_401_total.values.count) ||
    0;
  const segs =
    (data.metrics.segments_downloaded_total &&
      data.metrics.segments_downloaded_total.values.count) ||
    0;
  const bytes =
    (data.metrics.segment_bytes_total &&
      data.metrics.segment_bytes_total.values.count) ||
    0;
  console.log(`\n=== สรุป ===`);
  console.log(`401 errors      : ${c401}`);
  console.log(`Segments loaded : ${segs}`);
  console.log(`Total bandwidth : ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`============\n`);

  return {
    "report.html": htmlReport(data, {
      title: `HLS Streaming Load Test — ${MAX_USERS} viewers (${VIEWER_LABEL})`,
    }),
    "summary.json": JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: "  ", enableColors: true }),
  };
}