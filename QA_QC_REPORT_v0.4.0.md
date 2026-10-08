# Báo Cáo QA/QC Đợt Cuối Trước Release v0.4.0

Current follow-up: [v0.4.1 QA](QA_QC_REPORT_v0.4.1.md) records benchmark isolation remediation
and the new release review. The evidence below retains its original snapshot.

**Dự án:** SlncTrZ-MCP Gateway  
**Môi trường kiểm thử:** Windows x64 (Node.js 22.x, Vitest 4.1.11, TypeScript 6.0.3)  
**Thời gian thực hiện:** 2026-10-08  
**Trạng thái kết luận:** SOURCE QA PASSED — CHƯA ĐỦ BẰNG CHỨNG RELEASE STABLE

> Các mục 1–4 ghi lại source QA trước khi bump version, tại commit báo cáo 6055dfd.
> Kết quả này không chứng nhận artifact công khai. Xem phụ lục xác minh release bên dưới.

---

## 1. Mục Tiêu & Phạm Vi Kiểm Thử

Đợt QA/QC cuối cùng nhằm rà soát toàn diện mã nguồn, tài liệu kỹ thuật và các quy chuẩn bảo mật trước khi đóng gói và gắn nhãn bản phát hành v0.4.0:

- **Logic mã nguồn các phân hệ trọng yếu:**
  - `src/auth`: Xác thực OAuth 2.1 PKCE, hồ sơ Gateway-only, Schema v3, ceiling bất biến, cơ chế rotate refresh token.
  - `src/kernel`: Ranh giới filesystem Restricted vs Autonomous, ngăn chặn secret path, ghi nguyên tử (`core.write`), thay thế chuỗi chính xác (`core.edit`), đọc ảnh an toàn (`media.read_image`).
  - `src/context`: Khởi tạo harness (`context.bootstrap`), phân phối skills lũy tiến (`skills.read`, `skills.list`), kiểm soát thời hạn context receipt.
  - `src/task`: Quản lý runner nền (`task.start`, `task.cancel`), điều phối đa agent (`task.create`, `task.claim`, `task.release`), hủy tiến trình con sạch sẽ.
  - `src/debate`: Lưu trữ SQLite tranh luận 2 tác tử, luân chuyển lượt, chứng thực credential thành viên.
  - `src/extension`: Giám sát nhà cung cấp MCP hạ tầng, cô lập tiến trình con, retry phục hồi phiên rejected.
  - `src/owner`: Bảng điều khiển Owner Console, hiển thị biểu đồ usage, ngăn chặn leo thang quyền kết nối.
  - `src/standalone`: Quản lý cài đặt/gỡ bỏ độc lập, kiểm tra layout thư mục (`assertManagedRootLayout`), xử lý đường dẫn canonical Windows.
  - `src/lifecycle`: Bổ sung module sổ ghi chép vòng đời hoạt động (`src/lifecycle/operation-ledger.ts`).
- **So sánh mã nguồn với tài liệu & KB:**
  - Đối chiếu danh mục công cụ MCP được đăng ký thực tế với hướng dẫn người dùng (`docs/USER_GUIDE.md`, `docs/MODEL_GUIDE.md`, `docs/CODING_AGENTS.md`).
  - Đối chiếu các cam kết bảo mật (`SECURITY.md`, `docs/THREAT_MODEL.md`) với cơ chế fail-closed trong code.
  - Kiểm tra tính đầy đủ của tài liệu kiến trúc, rà soát liên kết và mỏ neo (dead links/anchors).

---

## 2. Các Khiếm Khuyết Phát Hiện & Khắc Phục Thực Tế (Remediations & Evidence)

### Khiếm khuyết 1: File mã nguồn và bài test lifecycle chưa được đưa vào kiểm soát phiên bản (Untracked)

