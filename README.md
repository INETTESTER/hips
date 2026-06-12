# HLS Streaming Load Test (k6)

Load test สำหรับ HLS streaming โดยจำลอง player จริง — ดึง `m3u8` → parse segments → ดาวน์โหลด `.ts` → refresh playlist วนตามรอบ

## โครงสร้างไฟล์

```
d:\test-case\k6\
├── load-test.js     # สคริปต์ทดสอบหลัก
├── README.md        # ไฟล์นี้
├── report.html      # รายงาน HTML (สร้างหลังรัน)
├── summary.json     # สรุป metrics (สร้างหลังรัน)
└── raw.json         # raw output (ถ้าใช้ --out json)
```

## พฤติกรรมของสคริปต์

1. ดึง **master playlist** (`m3u8`)
2. ถ้าเจอ `#EXT-X-STREAM-INF` (มี variant streams) จะเลือก variant แรกเป็น media playlist
3. parse `.ts` segments จาก media playlist
4. ดาวน์โหลด segment เฉพาะอันใหม่ (จำ `lastSegmentUrl` กันโหลดซ้ำ — เลียนแบบ HLS live edge)
5. รอ 4 วินาทีแล้ว refresh playlist ใหม่ วนจนครบ `WATCH_SECONDS`

## ติดตั้ง k6

```powershell
# ผ่าน winget
winget install k6 --source winget

# หรือผ่าน chocolatey
choco install k6
```

ตรวจสอบว่าติดตั้งแล้ว
```powershell
k6 version
```

## วิธีรัน

### รันพื้นฐาน (ค่า default)

ใช้ค่าเริ่มต้น: ramp 10 วิ → 100 VU, hold 1 นาที, ดูสตรีม 60 วินาที/คน

```powershell
cd d:\test-case\k6
k6 run load-test.js
```

### กำหนดพารามิเตอร์เอง

```powershell
k6 run `
  -e MAX_USERS=100 `
  -e RAMP_UP=30s `
  -e HOLD=2m `
  load-test.js
```

ถ้าต้องการกำหนดเลขเองแบบอิสระ ใช้ `MAX_USERS` ได้เลย เช่น 75, 123, 300, 750 หรือ 1200

```powershell
k6 run `
  -e MAX_USERS=750 `
  -e RAMP_UP=45s `
  -e HOLD=3m `
  -e RAMP_DOWN=20s `
  load-test.js
```

### ใช้ preset มาตรฐาน

สคริปต์รองรับ preset หลัก 4 ระดับ:

- `100`  → ทดสอบเบื้องต้น
- `250`  → ทดสอบระดับกลาง
- `500`  → ทดสอบหนัก
- `1000` → ทดสอบสูงสุดเบื้องต้น

ตัวอย่าง:

```powershell
k6 run -e VIEWER_PRESET=100 load-test.js
k6 run -e VIEWER_PRESET=250 load-test.js
k6 run -e VIEWER_PRESET=500 load-test.js
k6 run -e VIEWER_PRESET=1000 load-test.js
```

ถ้าต้องการ override ค่าเองยังทำได้ เช่น:

```powershell
k6 run `
  -e VIEWER_PRESET=1000 `
  -e MAX_USERS=1200 `
  -e RAMP_UP=90s `
  -e HOLD=10m `
  -e RAMP_DOWN=30s `
  -e WATCH_SECONDS=240 `
  load-test.js
```

### เปลี่ยน stream เป้าหมาย

```powershell
k6 run -e PLAYLIST_URL="https://example.com/live/stream.m3u8" load-test.js
```

### เก็บ raw output ครบทุก data point

```powershell
k6 run --out json=raw.json load-test.js
```

## พารามิเตอร์ (Environment Variables)

| ชื่อ | Default | คำอธิบาย |
|---|---|---|
| `PLAYLIST_URL` | `https://www.hips-stream.com/.../index.m3u8` | URL ของ m3u8 ที่จะทดสอบ |
| `VIEWER_PRESET` | `100` | preset หลัก: `100`, `250`, `500`, `1000` |
| `MAX_USERS` | ตาม preset | override จำนวน VU สูงสุดได้ |
| `RAMP_UP` | ตาม preset | ระยะเวลา ramp up จาก 0 → MAX_USERS |
| `HOLD` | ตาม preset | ระยะเวลาคงที่ MAX_USERS |
| `RAMP_DOWN` | ตาม preset | ระยะเวลา ramp down จาก MAX_USERS → 0 |
| `WATCH_SECONDS` | ตาม preset | ระยะเวลาที่แต่ละ VU ดูสตรีม/iteration |

## Thresholds (เกณฑ์ pass/fail)

| Metric | เกณฑ์ |
|---|---|
| `http_req_failed` | rate < 10% |
| `errors_401_total` | count < 1 |
| `playlist_load_ms` | p(95) < 3000ms |
| `segment_load_ms` | p(95) < 5000ms |
| `playback_success_rate` | rate > 95% |

ถ้า metric ใดไม่ผ่าน threshold k6 จะ exit ด้วย code 99

## Custom Metrics

| Metric | ชนิด | ความหมาย |
|---|---|---|
| `errors_401_total` | Counter | จำนวน 401 (auth fail) |
| `errors_4xx_total` | Counter | จำนวน 4xx อื่น ๆ |
| `errors_5xx_total` | Counter | จำนวน server error |
| `playlist_load_ms` | Trend | เวลา load m3u8 |
| `segment_load_ms` | Trend | เวลา load .ts segment |
| `segment_bytes_total` | Counter | ขนาดรวมของ segment ที่โหลด (byte) |
| `segments_downloaded_total` | Counter | จำนวน segment ที่โหลดสำเร็จ |
| `playback_success_rate` | Rate | อัตราสำเร็จของ playback loop |

