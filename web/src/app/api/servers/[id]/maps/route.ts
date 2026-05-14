// web/src/app/api/servers/[id]/maps/route.ts
//
// Returns the maps installed for a given slot.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/servers";
import { listMapsForSlot } from "@/lib/maps";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const server = getServer(id);
  if (!server) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    return NextResponse.json({ maps: listMapsForSlot(id) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