- **Hiện trạng:** Module `src/lifecycle/operation-ledger.ts` và test `tests/unit/lifecycle-operation-ledger.test.ts` nằm ở trạng thái untracked trong git.
- **Phân tích logic:** Module cung cấp cơ chế lưu trữ JSONL append-only với `fsync` bắt buộc, loại bỏ các trường bí mật/nhạy cảm (secret sanitization) và xác thực danh tính PID + epoch trước khi khôi phục tiến trình. Code có đầy đủ logic nhưng chưa được commit vào repository.
- **Hành động khắc phục:** Đã chạy static checks, kiểm tra test case và đưa vào commit chính thức:
  - Commit ID: `210f310` (`feat(lifecycle): add durable file-backed operation ledger`).

### Khiếm khuyết 2: Thiếu tài liệu đặc tả kiến trúc `docs/LIFECYCLE_WIRING.md`

- **Hiện trạng:** Chú thích tài liệu trong `src/lifecycle/operation-ledger.ts` trực tiếp trỏ đến `docs/LIFECYCLE_WIRING.md` ("_Wiring points for a future execution controller live in docs/LIFECYCLE_WIRING.md_"), tuy nhiên tệp tài liệu này chưa từng tồn tại trong cây thư mục `docs/`.
- **Hành động khắc phục:**
  1. Biên soạn hoàn chỉnh tệp tài liệu `docs/LIFECYCLE_WIRING.md` quy định rõ:
     - Cơ chế bảo đảm tính toàn vẹn (Crash consistency, fsync, secret redaction).
     - Mô hình bản ghi thao tác (Actions: `ensure`/`stop`; States: `requested`, `in_progress`, `ready`, `blocked`, `partial`, `failed`, `stopped`).
     - Điểm kết nối kỹ thuật cho Execution Controller tương lai (`<stateRoot>/lifecycle/operations.jsonl`, phương thức `verifyOperationIdentity` khi restart).
  2. Cập nhật mục lục tài liệu tại `docs/README.md` liên kết trực tiếp đến `docs/LIFECYCLE_WIRING.md`.

### Khiếm khuyết 3: Lỗi EPERM khi chạy test tạo symlink trên môi trường Windows

- **Hiện trạng:** Lệnh `npm test` gặp lỗi thất bại tại 2 tệp test:
  - `tests/conformance/media-image-e2e.test.ts`: `Error: EPERM: operation not permitted, symlink`
  - `tests/unit/harness-runtime.test.ts`: `Error: EPERM: operation not permitted, symlink`
- **Nguyên nhân:** Trên hệ điều hành Windows, việc tạo file symlink đòi hỏi quyền Administrator hoặc Developer Mode (`SeCreateSymbolicLinkPrivilege`). Khi chạy trên user thường, Node.js văng lỗi `EPERM`. Trong khi các module test khác (`fs-search.test.ts`, `fs-read.test.ts`, `fs-write.test.ts`, `fs-edit.test.ts`, `fs-boundary.test.ts`) đều đã có khối `try/catch` bỏ qua trường hợp môi trường không cấp quyền symlink, thì 2 tệp trên bị thiếu.
- **Hành động khắc phục:** Bổ sung cơ chế guard với biến cờ `hasSymlink` và khối `try/catch`:
  - Tại `tests/conformance/media-image-e2e.test.ts`: Bọc `symlink(...)` trong `try/catch`, chỉ đưa `escape.png` vào danh sách assert kiểm tra khi symlink được tạo thành công.
  - Tại `tests/unit/harness-runtime.test.ts`: Bọc `symlink(...)` trong `try/catch`, chỉ đưa `references/link.txt` vào tập danh nguyên cần từ chối khi symlink được tạo thành công.
  - Commit ID: `3e2903b` (`fix(qa): guard windows symlinks and add lifecycle wiring specification`).

### Khiếm khuyết 4: Lệch chuẩn định dạng code (Prettier Code Style)

