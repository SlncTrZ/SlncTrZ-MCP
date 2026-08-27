import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EditError,
  editContainedFile,
  DEFAULT_MAX_DIFF_BYTES,
  DEFAULT_MAX_EDIT_BYTES,
  DEFAULT_MAX_EDIT_INPUT_BYTES,
  DEFAULT_MAX_EDIT_OPERATIONS
} from "../../src/kernel/fs-edit.js";

const cleanup: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slnctrz-edit-"));
  cleanup.push(dir);
  return dir;
}

async function makeFile(root: string, name: string, content: string): Promise<string> {
  await writeFile(join(root, name), content, "utf8");
  return join(root, name);
}

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function tempArtifacts(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.includes(".slnctrz-"));
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("core.edit (deterministic exact-match filesystem edit)", () => {
  describe("kernel happy path", () => {
    it("defaults to dry-run without mutating", async () => {
      const root = await makeTempDir();
      const target = join(root, "doc.txt");
      await makeFile(root, "doc.txt", "hello world");

      const result = await editContainedFile(
        root,
        "doc.txt",
        [{ oldText: "world", newText: "there" }],
        { expectedSha256: sha("hello world") }
      );

      expect(result.applied).toBe(false);
      expect(await readFile(target, "utf8")).toBe("hello world");
    });

    it("applies one exact replacement", async () => {
      const root = await makeTempDir();
      await makeFile(root, "doc.txt", "hello world");

      const result = await editContainedFile(
        root,
        "doc.txt",
        [{ oldText: "world", newText: "there" }],
        { expectedSha256: sha("hello world"), dryRun: false }
      );

      expect(result.applied).toBe(true);
      expect(result.editCount).toBe(1);
      expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("hello there");
      expect(result.bytesBefore).toBe(11);
      expect(result.bytesAfter).toBe(11);
    });

    it("applies multiple non-overlapping edits deterministically", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "a b c d");

      const result = await editContainedFile(
        root,
        "x.txt",
        [
          { oldText: "a", newText: "A" },
          { oldText: "c", newText: "C" }
        ],
        { expectedSha256: sha("a b c d"), dryRun: false }
      );

      expect(await readFile(join(root, "x.txt"), "utf8")).toBe("A b C d");
      expect(result.sha256).toBe(sha("A b C d"));
    });

    it("ignores caller operation order", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "a b c d");

      await editContainedFile(
        root,
        "x.txt",
        [
          { oldText: "a", newText: "A" },
          { oldText: "c", newText: "C" }
        ],
        { expectedSha256: sha("a b c d"), dryRun: false }
      );
      const forward = await readFile(join(root, "x.txt"), "utf8");

      await makeFile(root, "x.txt", "a b c d");
      await editContainedFile(
        root,
        "x.txt",
        [
          { oldText: "c", newText: "C" },
          { oldText: "a", newText: "A" }
        ],
        { expectedSha256: sha("a b c d"), dryRun: false }
      );
      const reversed = await readFile(join(root, "x.txt"), "utf8");

      expect(forward).toBe("A b C d");
      expect(reversed).toBe("A b C d");
    });

    it("supports deletion with an empty newText", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "aaXXbb");

      const result = await editContainedFile(root, "x.txt", [{ oldText: "XX", newText: "" }], {
        expectedSha256: sha("aaXXbb"),
        dryRun: false
      });

      expect(await readFile(join(root, "x.txt"), "utf8")).toBe("aabb");
      expect(result.bytesAfter).toBe(4);
    });

    it("handles unicode content", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "héllo 🌍 thế giới");

      await editContainedFile(root, "x.txt", [{ oldText: "thế giới", newText: "mọi người" }], {
        expectedSha256: sha("héllo 🌍 thế giới"),
        dryRun: false
      });

      expect(await readFile(join(root, "x.txt"), "utf8")).toBe("héllo 🌍 mọi người");
    });

    it("preserves a UTF-8 byte-order mark", async () => {
      const root = await makeTempDir();
      const target = join(root, "bom.txt");
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      await writeFile(target, Buffer.concat([bom, Buffer.from("hello world", "utf8")]));
      const before = await readFile(target);
      const bomSha = createHash("sha256").update(before).digest("hex");

      await editContainedFile(root, "bom.txt", [{ oldText: "world", newText: "there" }], {
        expectedSha256: bomSha,
        dryRun: false
      });

      const after = await readFile(target);
      expect(after.subarray(0, 3)).toEqual(bom);
      expect(after.subarray(3).toString("utf8")).toBe("hello there");
    });

    it("preserves CRLF line endings", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "first\r\nsecond\r\nthird");

      const result = await editContainedFile(
        root,
        "x.txt",
        [{ oldText: "second", newText: "SECOND" }],
        { expectedSha256: sha("first\r\nsecond\r\nthird"), dryRun: false }
      );

      expect(await readFile(join(root, "x.txt"), "utf8")).toBe("first\r\nSECOND\r\nthird");
      expect(result.bytesAfter).toBe(20);
    });

    it("reports correct diff startLine", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "line1\nline2\nline3");

      const result = await editContainedFile(
        root,
        "x.txt",
        [{ oldText: "line2", newText: "LINE2" }],
        { expectedSha256: sha("line1\nline2\nline3"), dryRun: true }
      );

      expect(result.diff.hunks).toEqual([{ startLine: 2, oldText: "line2", newText: "LINE2" }]);
      expect(result.diff.truncated).toBe(false);
      expect(result.diff.omittedHunks).toBe(0);
    });
  });

  describe("ambiguity and consistency", () => {
    it("rejects an empty edits array", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "alpha");
      await expect(
        editContainedFile(root, "x.txt", [], { expectedSha256: sha("alpha") })
      ).rejects.toMatchObject({ code: "invalid_edit" } satisfies Partial<EditError>);
    });

    it("rejects an empty oldText", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "alpha");
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "", newText: "x" }], {
          expectedSha256: sha("alpha")
        })
      ).rejects.toMatchObject({ code: "invalid_edit" } satisfies Partial<EditError>);
    });

    it("rejects a no-op replacement", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "alpha");
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "a", newText: "a" }], {
          expectedSha256: sha("alpha")
        })
      ).rejects.toMatchObject({ code: "invalid_edit" } satisfies Partial<EditError>);
    });

    it("rejects a missing match", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "alpha");
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "zebra", newText: "x" }], {
          expectedSha256: sha("alpha")
        })
      ).rejects.toMatchObject({ code: "match_not_found" } satisfies Partial<EditError>);
    });

    it("rejects an ambiguous match", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "aaa");
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "aa", newText: "b" }], {
          expectedSha256: sha("aaa")
        })
      ).rejects.toMatchObject({ code: "ambiguous_match" } satisfies Partial<EditError>);
    });

    it("rejects overlapping edits", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "abc");
      await expect(
        editContainedFile(
          root,
          "x.txt",
          [
            { oldText: "ab", newText: "1" },
            { oldText: "bc", newText: "2" }
          ],
          { expectedSha256: sha("abc") }
        )
      ).rejects.toMatchObject({ code: "overlapping_edits" } satisfies Partial<EditError>);
    });

    it("rejects duplicate operations resolving to one span", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "a_b");
      await expect(
        editContainedFile(
          root,
          "x.txt",
          [
            { oldText: "a_", newText: "X" },
            { oldText: "a_", newText: "Y" }
          ],
          { expectedSha256: sha("a_b") }
        )
      ).rejects.toMatchObject({ code: "overlapping_edits" } satisfies Partial<EditError>);
    });

    it("rejects a stale base hash", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "alpha");
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "a", newText: "b" }], {
          expectedSha256: "0".repeat(64)
        })
      ).rejects.toMatchObject({ code: "conflict" } satisfies Partial<EditError>);
    });

    it("requires an expected hash", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "alpha");
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "a", newText: "b" }])
      ).rejects.toMatchObject({
        code: "expected_hash_required"
      } satisfies Partial<EditError>);
    });

    it("rejects a malformed hash", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "alpha");
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "a", newText: "b" }], {
          expectedSha256: "short"
        })
      ).rejects.toMatchObject({ code: "invalid_edit" } satisfies Partial<EditError>);
    });
  });

  describe("boundary and security", () => {
    it("fails closed with no write root", async () => {
      await expect(
        editContainedFile(undefined, "x.txt", [{ oldText: "a", newText: "b" }], {
          expectedSha256: "0".repeat(64)
        })
      ).rejects.toMatchObject({ code: "no_root" } satisfies Partial<EditError>);
    });

    it("rejects an absolute path", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "alpha");
      await expect(
        editContainedFile(root, "/etc/passwd", [{ oldText: "a", newText: "b" }], {
          expectedSha256: sha("alpha")
        })
      ).rejects.toMatchObject({ code: "invalid_path" } satisfies Partial<EditError>);
    });

    it("rejects parent traversal", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "alpha");
      await expect(
        editContainedFile(root, "../escape.txt", [{ oldText: "a", newText: "b" }], {
          expectedSha256: sha("alpha")
        })
      ).rejects.toMatchObject({ code: "permission_denied" } satisfies Partial<EditError>);
    });

    it("rejects protected secret paths", async () => {
      const root = await makeTempDir();
      await makeFile(root, "safe.txt", "alpha");
      for (const path of [".env", ".ssh/id_rsa", ".git/config"]) {
        await expect(
          editContainedFile(root, path, [{ oldText: "a", newText: "b" }], {
            expectedSha256: sha("alpha")
          })
        ).rejects.toMatchObject({ code: "permission_denied" } satisfies Partial<EditError>);
      }
    });

    it("rejects a final symlink", async () => {
      const root = await makeTempDir();
      const outside = await makeTempDir();
      await makeFile(outside, "real.txt", "alpha");
      try {
        await symlink(join(outside, "real.txt"), join(root, "link.txt"));
      } catch {
        return;
      }
      await expect(
        editContainedFile(root, "link.txt", [{ oldText: "a", newText: "b" }], {
          expectedSha256: sha("alpha")
        })
      ).rejects.toMatchObject({ code: "permission_denied" } satisfies Partial<EditError>);
    });

    it("rejects a parent-symlink escape", async () => {
      const root = await makeTempDir();
      const outside = await makeTempDir();
      await makeFile(outside, "target.txt", "alpha");
      try {
        await symlink(outside, join(root, "escape-dir"));
      } catch {
        return;
      }
      await expect(
        editContainedFile(root, "escape-dir/target.txt", [{ oldText: "a", newText: "b" }], {
          expectedSha256: sha("alpha")
        })
      ).rejects.toMatchObject({ code: "permission_denied" } satisfies Partial<EditError>);
    });

    it("rejects a directory target", async () => {
      const root = await makeTempDir();
      await mkdir(join(root, "sub"));
      await expect(
        editContainedFile(root, "sub", [{ oldText: "a", newText: "b" }], {
          expectedSha256: sha("alpha")
        })
      ).rejects.toMatchObject({ code: "not_file" } satisfies Partial<EditError>);
    });

    it("rejects a missing target without creating it", async () => {
      const root = await makeTempDir();
      await expect(
        editContainedFile(root, "missing.txt", [{ oldText: "a", newText: "b" }], {
          expectedSha256: sha("alpha")
        })
      ).rejects.toMatchObject({ code: "not_found" } satisfies Partial<EditError>);
      await expect(readdir(root)).resolves.not.toContain("missing.txt");
    });

    it("never leaks absolute paths or content in error messages", async () => {
      const root = await makeTempDir();
      const target = await makeFile(root, "x.txt", "secret-content");
      let caught: unknown;
      try {
        await editContainedFile(root, "x.txt", [{ oldText: "missing", newText: "y" }], {
          expectedSha256: sha("secret-content")
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EditError);
      const message = caught instanceof EditError ? caught.message : String(caught);
      expect(message).not.toContain(root);
      expect(message).not.toContain(target);
      expect(message).not.toContain("secret-content");
      expect(message).not.toContain("missing");
    });
  });

  describe("limits", () => {
    it("accepts the maximum number of operations", async () => {
      const root = await makeTempDir();
      const tokens = Array.from(
        { length: DEFAULT_MAX_EDIT_OPERATIONS },
        (_, i) => `t${String(i).padStart(2, "0")}`
      );
      const content = tokens.join(" ");
      await makeFile(root, "y.txt", content);
      const result = await editContainedFile(
        root,
        "y.txt",
        tokens.map((token) => ({ oldText: token, newText: `${token}!` })),
        { expectedSha256: sha(content), dryRun: false }
      );
      expect(result.editCount).toBe(DEFAULT_MAX_EDIT_OPERATIONS);
      expect(await readFile(join(root, "y.txt"), "utf8")).toBe(
        tokens.map((t) => `${t}!`).join(" ")
      );
    });

    it("rejects more than the maximum number of operations", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "0123456789");
      const edits = Array.from({ length: DEFAULT_MAX_EDIT_OPERATIONS + 1 }, (_, i) => ({
        oldText: `unique${i}`,
        newText: "x"
      }));
      await expect(
        editContainedFile(root, "x.txt", edits, { expectedSha256: sha("0123456789") })
      ).rejects.toMatchObject({ code: "too_many_edits" } satisfies Partial<EditError>);
    });

    it("rejects aggregate edit input over the limit", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "a");
      await expect(
        editContainedFile(
          root,
          "x.txt",
          [{ oldText: "a", newText: "x".repeat(DEFAULT_MAX_EDIT_INPUT_BYTES + 1) }],
          {
            expectedSha256: sha("a")
          }
        )
      ).rejects.toMatchObject({ code: "too_large" } satisfies Partial<EditError>);
    });

    it("rejects a source file over the limit", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "x".repeat(DEFAULT_MAX_EDIT_BYTES + 1));
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "x", newText: "y" }], {
          expectedSha256: sha("x".repeat(DEFAULT_MAX_EDIT_BYTES + 1))
        })
      ).rejects.toMatchObject({ code: "too_large" } satisfies Partial<EditError>);
    });

    it("rejects a result over the limit", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "a");
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "a", newText: "y".repeat(20) }], {
          expectedSha256: sha("a"),
          maxBytes: 10
        })
      ).rejects.toMatchObject({ code: "too_large" } satisfies Partial<EditError>);
    });

    it("builds a complete diff within budget", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "a0 a1 a2");
      const result = await editContainedFile(
        root,
        "x.txt",
        [
          { oldText: "a0", newText: "b0" },
          { oldText: "a1", newText: "b1" },
          { oldText: "a2", newText: "b2" }
        ],
        { expectedSha256: sha("a0 a1 a2"), maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, dryRun: false }
      );
      expect(result.diff.hunks).toHaveLength(3);
      expect(result.diff.truncated).toBe(false);
      expect(result.diff.omittedHunks).toBe(0);
    });

    it("omits whole hunks beyond the diff budget", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "a0 a1 a2 a3 a4 a5");
      const result = await editContainedFile(
        root,
        "x.txt",
        Array.from({ length: 6 }, (_, i) => ({ oldText: `a${i}`, newText: `b${i}` })),
        { expectedSha256: sha("a0 a1 a2 a3 a4 a5"), maxDiffBytes: 6, dryRun: false }
      );
      expect(result.diff.truncated).toBe(true);
      expect(result.diff.omittedHunks).toBeGreaterThan(0);
      expect(
        result.diff.hunks.every((hunk) => hunk.oldText.length + hunk.newText.length <= 6)
      ).toBe(true);
    });

    it("rejects invalid configured limits", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "a");
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "a", newText: "b" }], {
          expectedSha256: sha("a"),
          maxEdits: 0
        })
      ).rejects.toMatchObject({ code: "invalid_limit" } satisfies Partial<EditError>);
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "a", newText: "b" }], {
          expectedSha256: sha("a"),
          maxDiffBytes: -1
        })
      ).rejects.toMatchObject({ code: "invalid_limit" } satisfies Partial<EditError>);
    });
  });

  describe("race, timeout, and cancellation", () => {
    it("honours cancellation before read", async () => {
      const root = await makeTempDir();
      const target = await makeFile(root, "x.txt", "alpha");
      const controller = new AbortController();
      controller.abort();
      await expect(
        editContainedFile(root, "x.txt", [{ oldText: "a", newText: "b" }], {
          expectedSha256: sha("alpha"),
          signal: controller.signal,
          dryRun: false
        })
      ).rejects.toMatchObject({ code: "cancelled" });
      expect(await readFile(target, "utf8")).toBe("alpha");
    });

    it("yields one success and one conflict for competing edits", async () => {
      const root = await makeTempDir();
      const target = await makeFile(root, "x.txt", "a b");
      const base = sha("a b");
      const outcomes = await Promise.all(
        [
          { oldText: "a", newText: "A" },
          { oldText: "b", newText: "B" }
        ].map(async (edit) => {
          try {
            await editContainedFile(root, "x.txt", [edit], {
              expectedSha256: base,
              dryRun: false
            });
            return "success";
          } catch (error) {
            if (error instanceof EditError) return error.code;
            throw error;
          }
        })
      );
      expect([...outcomes].sort()).toEqual(["conflict", "success"]);
      expect(["A b", "a B"]).toContain(await readFile(target, "utf8"));
    });

    it("leaves no temporary artifacts after a write-layer conflict", async () => {
      const root = await makeTempDir();
      await makeFile(root, "x.txt", "a b");
      const base = sha("a b");
      await Promise.allSettled([
        editContainedFile(root, "x.txt", [{ oldText: "a", newText: "A" }], {
          expectedSha256: base,
          dryRun: false
        }),
        editContainedFile(root, "x.txt", [{ oldText: "b", newText: "B" }], {
          expectedSha256: base,
          dryRun: false
        })
      ]);
      expect(await tempArtifacts(root)).toEqual([]);
    });
  });
});
