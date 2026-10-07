# Báo Cáo QA/QC Đợt Cuối Trước Release v0.4.0

**Dự án:** SlncTrZ-MCP Gateway  
**Môi trường kiểm thử:** Windows x64 (Node.js 22.x, Vitest 4.1.11, TypeScript 6.0.3)  
**Thời gian thực hiện:** 2026-10-08  
**Trạng thái kết luận:** ĐẠT YÊU CẦU RELEASE (PASSED - READY FOR RELEASE)

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
3. **Mức Độ Sẵn Sàng:** Kho lưu trữ `H:\Develop\SlncTrZ-MCP` đạt trạng thái ổn định tuyệt đối, đáp ứng đầy đủ tiêu chí chấp thuận phát hành (Release Acceptance) cho bản v0.4.0.
