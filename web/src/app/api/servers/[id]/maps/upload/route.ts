// web/src/app/api/servers/[id]/maps/upload/route.ts
//
// PUT /api/servers/<id>/maps/upload?name=<file>.vpk[&overwrite=true]
//
// Streams the request body directly to disk. No in-memory buffering, so
// large maps (1 GB+) are fine. Writes to a `.upload-<ts>` temp file and
// atomically renames on success — failed uploads never leave a half-
// written .vpk the engine will try to load.

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/servers";
import { deadlockGameDir } from "@/lib/maps";

// Node runtime + force-dynamic so we get the raw streaming Request body.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long timeout (s) for large VPKs. Only honored on Vercel; self-hosted
// uses Node's underlying HTTP timeout (5 min default).
export const maxDuration = 600;

const FILENAME_RE = /^[A-Za-z0-9_]+\.vpk$/;
// Hard cap to keep a runaway upload from filling the disk silently.
const MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const server = getServer(id);
  if (!server) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const filename = req.nextUrl.searchParams.get("name");
  if (!filename || !FILENAME_RE.test(filename)) {
    return NextResponse.json(
      { error: "filename must match ^[A-Za-z0-9_]+\\.vpk$" },
      { status: 400 },
    );
  }

  const overwrite = req.nextUrl.searchParams.get("overwrite") === "true";
  const mapsDir = path.join(deadlockGameDir(id), "citadel", "maps");
  fs.mkdirSync(mapsDir, { recursive: true });
  const dest = path.join(mapsDir, filename);

  if (fs.existsSync(dest) && !overwrite) {
    return NextResponse.json(
      { error: `map ${filename} already exists; pass overwrite=true to replace` },
      { status: 409 },
    );
  }

  if (!req.body) {
    return NextResponse.json({ error: "request body is empty" }, { status: 400 });
  }

  const tmpDest = `${dest}.upload-${Date.now()}`;
  let written = 0;
  let ws: fs.WriteStream | null = null;

  try {
    ws = fs.createWriteStream(tmpDest);
    const reader = (req.body as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      written += value.byteLength;
      if (written > MAX_BYTES) {
        ws.destroy();
        ws = null;
        try { fs.unlinkSync(tmpDest); } catch { /* ok */ }
        return NextResponse.json(
          { error: `file exceeds ${MAX_BYTES} byte limit` },
          { status: 413 },
        );
      }
      const ok = ws.write(value);
      if (!ok) {
        await new Promise<void>((resolve) => ws!.once("drain", () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws!.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    ws = null;
    fs.renameSync(tmpDest, dest);

    return NextResponse.json({ ok: true, bytes: written, name: filename });
  } catch (err: any) {
    if (ws) {
      try { ws.destroy(); } catch { /* ok */ }
    }
    try { fs.unlinkSync(tmpDest); } catch { /* ok */ }
    return NextResponse.json(
      { error: err?.message ?? "upload failed" },
      { status: 500 },
    );
  }
}