## ผลลัพธ์หลังรัน

- **stdout** — สรุปแบบ text + custom log
  - จำนวน 401
  - จำนวน segment ที่โหลด
  - bandwidth รวม (MB)
- **report.html** — รายงานแบบ visual เปิดใน browser ได้เลย
- **summary.json** — JSON สรุป metrics ทั้งหมด
- **raw.json** *(ถ้าใช้ `--out json=raw.json`)* — ทุก data point

## ตัวอย่าง use case

**Smoke test** — ทดสอบเร็ว ๆ ว่าระบบรับ load ขั้นต่ำได้
```powershell
k6 run -e MAX_USERS=10 -e HOLD=20s -e WATCH_SECONDS=20 load-test.js
```

**Stress test** — ดันจนพัง
```powershell
k6 run -e MAX_USERS=500 -e RAMP_UP=1m -e HOLD=5m -e WATCH_SECONDS=180 load-test.js
```

**Soak test** — ทดสอบยาวหา memory leak / degradation
```powershell
k6 run -e MAX_USERS=100 -e HOLD=30m -e WATCH_SECONDS=300 load-test.js
```

## หมายเหตุ

- ถ้าเจอ 401 บ่อย → token ใน URL อาจหมดอายุหรือถูก rate-limit
- ถ้า `segment_load_ms` p95 สูงผิดปกติ → origin/CDN ส่งช้า ตรวจ bandwidth ฝั่ง origin
- `WATCH_SECONDS` มากกว่า `HOLD` ได้ — VU จะถูกหยุดกลางคันใน `gracefulRampDown`
- สคริปต์เลือก variant แรกใน master playlist; ถ้าอยาก test เฉพาะ bitrate ให้ใส่ media playlist URL ตรง ๆ ใน `PLAYLIST_URL`

---

## Infrastructure Scaling Plan

### สถานะปัจจุบัน (ณ มิ.ย. 2026)

| ระดับ | สถานะ | playback success |
|---|---|---|
| 1,000 viewers | ✅ ผ่าน | ~99% |
| 2,000 viewers | ✅ ผ่าน | ~98% |
| 3,000 viewers | ❌ ยังไม่ผ่าน | ~57% |

**Bottleneck หลักที่พบ:**
- HAProxy Ingress: 2 pods / 250m CPU — รับ TLS 3,000 concurrent connections ไม่ไหว
- k6 test machine: single machine จำลอง 3,000 VUs + TLS พร้อมกันได้ไม่ครบ
- MediaMTX: single pod 3 CPU — origin ตัวเดียวสำหรับ HLS playlist

---

### เป้าหมาย 10,000 Viewers

**Bandwidth ที่ต้องการ:**
- 360p only: ~70 MB/s (~560 Mbps)
- Mixed ABR (360p/480p/720p): ~150-200 MB/s (~1.6 Gbps)

**Infrastructure ที่ต้องเพิ่ม:**

| Component | ปัจจุบัน | ต้องการ | หมายเหตุ |
|---|---|---|---|
| Worker nodes | 2 nodes (4 CPU / 8Gi each) | **+3 nodes** (4 CPU / 8Gi each) | รองรับ nginx-hls-cache pods เพิ่ม |
| nginx-hls-cache pods | 10 pods / 250m CPU | **20 pods** / 500m CPU | scale horizontal |
| HAProxy | 2 pods / 250m CPU | **5 pods** (DaemonSet ทุก node) / **1 CPU each** | ลด TLS bottleneck |
| MediaMTX CPU limit | 3 CPU | **4 CPU** | เพิ่ม origin capacity |
| Network bandwidth | ~1 Gbps | **2-5 Gbps** uplink | ต้องขอ infra ตรวจสอบ |
| k6 test machines | 1 เครื่อง | **3 เครื่อง** (k6 distributed) | แต่ละเครื่อง 8 core / 16 GB RAM |

**Kubernetes config ที่ต้องแก้:**
```yaml
# nginx-hls-cache: เพิ่ม replicas
replicas: 20

# HPA: เพิ่ม maxReplicas
maxReplicas: 30

# HAProxy DaemonSet: เพิ่ม CPU
resources:
  requests:
    cpu: 500m
  limits:
    cpu: "1"
```

**คำสั่งรัน load test 10,000:**
```powershell
# ต้องใช้ k6 distributed (k6 cloud หรือ k6 operator บน Kubernetes)
k6 run `
  -e PLAYLIST_URL="https://www.hips-stream.com/hls/live/<streamKey>_360p/index.m3u8" `
  -e MAX_USERS=10000 `
  -e RAMP_UP=5m `
  -e HOLD=10m `
  -e RAMP_DOWN=2m `
  -e WATCH_SECONDS=120 `
  load-test.js
```

---

คำสั่ง run windows terminal for 2000 views
k6 run `
>>   -e PLAYLIST_URL="https://www.hips-stream.com/hls/live/sk_bEygY58kpX5TMx2NuE--3oAAjfJh4XtO_360p/index.m3u8" `
>>   -e MAX_USERS=2000 `
>>   -e RAMP_UP=120s `
>>   -e HOLD=5m `
>>   -e RAMP_DOWN=60s `
>>   -e INITIAL_SEGMENTS=1 `
>>   "load-test.js"