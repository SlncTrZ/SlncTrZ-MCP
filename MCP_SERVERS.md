# MCP Servers — Chuẩn đấu nối MCP cho SlncTrZ-MCP Gateway

> Chuẩn chung cho việc **đấu nối (connect) một MCP server** vào gateway, và **chuẩn tối thiểu**
> mà một MCP server phải thoả để được đấu nối. Tài liệu này dùng cho cả người **vận hành MCP
> server** (phía cung cấp) lẫn người **đấu nối** (phía dùng gateway). Không gắn với server cụ thể
> nào; mọi ví dụ đều dùng host `mcp.example.com` / `my-mcp` làm mẫu chung.

---

## 1. Cách thêm MCP server

Dùng **Owner Console → MCP Servers → Add MCP**. Điền các field, bấm **Probe & Add**. Gateway
sẽ: probe server → khám phá tools → lưu cấu hình → bật provider → nạp lại catalog tool.

---

## 2. Khung chung — các field

| Field           | Giải thích                                                                 | Quy tắc                                                                                |
| --------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Name**        | Nhãn hiển thị, vd `Filesystem`, `GitHub`                                   | Tuỳ chọn, dễ nhớ                                                                       |
| **Provider ID** | id ổn định, viết thường                                                    | **Bắt buộc**: chỉ `a-z`, `0-9`, `-`, độ dài ≤ 64 — vì nó tạo namespace `provider.tool` |
| **Description** | Ghi chú ngắn                                                               | Tuỳ chọn                                                                               |
| **Transport**   | `Remote URL` (streamable-http) / `Local command` (stdio)                   | Chọn theo dạng server                                                                  |
| **Target**      | Remote: URL endpoint đầy đủ; Local: **absolute path** executable           | Xem quy tắc từng case                                                                  |
| **Args**        | Chỉ khai khi stdio; tham số truyền cho executable, cách nhau bằng dấu cách | Không dùng cho Remote URL                                                              |
| **Auth**        | `No auth` / `Bearer` / `HTTP header`                                       | Normal Owner Console flow; xem mục 6                                                   |
| **Header name** | Chỉ cần cho `HTTP header`                                                  | Tên custom header                                                                      |
| **Credential**  | Giá trị bí mật                                                             | **Không bao giờ** đặt trong URL / command / args / description                         |

---

## 3. Chuẩn tối thiểu để đấu nối được

Đấu nối không thể "chỉ điền một cái URL" là xong. Phải khớp **3 tầng**: transport đúng + xác
thực đúng + protocol/discovery đúng. Nếu thiếu xác thực, server từ chối; nếu hai bên không khớp
auth mode, probe fail.

### 3a. Bắt buộc phía SERVER (người cung cấp MCP)

Điều kiện tối thiểu để một MCP server "có thể đấu nối được":

1. **Transport phù hợp** — Remote: endpoint **HTTPS**; Local: executable/script đọc/write stdio.
2. **Protocol MCP đúng** — JSON-RPC 2.0; hỗ trợ `server/discover` (bản `2026-07-28`) hoặc fallback
   `initialize` (bản `2025-11-25`). Gateway tự negotiate.
3. **Discovery** — `tools/list` phải trả danh sách tool với **tên bare** (vd `knowledge_search`).
   Gateway tự namespaced thành `provider.knowledge_search` (ADR-026).
4. **Xác thực** (trừ khi server thực sự public) — server **bắt buộc** nhận và validate credential
   mà gateway chèn (mục 6). Thuộc **Bearer** hoặc **HTTP header**.
5. **Endpoint sạch** — URL không mang token / user / pass / query / fragment.
6. **Bounded output** — gateway cắt response ở `maxOutputBytes` (mặc định 1 MB) và mỗi message
   ở `maxMessageBytes` (mặc định 64 KB); tool list + kết quả nên nằm trong cap này.

### 3b. Bắt buộc phía GATEWAY (người đấu nối)