- **Hiện trạng:** Công cụ `npm run check` cảnh báo lệch định dạng sau khi chỉnh sửa các tệp test và tài liệu Markdown.
- **Hành động khắc phục:** Thực thi `npx prettier --write` chuẩn hóa toàn bộ tệp TypeScript và Markdown bị ảnh hưởng, đảm bảo vượt qua `format:check`.

---

## 3. Bằng Chứng Xác Minh (Verification Evidence)

### 3.1. Kết Quả Kiểm Thử Toàn Bộ Test Suite (`npm test`)

```text
 RUN  v4.1.11 H:/Develop/SlncTrZ-MCP

 Test Files  99 passed | 1 skipped (100 files)
      Tests  721 passed | 25 skipped (746 tests)
   Duration  21.77s
```

- **Kết quả:** 100% test files được thực thi thành công (0 failed).

### 3.2. Kiểm Tra Ràng Buộc Hợp Đồng Tài Liệu (`npm run docs:check`)

```text
> slnctrz-mcp@0.3.7 docs:check
> node scripts/docs-check.mjs

{"status":"pass","version":"0.3.7","node":">=22.13.0 <25"}
```

- **Kết quả:** Vượt qua toàn bộ kiểm tra hợp đồng tài liệu (hợp lệ 100% về công cụ, liên kết chéo, neo anchor, phiên bản engine và danh mục phụ thuộc runtime).

### 3.3. Kiểm Tra Toàn Bộ Cổng Chất Lượng Tĩnh (`npm run check`)

```text
> slnctrz-mcp@0.3.7 check
> node scripts/check.mjs

Checking formatting...
All matched files use Prettier code style!

 RUN  v4.1.11 H:/Develop/SlncTrZ-MCP

 Test Files  99 passed | 1 skipped (100)
      Tests  721 passed | 25 skipped (746)
```

- **Kết quả:** Typecheck (TypeScript), Linter (ESLint), Format (Prettier) và Test Suite đồng thời đạt trạng thái PASS.

### 3.4. Kiểm Tra Biên Dịch Phát Hành (`npm run build`)

```text
> slnctrz-mcp@0.3.7 build
> tsc -p tsconfig.build.json
```

- **Kết quả:** Biên dịch thành công gói mã nguồn phân phối tại `dist/` mà không phát sinh bất kỳ lỗi hoặc cảnh báo nào.

---

## 4. Kết Luận & Khuyến Nghị

1. **Tính Ổn Định:** Toàn bộ các phân hệ chính (OAuth 2.1, Ranh giới Filesystem, Task Runner, Provider Supervisor, Owner Dashboard, Standalone Layout và Lifecycle Ledger) hoạt động chính xác theo đặc tả.
2. **Khắc Phục Hoàn Tất:** Toàn bộ khiếm khuyết được phát hiện đã được khắc phục trực tiếp trong mã nguồn và tài liệu, có commit định danh rõ ràng.
3. **Mức Độ Sẵn Sàng:** Kho nguồn vượt qua các kiểm tra source QA được ghi nhận ở mục 3. Release Acceptance còn yêu cầu native artifact, signing và các cổng public installed-artifact tại RELEASE.md; kết quả source QA không thay thế các bằng chứng này.

---

## 5. Kiểm chứng findings và điều kiện release — 2026-10-08

Kiểm chứng tại kho đã chuyển sang `H:\Develop\SlncTrZ\SlncTrZ-MCP`
(gateway: `/mnt/pc-dev/SlncTrZ/SlncTrZ-MCP`). Baseline là
`554ba3c1014b54203a41c314eb13f3814c3bd6ef`; các bản vá dưới đây còn ở working tree,
chưa commit, push, thay tag hoặc deploy.

### 5.1. Findings đã xử lý

