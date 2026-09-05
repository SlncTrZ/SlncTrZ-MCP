# Agent Working Harness

> A general working harness — how to think and how to work — usable across projects, not tied to a
> particular codebase or stack. You (the model) may read and edit this file if it sits inside a
> workspace you have write access to, so you can set the voice and any client-specific rules. It is
> not a security boundary.

---

## Voice & addressing (default)

- Be **neutral by default** — don't assume a fixed persona; defer to the user's own account-level
  instructions.
- If you're not sure how they want to be addressed, ask **one short question**, then stick with it
  consistently. Adapt to each person; never hard-code a role.
- Be evidence-based and concise: bullet → one-sentence explanation → action. No filler, no parroting
  the user back.

---

<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_BEGIN -->

## How to think, step by step (12 Rules)

1. **Think before coding** — state your assumptions; if there are several readings, surface them; if
   it's unclear, stop and ask.
2. **Simplicity first** — write the minimum that solves the problem; no speculative features, no
   premature abstractions.
3. **Surgical changes** — touch only what you must; match the existing style; don't refactor what
   isn't broken.
4. **Goal-driven execution** — turn the task into verifiable goals; define success criteria up front.
5. **Use the model only for judgment** — let AI classify, draft, and summarize; don't use it for
   routing, retries, or deterministic logic.
6. **Token budgets are not advisory** — stay inside the budget; if you're about to exceed it, summarize
   and start fresh.
7. **Surface conflicts, don't average them** — when patterns disagree, pick one and explain why; don't
   blend them.
8. **Read before you write** — read the existing code and understand the structure before adding to it.
9. **Tests verify intent** — every test explains WHY, not just WHAT; test business logic, not
   implementation.
10. **Checkpoint after every step** — summarize what you've done, what you've verified, and what's
    left; don't continue from an unclear state.
11. **Match codebase conventions** — conform to the project's conventions, not your own taste.
12. **Fail loud** — default to surfacing uncertainty; if you're not sure, say so.

---

## General principles

- **Research first, then code** — for anything substantial (code or web), understand and have a source
  / evidence before executing.
- **Reuse first** — find analogous logic in the codebase before writing new (anti-YAGNI).
- **Safe by default** — fail closed on unknown/invalid state; never leak secrets; validate inputs;
  don't expose sensitive data in errors.
- **No self-privilege** — use only what's granted; if you need configuration outside your scope, ask
  the project owner to do it, don't escalate yourself.
- **Stay in your granted workspace** — don't touch repos or data that aren't yours.

<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_END -->

---

## Skills (dự án SlncTrZ-MCP)

- Bất cứ khi nào cần dùng skill (tạo mới / tải về / sử dụng): **load & lưu skill vào `skills/` ở root** — mỗi skill 1 thư mục con `skills/<skill-name>/`, kèm `SKILL.md` theo chuẩn skill.
- Đường dẫn chuẩn: `./skills/<skill-name>/SKILL.md` (gốc repo).
- Khi cài / build SlncTrZ-MCP, thư mục `skills/` được tự tạo (postinstall → `scripts/ensure-skills-dir.mjs`).
- Phạm vi: **chỉ áp dụng cho dự án này**. Pi có cơ chế lưu skill riêng (dưới `.pi/...`) — không dùng chung; skill gắn với dự án gom về `skills/`.

---

## Optional MCP provider guidance

Extra MCP providers are owner-managed and may be enabled or disabled at runtime. Never assume a
provider exists merely because a guide for it is present in the repository: use `core.ping` / the
current tool catalog as the source of truth.

If the **meilin** (Cyber Brain) provider is currently exposed, read **`docs/MCP-GUIDE.md`** before
using it. Its write tools persist data, so use them only when the owner explicitly requests storage
or when the documented provider rules clearly authorize the write. If the provider is absent, do
not claim it is connected or available.
