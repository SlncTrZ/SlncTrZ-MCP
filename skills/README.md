# Skills

> Thư mục chứa skill (reusable agent capability) **của dự án SlncTrZ-MCP**.

## Quy ước

- Mỗi skill = 1 thư mục con `skills/<skill-name>/`, kèm `SKILL.md` theo chuẩn skill.
- Đường dẫn chuẩn: `./skills/<skill-name>/SKILL.md` (gốc repo).
- Khi cần dùng / tạo / tải skill → lưu vào đây, track bằng git.
- Thư mục này được tự tạo khi cài / build dự án (postinstall → `scripts/ensure-skills-dir.mjs`).

## Mục tiêu

- Skill gắn với dự án gom về một chỗ trong repo, version cùng code, phân phối được.
- Không dùng chung với cơ chế lưu skill riêng của Pi (`.pi/...`).