| Finding                                                                 | Bản vá và bằng chứng                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows uninstall báo đã schedule nhưng helper chưa khởi tạo thành công | Dùng đường dẫn tuyệt đối tới CMD/PowerShell, cwd bên ngoài thư mục bị xóa, handshake ready/go có thời hạn; lỗi khởi động trả lỗi và giữ nguyên dữ liệu. Native baseline tái hiện lỗi khi PATH thiếu PowerShell. Nguyên nhân chính xác trên GitHub hosted runner chưa được chứng minh. |
| Thiếu coverage cho startup failure và môi trường uninstall              | Thêm ba regression test giữ nguyên file khi spawn lỗi, helper thoát sớm hoặc không xác nhận ready. Native smoke thêm PATH tối giản, cwd trong install root và đường dẫn chứa ký tự đặc biệt; đợi tất cả mục cần xóa hoàn tất.                                                         |
| OAuth legacy migration vượt timeout 5 giây trên Windows CI              | Seed SQLite fixture trong một transaction; timeout riêng Windows 15 giây, giữ nguyên assertions migration. Không đổi production OAuth logic.                                                                                                                                          |
| source-map-js 1.2.1 có advisory High trong dependency phát triển        | Lock riêng dependency bắc cầu lên 1.2.2, theo GHSA-68fv-2mgg-jv7q. Cài lại từ lockfile và audit đầy đủ trên hai nền tảng: 0 vulnerabilities.                                                                                                                                          |
| Báo cáo source QA bị hiểu như chứng nhận stable release                 | Thu hẹp trạng thái báo cáo và ghi riêng các cổng release còn thiếu ở mục 5.3.                                                                                                                                                                                                         |

### 5.2. Kết quả kiểm chứng tại máy

| Cổng kiểm chứng                                               | Windows x64                  | Linux x64                      |
| ------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| Node cho kiểm chứng                                           | 24.21.0                      | 24.19.0                        |
| Typecheck, lint, format, test sau cài lại lockfile            | PASS; 724 passed, 25 skipped | PASS; 739 passed, 10 skipped   |
| Test files                                                    | 100 passed, 1 skipped        | 100 passed, 1 skipped          |
| Docs check                                                    | PASS, version 0.4.0          | PASS, version 0.4.0            |
| Build TypeScript                                              | PASS                         | PASS trước bản vá lockfile dev |
| Native SEA build, coding harness smoke, release identity gate | PASS                         | PASS                           |
| Native uninstall matrix                                       | 33/33 PASS                   | 27/27 PASS                     |
| npm audit đầy đủ sau bản vá lockfile                          | 0 vulnerabilities            | 0 vulnerabilities              |

Linux kiểm chứng trong checkout tạm độc lập để không thay dependency Windows trong
kho dùng chung. Các SEA được build từ mã nguồn đã vá trước thay đổi lockfile chỉ dành
cho dev; dùng public verification key dùng một lần và release URL example.invalid.
Đây là artifact kiểm chứng tại máy, chưa phải artifact release đã ký và công bố.

| Artifact kiểm chứng          | Build identity             | SHA-256                                                          |
| ---------------------------- | -------------------------- | ---------------------------------------------------------------- |
| win32-x64, 95,640,576 bytes  | 554ba3c-native-repro       | eb31f7b9dc8b4fab64e1637e3163a049e4ebea0688ac5ccc068933d4a02b0870 |
| linux-x64, 127,995,072 bytes | 554ba3c-local-verification | eea5dcfe6183f65be2a3baf69543be17b69621a32a4722e66994bbe42c330ab4 |

### 5.3. Các điều kiện release chưa hoàn tất

- Main CI [run 37712521964](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37712521964)
  ghi nhận failure ở OAuth legacy migration; chưa có CI chạy bản vá working tree.
- Release [run 37712555541](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37712555541)
  ghi nhận failure Windows native uninstall. Signing/publish và các cổng phụ thuộc
  chưa hoàn tất; cần kiểm chứng lại trên hosted runner.
- Tag `v0.4.0` hiện trỏ về baseline 554ba3c, chưa chứa bản vá. Cần chọn cách
  phát hành phù hợp trước khi tạo release candidate mới; báo cáo này không thay tag.
