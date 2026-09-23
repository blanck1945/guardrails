import { describe, it, expect } from "vitest";
import { anchorText, dedupe, fingerprint, findingSchemaV2, sanitizeMarkdown, type FindingV2 } from ".";

const base: FindingV2 = {
  file: "src/a.ts",
  line: 10,
  type: "logic",
  severity: "medium",
  confidence: 0.8,
  title: "Missing null check on user",
  body: "user may be null",
  evidence: [{ file: "src/a.ts", startLine: 10, endLine: 10, note: "deref" }],
};

describe("sanitizeMarkdown", () => {
  it("neutralizes @mentions", () => {
    expect(sanitizeMarkdown("ping @user now")).toBe("ping @​user now");
    expect(sanitizeMarkdown("@​user")).toBe("@​user");
  });
  it("removes external images, keeps github ones", () => {
    expect(sanitizeMarkdown("a ![x](http://evil.com/p.png) b")).toBe("a  b");
    expect(sanitizeMarkdown("![x](https://github.com/a.png)")).toBe("![x](https://github.com/a.png)");
  });
  it("reduces external links to text and strips html", () => {
    expect(sanitizeMarkdown("see [docs](https://evil.com/x)")).toBe("see docs");
    expect(sanitizeMarkdown('<img src="http://e.com/x.png">hi')).toBe("hi");
  });
  it("leaves code intact (except @) and caps length", () => {
    expect(sanitizeMarkdown("`Array<string>`")).toBe("`Array<string>`");
    expect(sanitizeMarkdown("x".repeat(50), 10)).toHaveLength(10);
  });
});

describe("fingerprint", () => {
  const file = "a\nb\nconst x = user.name;\nc";
  const shifted = "new1\nnew2\nnew3\n" + file;
  it("does not change when lines shift", () => {
    const a = fingerprint("r1", base, anchorText(file, 3));
    const b = fingerprint("r1", { ...base, line: 13 }, anchorText(shifted, 6));
    expect(a).toBe(b);
  });
  it("changes with anchor, repo, title", () => {
    const a = fingerprint("r1", base, "x");
    expect(fingerprint("r1", base, "y")).not.toBe(a);
    expect(fingerprint("r2", base, "x")).not.toBe(a);
    expect(fingerprint("r1", { ...base, title: "Other" }, "x")).not.toBe(a);
    expect(fingerprint("r1", { ...base, title: "MISSING null check, on user!" }, "x")).toBe(a);
  });
});

describe("dedupe", () => {
  it("merges the same problem reported twice", () => {
    const b: FindingV2 = {
      ...base,
      line: 12,
      severity: "high",
      title: "Null check missing for user",
      evidence: [{ file: "src/b.ts", startLine: 3, endLine: 4, note: "caller" }],
    };
    const out = dedupe([base, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("high");
    expect(out[0]!.evidence).toHaveLength(2);
  });
  it("keeps distinct findings", () => {
    expect(dedupe([base, { ...base, line: 30 }])).toHaveLength(2);
    expect(dedupe([base, { ...base, title: "SQL injection in query builder" }])).toHaveLength(2);
    expect(dedupe([base, { ...base, file: "src/z.ts" }])).toHaveLength(2);
  });
});

describe("schema v2", () => {
  it("requires evidence", () => {
    expect(findingSchemaV2.safeParse(base).success).toBe(true);
    expect(findingSchemaV2.safeParse({ ...base, evidence: [] }).success).toBe(false);
  });
});
