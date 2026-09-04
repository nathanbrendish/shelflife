import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { AI_FEATURE_KEYS, consumeAiQuota } from "@/lib/ai-quota";
import { getGeminiModelName } from "@/lib/gemini/config";
import { mapGeminiError } from "@/lib/gemini/map-gemini-error";
import { parseIngredientsResponse } from "@/lib/gemini/parse-ingredients";
import { RECEIPT_EXTRACTION_PROMPT } from "@/lib/gemini/receipt-prompt";
import { withGeminiRetry } from "@/lib/gemini/retry";
import {
  fileToBase64,
  getReceiptMimeType,
  validateReceiptUpload,
} from "@/lib/receipt-upload";
import {
  SCAN_ERROR_CODES,
  SCAN_USER_MESSAGES,
  type ScanErrorCode,
  type StructuredScanError,
} from "@/lib/scan-receipt-errors";
import {
  buildAuthLogFields,
  createScanRequestId,
  logServerScanError,
  logServerScanEvent,
  summarizeHeaders,
} from "@/lib/scan-receipt-logger";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

function jsonError(
  status: number,
  payload: StructuredScanError
): NextResponse {
  const body: StructuredScanError = {
    error: payload.error,
    code: payload.code,
    retryable: payload.retryable,
    ...(payload.details ? { details: payload.details } : {}),
    ...(payload.requestId ? { requestId: payload.requestId } : {}),
  };

  return NextResponse.json(body, {
    status,
    headers: payload.requestId
      ? { "X-Scan-Request-Id": payload.requestId }
      : undefined,
  });
}

function resolveRequestId(request: Request): string {
  return (
    request.headers.get("x-scan-request-id")?.trim() || createScanRequestId()
  );
}

