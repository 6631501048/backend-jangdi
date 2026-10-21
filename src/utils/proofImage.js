"use strict";

// Trust actual image bytes rather than the extension or browser-provided MIME type.
// SVG and arbitrary active content are deliberately excluded.
function detectProofImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: "image/png", ext: ".png" };
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: ".webp" };
  }
  return null;
}

module.exports = { detectProofImage };
