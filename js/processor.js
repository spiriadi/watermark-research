/**
 * processor.js — Image processing pipeline
 * Watermark Robustness Research Stand
 */

const Processor = {

  /**
   * Step 1: LSB XOR randomization
   * Modifies least significant bit of each RGB channel
   */
  lsbRandomize(canvas, seed) {
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    let s = seed >>> 0;
    const rand = () => {
      s = Math.imul(s, 1664525) + 1013904223 >>> 0;
      return s & 1;
    };
    for (let i = 0; i < d.length; i += 4) {
      d[i]   = (d[i]   & 0xFE) | rand();
      d[i+1] = (d[i+1] & 0xFE) | rand();
      d[i+2] = (d[i+2] & 0xFE) | rand();
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
  },

  /**
   * Step 2: Crop + Resize + Pixel shift
   */
  cropResizeShift(canvas, cropPct, shiftX, shiftY) {
    const w = canvas.width, h = canvas.height;
    const cx = Math.floor(w * cropPct / 100);
    const cy = Math.floor(h * cropPct / 100);

    // Crop to temp canvas
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, cx, cy, w - 2*cx, h - 2*cy, 0, 0, w, h);

    // Pixel roll
    if (shiftX !== 0 || shiftY !== 0) {
      const id = ctx.getImageData(0, 0, w, h);
      const src = id.data;
      const dst = new Uint8ClampedArray(src.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const nx = ((x + shiftX) % w + w) % w;
          const ny = ((y + shiftY) % h + h) % h;
          const si = (y * w + x) * 4;
          const di = (ny * w + nx) * 4;
          dst[di] = src[si]; dst[di+1] = src[si+1];
          dst[di+2] = src[si+2]; dst[di+3] = src[si+3];
        }
      }
      ctx.putImageData(new ImageData(dst, w, h), 0, 0);
    }
    return tmp;
  },

  /**
   * Step 3: JPEG recompression (async)
   */
  jpegRecompress(canvas, quality) {
    return new Promise(resolve => {
      const url = canvas.toDataURL('image/jpeg', quality / 100);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = canvas.width; c.height = canvas.height;
        c.getContext('2d').drawImage(img, 0, 0);
        resolve(c);
      };
      img.src = url;
    });
  },

  /**
   * Step 4: Color jitter ±delta per channel
   */
  colorJitter(canvas, delta, seed) {
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    let s = (seed + 12345) >>> 0;
    const rand = () => {
      s = Math.imul(s, 22695477) + 1 >>> 0;
      return (s % (2 * delta + 1)) - delta;
    };
    for (let i = 0; i < d.length; i += 4) {
      d[i]   = Math.min(255, Math.max(0, d[i]   + rand()));
      d[i+1] = Math.min(255, Math.max(0, d[i+1] + rand()));
      d[i+2] = Math.min(255, Math.max(0, d[i+2] + rand()));
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
  },

  /**
   * Step 5: Upscale × factor → Downscale (bicubic via CSS)
   */
  upscaleDownscale(canvas, factor) {
    return new Promise(resolve => {
      const w = canvas.width, h = canvas.height;
      const big = document.createElement('canvas');
      big.width = w * factor; big.height = h * factor;
      const bctx = big.getContext('2d');
      bctx.imageSmoothingEnabled = true;
      bctx.imageSmoothingQuality = 'high';
      bctx.drawImage(canvas, 0, 0, w * factor, h * factor);

      const small = document.createElement('canvas');
      small.width = w; small.height = h;
      const sctx = small.getContext('2d');
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(big, 0, 0, w, h);
      resolve(small);
    });
  },

  /**
   * Compute PSNR, SSIM, MAE between two canvases
   */
  computeMetrics(origCanvas, resultCanvas) {
    const w = origCanvas.width, h = origCanvas.height;

    const oc = document.createElement('canvas'); oc.width = w; oc.height = h;
    oc.getContext('2d').drawImage(origCanvas, 0, 0);
    const od = oc.getContext('2d').getImageData(0, 0, w, h).data;

    const rc = document.createElement('canvas'); rc.width = w; rc.height = h;
    rc.getContext('2d').drawImage(resultCanvas, 0, 0);
    const rd = rc.getContext('2d').getImageData(0, 0, w, h).data;

    let mse = 0, mae = 0, n = 0;
    for (let i = 0; i < od.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const diff = od[i+c] - rd[i+c];
        mse += diff * diff; mae += Math.abs(diff); n++;
      }
    }
    mse /= n; mae /= n;
    const psnr = mse < 1e-10 ? 100 : 10 * Math.log10(255 * 255 / mse);

    // SSIM (block-based 8×8)
    const bw = 8, bh = 8;
    const c1 = 6.5025, c2 = 58.5225;
    let ssimNum = 0, ssimDen = 0;
    for (let by = 0; by < h; by += bh) {
      for (let bx = 0; bx < w; bx += bw) {
        let mx = 0, my = 0, pix = 0;
        for (let y = by; y < Math.min(by+bh, h); y++) {
          for (let x = bx; x < Math.min(bx+bw, w); x++) {
            const i = (y*w+x)*4;
            mx += 0.299*od[i] + 0.587*od[i+1] + 0.114*od[i+2];
            my += 0.299*rd[i] + 0.587*rd[i+1] + 0.114*rd[i+2];
            pix++;
          }
        }
        if (!pix) continue;
        mx /= pix; my /= pix;
        let vx = 0, vy = 0, cov = 0;
        for (let y = by; y < Math.min(by+bh, h); y++) {
          for (let x = bx; x < Math.min(bx+bw, w); x++) {
            const i = (y*w+x)*4;
            const lx = 0.299*od[i]+0.587*od[i+1]+0.114*od[i+2] - mx;
            const ly = 0.299*rd[i]+0.587*rd[i+1]+0.114*rd[i+2] - my;
            vx += lx*lx; vy += ly*ly; cov += lx*ly;
          }
        }
        vx /= pix; vy /= pix; cov /= pix;
        ssimNum += (2*mx*my+c1)*(2*cov+c2);
        ssimDen += (mx*mx+my*my+c1)*(vx+vy+c2);
      }
    }
    const ssim = ssimDen > 0 ? ssimNum / ssimDen : 1;

    return {
      psnr: Math.round(psnr * 100) / 100,
      ssim: Math.round(ssim * 10000) / 10000,
      mae: Math.round(mae * 100) / 100
    };
  },

  /**
   * Clone a canvas
   */
  clone(canvas) {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    c.getContext('2d').drawImage(canvas, 0, 0);
    return c;
  }
};
