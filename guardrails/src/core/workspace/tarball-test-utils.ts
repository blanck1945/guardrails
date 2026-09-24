import { gzipSync } from "node:zlib";
import * as tar from "tar";

export type TarEntry = {
  path: string;
  type?: "File" | "Directory" | "SymbolicLink" | "Link";
  content?: string | Buffer;
  linkpath?: string;
};

/** Builds a gzipped tarball in memory, so tests can include symlinks and `..` paths without touching the disk. */
export function makeTarball(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? "File";
    const body = type === "File" ? Buffer.from(e.content ?? "") : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    new tar.Header({
      path: e.path,
      type,
      size: body.length,
      mode: type === "Directory" ? 0o755 : 0o644,
      mtime: new Date(0),
      ...(e.linkpath ? { linkpath: e.linkpath } : {}),
    }).encode(header, 0);
    blocks.push(header);
    if (body.length) {
      blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** Tarball of a `{ path: content }` map under a GitHub-style top-level directory. */
export function tarballOf(files: Record<string, string>, top = "owner-repo-abc123"): Buffer {
  return makeTarball([
    { path: `${top}/`, type: "Directory" },
    ...Object.entries(files).map(([p, content]) => ({ path: `${top}/${p}`, content })),
  ]);
}
