import { describe, expect, test } from "bun:test";
import { photoError, photoType } from "./image";

describe("photo files", () => {
  test("accepts jpeg, png, and webp, including an empty browser type", () => {
    expect(photoType({ type: "image/jpeg", name: "a.jpg" })).toBe("image/jpeg");
    expect(photoType({ type: "image/png", name: "a.png" })).toBe("image/png");
    expect(photoType({ type: "image/webp", name: "a.webp" })).toBe("image/webp");
    expect(photoType({ type: "", name: "scan.JPEG" })).toBe("image/jpeg");
    expect(photoType({ type: "image/gif", name: "a.gif" })).toBeNull();
  });

  test("rejects an empty file, a file over 5 MB, and a type the API will not sign", () => {
    expect(photoError({ type: "image/png", name: "a.png", size: 0 })).toBe("Choose a photo under 5 MB.");
    expect(photoError({ type: "image/png", name: "a.png", size: 5 * 1024 * 1024 + 1 })).toBe("Choose a photo under 5 MB.");
    expect(photoError({ type: "image/gif", name: "a.gif", size: 20 })).toBe("Use a JPEG, PNG, or WebP photo.");
    expect(photoError({ type: "image/png", name: "a.png", size: 2048 })).toBeNull();
  });
});