- Chưa có public release v0.4.0 tại thời điểm kiểm tra; public release mới nhất là
  v0.3.7. Gateway đang chạy v0.3.7, chưa được nâng cấp.
- Còn cần signed public candidate, clean-install acceptance trên Windows/Linux,
  kiểm chứng `/usage` theo RELEASE.md và promotion gate.

**Kết luận hiện tại:** Source QA và các native checks tại máy PASS; chưa đủ bằng
chứng để xác nhận stable release v0.4.0.

---

## 6. Đồng bộ docs và kiểm chuẩn đầy đủ — 2026-10-08

### 6.1. Phạm vi và kết quả rà tài liệu

Rà 77 tài liệu Markdown (76 đã tracked và 1 tài liệu trạng thái mới); cập nhật 32
tài liệu hiện hành (tính cả báo cáo này và docs/PROJECT_STATUS.md). ADR/release notes cũ
được giữ như bằng chứng lịch sử; bổ sung current-contract note cho OAuth v3 ở ADR-011/012.

- Sửa CLI start/stop không tồn tại, hướng dẫn launcher/systemd, backup và uninstall retention.
- Đồng bộ state/config layout, hash/token metadata, giới hạn context, Full/Gateway-only và rollback schema.
- Phân biệt hai skill embedded/seed mặc định với các skill chỉ có trong repo.
- Làm rõ STDIO/HTTP, protocol server/discover, provider authority/recovery và credential rotation.
- Sửa claim ký SEA thành Ed25519 ký manifest, với size/SHA-256 ràng buộc binary.
- Ghi đúng lifecycle ledger chưa wired, giới hạn shutdown và telemetry.
- Đồng bộ roadmap, dependency provenance, release gates và source/public/running identities.
- Mở rộng docs:check tới tài liệu skills và self-anchor; chặn lệnh CLI tưởng tượng,
  chấp nhận line wrapping mà vẫn kiểm tra required text.

### 6.2. Ma trận chạy lại sau đồng bộ docs

| Cổng                                      | Windows x64            | Linux x64 Node 24      | Linux x64 Node 22                             |
| ----------------------------------------- | ---------------------- | ---------------------- | --------------------------------------------- |
| Runtime                                   | 24.21.0                | 24.19.0                | 22.23.3                                       |
| Full check: typecheck/lint/format/tests   | PASS                   | PASS                   | PASS                                          |
| Test cases                                | 724 passed, 25 skipped | 739 passed, 10 skipped | 739 passed, 10 skipped                        |
| Test files                                | 100 passed, 1 skipped  | 100 passed, 1 skipped  | 100 passed, 1 skipped                         |
| Docs contract                             | PASS                   | PASS                   | PASS                                          |
| Developer build                           | PASS                   | PASS                   | PASS                                          |
| Full npm audit                            | 0 vulnerabilities      | 0 vulnerabilities      | 0 vulnerabilities                             |
| License inventory                         | 209 entries, 0 UNKNOWN | 209 entries, 0 UNKNOWN | 209 entries, 0 UNKNOWN                        |
| Harness benchmark                         | PASS                   | PASS                   | PASS                                          |
| Native SEA rebuild                        | PASS                   | PASS                   | Không phải SEA build target trong ma trận này |
| Native gateway/assets/OAuth/harness smoke | PASS                   | PASS                   | Source conformance trong full suite           |
| Native uninstall                          | 33/33 PASS             | 27/27 PASS             | Không chạy SEA uninstall                      |
| Native identity/hash gate                 | PASS                   | PASS                   | Không chạy SEA identity                       |
| Optional image-path conformance           | 5/5 PASS               | 5/5 PASS               | Fixture image tests trong full suite          |

Các skip theo platform/test điều kiện được ghi riêng, không được tính là PASS. Optional
SLNCTRZ_IMAGE_SMOKE_PATH đã được bật thêm trên Windows/Linux Node 24 với ảnh intro thuộc repo;
test transport/read đạt 5/5 trên mỗi máy. Kết quả này không chứng minh model perception,
attachment display hay installed public-artifact image acceptance.