1. **Chọn đúng transport** theo dạng server (Remote URL vs Local command).
2. **Target không mang credential** — secret chỉ nằm trong credential store (opaque ref).
3. **Auth đúng** — khớp chính xác cơ chế server đang dùng (mục 6).
4. **Probe phải PASS** — gateway chỉ persist khi probe thật sự trả `tools/list`; fail thì rollback sạch.
5. **Verify sau khi thêm** — qua `core.ping` (mục 9) và Refresh/Scan tools phía client.

---

## 4. Bảng quyết định nhanh — trường hợp ↔ đấu nối

| #   | Trường hợp           | Transport     | Target                                       | Auth                           | Quy tắc bắt buộc                                                                     |
| --- | -------------------- | ------------- | -------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | **Remote HTTPS**     | Remote URL    | `https://mcp.example.com/mcp`                | No auth / Bearer / HTTP header | **Chỉ `https://`**; cấm token/query/user/pass/fragment trong URL                     |
| 2   | **Local executable** | Local command | `/usr/local/bin/my-mcp`                      | thường No auth                 | **Target = absolute path**; cấm shell expression (`pipe`, `&&`, `;`, `$()`)          |
| 3   | **Node / JS script** | Local command | `/usr/bin/node`                              | No auth                        | Script nằm ở **Args**; không nhét `node /path` vào Target                            |
| 4   | **Python script**    | Local command | `/usr/bin/python3` (hoặc `.venv/bin/python`) | No auth                        | Script nằm ở Args; venv thì trỏ Target thẳng vào python của venv                     |
| 5   | **Loopback HTTP**    | Remote URL    | `http://127.0.0.1:3003/mcp`                  | thường No auth                 | **Chỉ** `127.0.0.0/8`, `localhost`, `.localhost`, `::1`; cấm host thật / `192.168.x` |

---

## 5. Từng trường hợp

### 5.1 Remote MCP URL (HTTPS)

Dùng khi MCP server chạy ở host khác / qua HTTPS.

- Target: `https://mcp.example.com/mcp`
- Auth: `No auth`, `Bearer`, hoặc `HTTP header`

Quy tắc:

- `https://` cho host thật.
- `http://` **chỉ** được phép cho loopback (`127.0.0.1`, `localhost`) — xem case 5.
- Không đặt token / query string / tài khoản / mật khẩu / fragment trong URL.

Ví dụ Bearer:

- Auth: `Bearer`, Credential: `<token>`, Header/env name: bỏ trống.

Ví dụ HTTP header:

- Auth: `HTTP header`, Header/env name: `X-API-Key`, Credential: `<api-key>`.

### 5.2 Local executable

Dùng khi MCP server đã là một file executable.

- Target: `/usr/local/bin/my-mcp`
- Args: `--stdio` (nếu cần)
- Auth: thường `No auth`

Quan trọng: **Target phải là absolute path executable**. Không điền shell expression như
`|`, `&&`, `;`, `$(...)`.

### 5.3 Node / JavaScript MCP script

Dùng khi MCP server là script Node. Command = Node executable; đường dẫn script nằm ở **Args**.

- Target: `/usr/bin/node`
- Args: `/opt/my-mcp/server.js` (thêm `--mode production` nếu cần)
- Auth: `No auth`

Không nhét `node /path/server.js` vào Target — Target chỉ là executable path.

### 5.4 Python MCP script

Dùng khi MCP server là script Python. Command = Python executable; script nằm ở **Args**.

- Target: `/usr/bin/python3`
- Args: `/opt/my-mcp/server.py`
- Auth: `No auth`

Với venv: trỏ Target thẳng vào python của venv:

- Target: `/opt/my-mcp/.venv/bin/python`
- Args: `/opt/my-mcp/server.py`

### 5.5 Loopback HTTP (nội bộ)

Trường hợp đặc biệt cho MCP server chạy ngay trên máy gateway, qua HTTP loopback
(ADR-025). Cho phép `http://` **chỉ khi** host là loopback.

- Target: `http://127.0.0.1:3003/mcp`
- Auth: thường `No auth`

Quy tắc fail-closed:

- Chỉ nhận `127.0.0.0/8`, `localhost`, `.localhost`, `::1` (và dạng IPv4-mapped `::ffff:127.0.0.1`).
- **Cấm** `192.168.x.x`, `10.x`, host domain thật (`.truongcongdinh.org`, v.v.) qua `http://` — những
  host đó bắt buộc HTTPS.
- Redirect chỉ được **same-origin** (scheme + host + port); không cho đổi port/host/giảm HTTPS.
- Probe phải hoàn tất handshake + khám phá tool mới được persist; non-MCP service fail → rollback.

---

## 6. Xác thực (trọng tâm)

Credentials được lưu tách riêng trong **secret store** (opaque ref), không bao giờ nằm trong
manifest / URL / args / description / audit. Gateway chèn credential vào request khi gọi server.
Đây là cách server nhận credential:

| Auth mode                | Gateway gửi                                           | Khi nào dùng                                                                             |
| ------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Bearer**               | `Authorization: Bearer <value>`                       | Server dùng token chuẩn Bearer                                                           |
| **HTTP header**          | `Header: <value>` (vd `X-API-Key: <value>`)           | Server dùng API key / custom header                                                      |
| **No auth**              | (không gửi credential)                                | Server thực sự public, không cần xác thực                                                |
| **Environment variable** | Biến env (chỉ stdio, advanced/internal manifest path) | Chỉ dùng khi manifest có `envAllowlist`; normal Owner Console hiện không expose mode này |

> **Environment variable auth is not part of the normal Owner Console flow.** It remains an advanced/internal manifest capability and requires a valid `envAllowlist`; do not instruct ordinary users to select it in the UI.

Quy tắc với "HTTP header": tên header **không** được là `accept`, `content-type`,
`content-length`, `host`, `mcp-session-id`, `mcp-protocol-version`, `mcp-method`, `mcp-name`,
và **không** được trùng `authorization`. Tên env với mode `env` phải có dạng
`/^[A-Z][A-Z0-9_]*$/` và nằm trong `envAllowlist` của manifest.

---

## 7. Namespacing tool id

Gateway exposes tool dưới dạng **canonical id** `provider.tool` (vd `my-provider.knowledge_search`).
Client (model) luôn gọi tool bằng canonical id này; khi proxy về MCP server, gateway đổi lại thành
tên bare (`knowledge_search`). Nếu bạn thấy tool có tiền tố `provider.` thì đó là chuẩn — không
phải tool lạ.

---

## 8. Sau khi thêm

Danh sách MCP Servers trong console cung cấp:

- **Test** — probe server + xem tools đang khám phá.
- **Sync** — nhận danh sách tools hiện tại của server và nạp lại gateway.
- **Disable / Enable** — thêm/bớt tools của provider khỏi gateway **mà không xoá cấu hình**.
- **Remove** — xoá cấu hình provider.

---

## 9. Troubleshooting

Nếu provider đã cấu hình nhưng tool không xuất hiện, kiểm tra `core.ping`:

- `configuredProviders`
- `readyProviders`
- `advertisedTools`
- `catalogFingerprint`

Provider phải **ready** trước khi tool được advertise. Một provider chưa ready thường do:
probe fail, discovery lệch (drift), thiếu credential, hoặc không khớp auth mode.

**Client (ChatGPT)**: thỉnh thoảng cần bấm **Refresh / Scan Tools** sau khi catalog thay đổi.

---

## 10. Quy tắc an toàn (tóm tắt từ ADR-020/025/026)

- Không có secret trong URL/command/args/description/audit.
- Không shell expression trong Target; shell string bị từ chối.
- Provider ID lowercase, ≤ 64 ký tự; tool id tạo namespace `provider.tool`.
- Credential ref là **tên opaque**, không được giống chuỗi bí mật thật (không `sk_live…`, `AKIA…`, `BEGIN RSA…`).
- `http://` chỉ cho loopback; host thật bắt buộc HTTPS.
- Redirect cross-origin bị từ chối; chỉ same-origin.
- Probe là gate: fail → rollback, không lưu cấu hình nửa vời.
