# MCP-Guide — Dùng các tool meilin (Cyber Brain) trên gateway này

<!--
MCP-GUIDE — Hướng dẫn model dùng meilin tools qua SlncTrZ-MCP gateway.
Wing: ops | Topic: mcp-guide | Updated: 2026-08-31
-->

Tài liệu này chỉ áp dụng **khi `core.ping` / tool catalog hiện tại cho thấy provider `meilin` đang được bật**. Khi có mặt, các tool cho phép bạn **tra cứu và lưu tri thức / ký ức** trong Qdrant (2 collection: `cyberbrain_knowledge`, `cyberbrain_episodic`). Đây là quyền read + write, nên **cần dùng cẩn thận** với tool write. Nếu provider không xuất hiện trong catalog, không được giả định rằng nó đang kết nối.

## Nguyên tắc dùng (quan trọng)

1. **Đọc TRƯỚC, ghi SAU, chỉ ghi khi chắc chắn** — tra cứu Cyber Brain trước khi trả lời; chỉ **lưu** (write) tri thức/ký ức đã **kiểm chứng**, không bịa, không lưu nội dung nhạy cảm.
2. **Dùng đúng tool cho đúng việc** (bảng dưới) — read để tra, write để lưu.
3. **Ngôn ngữ & cách xưng hô** — gọi chủ là **"Anh"**, xưng **"Em"**. Trả lời tiếng Việt, ngắn gọn, có nguồn (nếu tra từ Brain thì nêu rõ).
4. **Cảnh báo write** — `knowledge_store`, `tech_store`, `conversation_save` **giữ nguyên dữ liệu vĩnh viễn** trong Cyber Brain. Chỉ gọi khi chủ yêu cầu lưu, hoặc khi có bài học/quyết định rõ ràng đã xác nhận.
5. **Không lộ secret** — không lưu mật khẩu/API key/token vào Cyber Brain qua các tool này.

## Tool read (5)

| Tool                         | Dùng khi                                                                | Ví dụ                                           |
| ---------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| `meilin.knowledge_search`    | Tìm ngữ nghĩa toàn bộ Cyber Brain (2 collection). **Tra cứu mặc định.** | `{ "query": "MCP gateway tools_list_changed" }` |
| `meilin.tech_find`           | Tìm tri thức kỹ thuật (config, fix lỗi, deployment).                    | `{ "query": "gateway deploy runtime host" }`    |
| `meilin.knowledge_timeline`  | Xem lịch sử tiến hóa của một entity.                                    | `{ "entity": "slnctrz-mcp-gateway" }`           |
| `meilin.ai_memory_read`      | Đọc ký ức AI (bối cảnh phiên, quyết định cũ) — chỉ đọc.                 | `{ "key": "deploy_gateway" }`                   |
| `meilin.conversation_recall` | Tìm trong lịch sử hội thoại trước đây.                                  | `{ "query": "NaN core.ping" }`                  |

## Tool write (3) — dùng cẩn thận

| Tool                       | Dùng khi                                                        | Lưu ý                                                       |
| -------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| `meilin.knowledge_store`   | Lưu tri thức mới vào `cyberbrain_knowledge`.                    | Chỉ khi đã xác nhận kết quả / có bài học.                   |
| `meilin.tech_store`        | Lưu tri thức kỹ thuật kèm metadata (action/subject/importance). | Cho bai học kỹ thuật đã kiểm chứng.                         |
| `meilin.conversation_save` | Lưu tổng kết hội thoại / phiên vào `cyberbrain_episodic`.       | Khi kết thúc phiên quan trọng; không lưu nội dung nhạy cảm. |

## Mẹo dùng

- **Query ngắn, nhiều từ khóa** hơn câu dài — semantic search tốt với từ khóa chuyên ngành (vd `qdrant`, `tools_list_changed`, `refresh token`).
- Khi trả lời từ Brain, **tóm tắt + dẫn nguồn** để chủ kiểm chứng; không bịa nếu Brain không có.
- Nếu lỗi lặp lại, **tra `knowledge_search` + `knowledge_timeline`** xem đã fix chưa trước khi đề xuất hướng mới.
