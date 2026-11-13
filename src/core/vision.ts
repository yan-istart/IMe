export interface Frame { app: string; width: number; height: number; pixels: Uint8Array; timestamp: number }
export interface ROI { x: number; y: number; width: number; height: number }
/** Raw grayscale input only; provider decoding and sensitive-region masking precede this boundary. */
export class VisionFilter {
  private previous = new Map<string, Uint8Array>();
  constructor(private threshold = 0.12) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('INVALID_THRESHOLD');
  }
  select(frame: Frame, roi: ROI = { x: 0, y: 0, width: frame.width, height: frame.height }, force = false) {
    const { x,y,width,height } = roi;
    if (![frame.width,frame.height,x,y,width,height].every(Number.isSafeInteger)
      || frame.width <= 0 || frame.height <= 0 || x < 0 || y < 0 || width <= 0 || height <= 0
      || x+width > frame.width || y+height > frame.height || frame.pixels.length !== frame.width*frame.height) throw new Error('INVALID_FRAME_ROI');
    const pixels = new Uint8Array(width*height);
    for (let row=0;row<height;row++) pixels.set(frame.pixels.subarray((y+row)*frame.width+x,(y+row)*frame.width+x+width),row*width);
    const key = JSON.stringify([frame.app,frame.width,frame.height,roi]);
    const previous = this.previous.get(key);
    let diff = 0;
    if (previous) for (let i=0;i<pixels.length;i++) diff += Math.abs(pixels[i]!-previous[i]!)/255;
    const change = previous ? diff/pixels.length : 1;
    const selected = force || !previous || change > this.threshold;
    // Compare against last retained frame so slow cumulative changes are eventually detected.
    if (selected) this.previous.set(key,pixels);
    return { selected, change, timestamp: frame.timestamp };
  }
}
