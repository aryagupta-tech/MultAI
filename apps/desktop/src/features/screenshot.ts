// Turns a pasted, dropped or picked image into one shareable screenshot: a JPEG data URL small
// enough to travel inside a shared event (the service accepts up to 110,000 characters).

export const SCREENSHOT_LIMIT = 100_000;
const ACCEPTED = /^image\/(png|jpeg|webp|gif|heic|heif)$/u;

export function isImage(file: Blob): boolean {
  return ACCEPTED.test(file.type);
}

/** Downscales and recompresses until it fits; throws with a readable message when it can't. */
export async function toScreenshot(file: Blob): Promise<string> {
  if (!isImage(file)) throw new Error('Attach a PNG, JPEG or WebP screenshot.');
  if (file.size > 25 * 1024 * 1024) throw new Error('That image is too large. Use a screenshot under 25 MB.');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('That image couldn’t be read.'); });
  try {
    let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 8; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('That image couldn’t be read.');
      // JPEG has no transparency; a white backing keeps transparent screenshots legible.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.7, 0.58]) {
        const url = canvas.toDataURL('image/jpeg', quality);
        if (url.length <= SCREENSHOT_LIMIT) return url;
      }
      scale *= 0.75;
    }
    throw new Error('That image couldn’t be made small enough to share.');
  } finally {
    bitmap.close();
  }
}
