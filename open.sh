#!/bin/bash

k6 run \
  -e PLAYLIST_URL="https://www.hips-stream.com/hls/live/sk_bEygY58kpX5TMx2NuE--3oAAjfJh4XtO_360p/index.m3u8" \
  -e MAX_USERS=2000 \
  -e RAMP_UP=120s \
  -e HOLD=5m \
  -e RAMP_DOWN=60s \
  -e INITIAL_SEGMENTS=1 \
  load-test.js