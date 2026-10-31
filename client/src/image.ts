/** Matches `products.presignImage` and the default `UPLOAD_MAX_BYTES` (5 MB). */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export type PhotoType = "image/jpeg" | "image/png" | "image/webp";

const BY_TYPE: Record<string, PhotoType> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};

/** The type the presign call must send. Uses the file extension when the browser leaves `type` empty. */
export function photoType(file: { type: string; name: string }): PhotoType | null {
  if (BY_TYPE[file.type]) return BY_TYPE[file.type];
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return null;
}

export function photoError(file: { type: string; name: string; size: number }): string | null {
  if (!photoType(file)) return "Use a JPEG, PNG, or WebP photo.";
  if (file.size <= 0 || file.size > MAX_PHOTO_BYTES) return "Choose a photo under 5 MB.";
  return null;
}
