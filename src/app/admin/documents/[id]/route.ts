// Clinical document download (#192) — GET /admin/documents/<id>
//
// vet-docs/ objects are deny-all in Storage rules, so staff reads go
// through this privileged proxy: the vet_documents row is resolved by
// id (never a caller-supplied path), the object is streamed through the
// Admin SDK, and the view is written to audit_events as a data-access
// record. Route handlers are NOT wrapped by the admin layout — the
// session-cookie proxy only checks cookie presence for /admin, so this
// handler runs requireAdmin() itself. Response is no-store: clinical
// content must never be cached into shared/public artifacts.

import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getRegistryDb } from "@/lib/db/client";
import { auditEvents } from "@/lib/db/schema";
import { getVetDocumentStoragePath } from "@/lib/registry/medical";
import { adminBucket } from "@/lib/firebase-admin-storage";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { authorized, user } = await requireAdmin();
  if (!authorized) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { id } = await params;
  try {
    const storagePath = await getVetDocumentStoragePath(id);
    if (!storagePath) {
      return new NextResponse("Not found", { status: 404 });
    }

    const file = adminBucket().file(storagePath);
    const [[metadata], [contents]] = await Promise.all([
      file.getMetadata(),
      file.download(),
    ]);

    // Audit the access — which document and who, never the content.
    await getRegistryDb().insert(auditEvents).values({
      actorLabel: user?.email ?? "unknown",
      entityType: "vet_document",
      entityId: id,
      action: "view",
    });

    return new NextResponse(new Uint8Array(contents), {
      headers: {
        "content-type":
          typeof metadata.contentType === "string"
            ? metadata.contentType
            : "application/octet-stream",
        // inline, not attachment: staff open the document in a tab to
        // review it against the record.
        "content-disposition": "inline",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    logError("medical", "document-download", error);
    return new NextResponse("Download failed", { status: 500 });
  }
}
