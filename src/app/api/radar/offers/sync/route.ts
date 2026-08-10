/** POST a server-side Radar offers sync. The browser never receives the supporter key. */

import { NextResponse } from "next/server";
import { z } from "zod";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { syncRadarOffers } from "@/lib/radar/offersSync";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SyncBodySchema = z.object({}).strict().optional();

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request: Request) {
  if (!isFeatureFlagEnabled("RADAR_ENABLED")) {
    return NextResponse.json(buildErrorBody(404, "Not found"), {
      status: 404,
      headers: CORS_HEADERS,
    });
  }
  if (!(await isAuthenticated(request))) {
    return NextResponse.json(buildErrorBody(401, "Unauthorized"), {
      status: 401,
      headers: CORS_HEADERS,
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  if (!SyncBodySchema.safeParse(body).success) {
    return NextResponse.json(buildErrorBody(400, "Invalid request body"), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  try {
    return NextResponse.json(await syncRadarOffers(), { headers: CORS_HEADERS });
  } catch (error: unknown) {
    return NextResponse.json(
      buildErrorBody(500, sanitizeErrorMessage(error) || "Radar offers sync failed"),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
