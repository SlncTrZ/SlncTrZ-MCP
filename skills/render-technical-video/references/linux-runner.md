# Linux user-service runner

A browser executable check is not a browser launch test. On a hardened gateway service, Chromium may fail to create its sandbox namespaces even though Chromium is installed.

For an authorized video job, first inspect the execution host, installed browser and the current user's systemd manager. When that user manager is available and authorized for the job, run a bounded transient user service. Keep Chromium's sandbox and the live gateway unit unchanged. Do not ask again for the already-authorized video task merely because a different supported execution mechanism is needed.

Use absolute paths and a fresh output directory. Set runtime limits based on measured work; this example is for a short smoke render:

```bash
runner_uid="$(id -u)"
export XDG_RUNTIME_DIR="/run/user/$runner_uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user is-system-running
systemd-run --user --wait --pipe --collect \
  --property=RuntimeMaxSec=120 \
  --property=MemoryMax=1G --property=CPUQuota=100% \
  /usr/bin/node /absolute/skill/scripts/render.mjs \
  /absolute/job/template.html /absolute/job/new-output
```

Use an available Node executable discovered on the host, not a guessed path. The user manager must already be accessible; do not enable linger, install services, use sudo, modify permissions or change gateway hardening as an implicit workaround. If the user manager is unavailable or denies access, report that concrete result and use another explicitly authorized rendering environment.

The transient service's exit status and report.json/ffprobe results establish success. Check images for layout correctness. Low CPUQuota is intentional on a shared live host; one render at a time. Resource limits are per-job, not changes to the gateway.

Verified example: a 640×360, 10 FPS, three-second FIFO animation produced 30 H.264 frames with yuv420p; reverse-seek and delayed-repeat checks passed using this mechanism. This proves the small job, not arbitrary templates or long-video scalability.
