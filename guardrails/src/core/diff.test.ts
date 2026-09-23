import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "./diff";

const NN = String.fromCharCode(92) + " No newline at end of file";

const multiHunk = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 one
+two
 three
-four
+four!
 five
@@ -20,3 +21,4 @@ function foo() {
 x
 y
+z
 w
`;

const noNewline = `diff --git a/b.txt b/b.txt
index 1..2 100644
--- a/b.txt
+++ b/b.txt
@@ -1,2 +1,2 @@
 keep
-old
${NN}
+new
${NN}
`;

const renamed = `diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
index 1..2 100644
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
`;

const renameOnly = `diff --git a/x.ts b/y.ts
similarity index 100%
rename from x.ts
rename to y.ts
`;

const deleted = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 1..0
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`;

const binary = `diff --git a/img.png b/img.png
new file mode 100644
index 0..1
Binary files /dev/null and b/img.png differ
`;

const newFile = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0..1
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+a
+--- looks like a header
+c
`;

describe("parseUnifiedDiff", () => {
  it("multi-hunk", () => {
    const [f] = parseUnifiedDiff(multiHunk);
    expect(f!.path).toBe("src/a.ts");
    expect(f!.status).toBe("modified");
    expect(f!.hunks).toHaveLength(2);
    expect(f!.hunks[1]!.header).toBe("function foo() {");
    expect(f!.addedLines).toEqual([2, 4, 23]);
    expect(f!.commentableLines).toEqual([1, 2, 3, 4, 5, 21, 22, 23, 24]);
  });

  it("ignores 'backslash No newline at end of file'", () => {
    const [f] = parseUnifiedDiff(noNewline);
    expect(f!.addedLines).toEqual([2]);
    expect(f!.commentableLines).toEqual([1, 2]);
    expect(f!.hunks[0]!.lines.map((l) => l.type)).toEqual(["context", "del", "add"]);
  });

  it("rename with edits and pure rename", () => {
    const [f] = parseUnifiedDiff(renamed);
    expect(f).toMatchObject({ path: "new/name.ts", oldPath: "old/name.ts", status: "renamed" });
    expect(f!.commentableLines).toEqual([1, 2, 3]);
    const [r] = parseUnifiedDiff(renameOnly);
    expect(r).toMatchObject({ path: "y.ts", oldPath: "x.ts", status: "renamed", commentableLines: [] });
  });

  it("deleted file has no commentable lines", () => {
    const [f] = parseUnifiedDiff(deleted);
    expect(f).toMatchObject({ path: "gone.ts", status: "deleted", addedLines: [], commentableLines: [] });
  });

  it("binary file", () => {
    const [f] = parseUnifiedDiff(binary);
    expect(f).toMatchObject({ path: "img.png", status: "added", binary: true, hunks: [], commentableLines: [] });
  });

  it("final newline / added file with header-looking content, multiple files", () => {
    const files = parseUnifiedDiff(newFile + deleted);
    expect(files.map((f) => f.path)).toEqual(["new.ts", "gone.ts"]);
    expect(files[0]).toMatchObject({ status: "added", oldPath: null });
    expect(files[0]!.addedLines).toEqual([1, 2, 3]);
    // with and without trailing newline give the same result
    expect(parseUnifiedDiff(newFile.trimEnd())).toEqual(parseUnifiedDiff(newFile));
  });

  it("parses plain ---/+++ diffs without 'diff --git'", () => {
    const plain = `--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n x\n+y\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-p\n+q\n`;
    const files = parseUnifiedDiff(plain);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(files[1]!.commentableLines).toEqual([1]);
  });
});