export async function POST(request: Request) {
  const requestId = resolveRequestId(request);
  const startedAt = Date.now();

  logServerScanEvent("request_received", {
    requestId,
    method: request.method,
    headers: summarizeHeaders(request.headers),
  });

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError) {
      logServerScanError(
        "auth_error",
        {
          requestId,
          authMessage: authError.message,
          authStatus: authError.status,
        },
        authError
      );
    }

    if (!user) {
      logServerScanEvent("auth_missing", {
        requestId,
        hasAuthError: Boolean(authError),
      });

      return jsonError(401, {
        error: SCAN_USER_MESSAGES.UNAUTHORIZED,
        code: SCAN_ERROR_CODES.UNAUTHORIZED,
        details: authError?.message ?? "No authenticated user on request",
        retryable: false,
        requestId,
      });
    }

    logServerScanEvent("auth_ok", {
      requestId,
      ...buildAuthLogFields(user),
    });

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      logServerScanError("missing_gemini_key", { requestId });
      return jsonError(500, {
        error: SCAN_USER_MESSAGES.NOT_CONFIGURED,
        code: SCAN_ERROR_CODES.NOT_CONFIGURED,
        retryable: false,
        requestId,
      });
    }

    let formData: FormData;

    try {
      formData = await request.formData();
    } catch (error) {
      logServerScanError(
        "formdata_parse_failed",
        { requestId },
        error
      );

      const message =
        error instanceof Error ? error.message.toLowerCase() : "";

      if (
        message.includes("large") ||
        message.includes("size") ||
        message.includes("body")
      ) {
        return jsonError(413, {
          error: SCAN_USER_MESSAGES.FILE_TOO_LARGE,
          code: SCAN_ERROR_CODES.FILE_TOO_LARGE,
          details: "Multipart body rejected during formData() parse",
          retryable: false,
          requestId,
        });
      }

      return jsonError(400, {
        error: SCAN_USER_MESSAGES.UPLOAD_FAILED,
        code: SCAN_ERROR_CODES.UPLOAD_FAILED,
        details: "Failed to parse multipart form data",
        retryable: false,
        requestId,
      });
    }

    const image = formData.get("image");

    if (!(image instanceof File)) {
      logServerScanEvent("validation_failed", {
        requestId,
        reason: "missing_image_file",
      });

      return jsonError(400, {
        error: "A receipt image is required.",
        code: SCAN_ERROR_CODES.VALIDATION,
        retryable: false,
        requestId,
      });
    }

    logServerScanEvent("file_received", {
      requestId,
      filename: image.name,
      size: image.size,
      mimeType: image.type || "(empty)",
    });

    const validation = validateReceiptUpload(image);

    logServerScanEvent("validation_result", {
      requestId,
      ok: validation.ok,
      ...(validation.ok
        ? {}
        : { code: validation.code, message: validation.message }),
    });

    if (!validation.ok) {
      const status =
        validation.code === SCAN_ERROR_CODES.FILE_TOO_LARGE ? 413 : 400;

      return jsonError(status, {
        error: validation.message,
        code: validation.code,
        retryable: false,
        requestId,
      });
    }

    // ADR-010 Rule #1: every AI provider call must be preceded by a
    // successful quota consume. Checked after upload validation (so a
    // rejected/malformed file never costs the user quota) but before any
    // Gemini setup or call.
    const quota = await consumeAiQuota(supabase, AI_FEATURE_KEYS.RECEIPT_SCAN);

    if (!quota.allowed) {
      logServerScanEvent("quota_exceeded", {
        requestId,
        userId: user.id,
        retryAfterSeconds: quota.retryAfterSeconds,
        limit: quota.limit,
      });

      return jsonError(429, {
        error: SCAN_USER_MESSAGES.AI_BUSY,
        code: SCAN_ERROR_CODES.AI_BUSY,
        details: `Daily receipt scan limit reached. Retry after ${quota.retryAfterSeconds} seconds.`,
        retryable: true,
        requestId,
      });
    }

    const mimeType = getReceiptMimeType(image);
    const base64Image = await fileToBase64(image);
    const modelName = getGeminiModelName();

    logServerScanEvent("gemini_request_start", {
      requestId,
      modelName,
      mimeType,
      base64Length: base64Image.length,
      userId: user.id,
    });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: RECEIPT_EXTRACTION_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const result = await withGeminiRetry(() =>
      model.generateContent([
        {
          inlineData: {
            mimeType,
            data: base64Image,
          },
        },
        "Extract all food ingredients from this shopping receipt image.",
      ])
    );

    const responseText = result.response.text();

    logServerScanEvent("gemini_response_received", {
      requestId,
      responseChars: responseText?.length ?? 0,
      elapsedMs: Date.now() - startedAt,
    });

    if (!responseText) {
      logServerScanError("gemini_empty_response", { requestId });
      return jsonError(502, {
        error: SCAN_USER_MESSAGES.EMPTY_RESULT,
        code: SCAN_ERROR_CODES.EMPTY_RESULT,
        details: "Gemini returned empty text",
        retryable: true,
        requestId,
      });
    }

    let ingredients;

    try {
      ingredients = parseIngredientsResponse(responseText);
      logServerScanEvent("parse_success", {
        requestId,
        ingredientCount: ingredients.length,
      });
    } catch (parseError) {
      logServerScanError("parse_failure", { requestId }, parseError);
      return jsonError(502, {
        error: SCAN_USER_MESSAGES.PARSE_FAILED,
        code: SCAN_ERROR_CODES.PARSE_FAILED,
        details: "Failed to parse Gemini ingredients JSON",
        retryable: true,
        requestId,
      });
    }

    logServerScanEvent("request_complete", {
      requestId,
      status: 200,
      ingredientCount: ingredients.length,
      elapsedMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      { ingredients, requestId },
      {
        status: 200,
        headers: { "X-Scan-Request-Id": requestId },
      }
    );
  } catch (error) {
    logServerScanError(
      "unhandled_error",
      {
        requestId,
        elapsedMs: Date.now() - startedAt,
      },
      error
    );

    if (error instanceof Error && error.message.includes("ingredient")) {
      return jsonError(502, {
        error: SCAN_USER_MESSAGES.PARSE_FAILED,
        code: SCAN_ERROR_CODES.PARSE_FAILED,
        details: "Ingredient parse path failed",
        retryable: true,
        requestId,
      });
    }

    const mapped = mapGeminiError(error, "receipt");
    const code = geminiStatusToCode(mapped.status, mapped.message);

    return jsonError(mapped.status, {
      error: mapped.message,
      code,
      details: "Mapped Gemini/upstream failure",
      retryable: mapped.status === 429 || mapped.status === 503,
      requestId,
    });
  }
}

function geminiStatusToCode(status: number, message: string): ScanErrorCode {
  if (status === 429 || status === 503) {
    return SCAN_ERROR_CODES.AI_BUSY;
  }

  if (status === 502) {
    return SCAN_ERROR_CODES.AI_UNAVAILABLE;
  }

  if (/busy/i.test(message)) {
    return SCAN_ERROR_CODES.AI_BUSY;
  }

  return SCAN_ERROR_CODES.INTERNAL;
}

/** Ensure unexpected methods still return JSON (not an HTML Next.js page). */
export async function GET() {
  return jsonError(405, {
    error: "Method not allowed.",
    code: SCAN_ERROR_CODES.VALIDATION,
    retryable: false,
  });
}