Linux chạy trong checkout/dependency tách biệt để không thay node_modules Windows trên
repo dùng chung. Node 22.23.3 được tải từ nodejs.org và kiểm tra SHA-256 theo SHASUMS256.txt.

Hai SEA đã rebuild vì Model Guide được nhúng trong binary. Dùng verification public key
dùng một lần, example.invalid URL và build marker local; không dùng private signing key
production và không publish. Fingerprinting mới:

| Target    | Build marker               |     Bytes | SHA-256                                                          |
| --------- | -------------------------- | --------: | ---------------------------------------------------------------- |
| win32-x64 | 554ba3c-docs-refresh-local |  95642112 | d75dc4fde9decba154fc489b3aa1a4e40e261f82a1132f12a8dd9726b4738945 |
| linux-x64 | 554ba3c-docs-refresh-local | 127995072 | d58a05cf338214533df5e8dc897dae6516c7d300bf127a9ac0642dfd47d0a838 |

SHA-256 Model Guide nguồn đã đối chiếu trên ba checkout:
a4187d90b4c56cff952a79d68dbc7184c72f448a4f18b2362f0f47af5204f496.
Build marker là định danh kiểm chứng local, không phải một commit đã tồn tại.

### 6.3. Latency / Scalability tại máy

Harness fixture: 128 skills, 30 preflight tuần tự; concurrency 8, 64 requests.

| Nền tảng        | Sequential p95 (ms) | Concurrent p95 (ms) | Requests/s |
| --------------- | ------------------: | ------------------: | ---------: |
| Windows Node 24 |               27.91 |               26.12 |     337.22 |
| Linux Node 24   |              110.87 |               72.83 |     135.90 |
| Linux Node 22   |               81.28 |               61.92 |     151.40 |

Đây là số đo fixture tại máy, không phải SLO, dispatch Latency của CAD provider hay chứng
nhận production capacity. Không suy diễn so sánh hiệu năng OS từ các lần đo khác tải/máy.

Cold-start Linux Node 24: warmup 1, samples 5; CLI help p95 633.41 ms, gateway readiness
p95 810.29 ms. Loopback MCP protocol ping: 100 samples, p50 5.75 ms, p95 7.58 ms.
Field authenticatedCorePing trong benchmark JSON hiện gọi protocol method ping, không
phải tools/call core.ping; không dùng nó như số đo tool-dispatch overhead.

**Finding còn mở trong benchmark gốc:** scripts/benchmark.mjs dựng child environment
không chỉ định stateRoot, nên gateway child có thể dùng state/policy/providers thật của
tài khoản. Lượt kiểm chứng Linux ban đầu đã dừng trước benchmark; số đo trên chạy bằng
bản sao fixture tạm có explicit private stateRoot và cleanup. Không sửa source benchmark
trong phạm vi docs này. ENGINEERING.md giới hạn script gốc vào disposable account.
Full source tests/native gates không phụ thuộc bản sao benchmark này.

### 6.4. Release và deployment

GitHub API được đối chiếu lại trong lượt này: public latest vẫn v0.3.7, public v0.4.0 trả
404, hai hosted runs ở mục 5.3 vẫn failure trên baseline 554ba3c.
core.ping của gateway đang phục vụ vẫn v0.3.7, build
141a26ab43d7eda357ff2ab6ef1114641650853f.

**Đã hoàn tất:** đồng bộ docs hiện hành, full supported source matrix, native trial gateway,
OAuth/harness, uninstall/identity và audit tại máy.
**Còn:** harden benchmark gốc nếu cần chạy trên tài khoản có installation; commit/review,
hosted CI trên ref có bản vá, ký/public candidate, clean public install/Usage browser acceptance
và các claim System Install/real-client/signing custody tương ứng. Chưa commit/push/tag/deploy.
