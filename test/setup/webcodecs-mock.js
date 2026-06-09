// Fakes the WebCodecs + <canvas> 2D APIs that TikTok's `buildH264MP4()` needs.
// jsdom doesn't implement WebCodecs or canvas rendering at all, and the real
// encoders are far too heavy to run in a test — these stand-ins let the
// slideshow-build step complete quickly so later steps (file injection,
// caption/location fill, posting) are reachable and testable.
//
// Deliberately NOT mocked: `AudioEncoder` / `AudioData` — leaving them
// undefined makes the injector skip audio encoding (`aChunks = []`), which is
// the same "video-only fallback" path it takes in production when AAC isn't
// supported. That keeps this mock small without weakening the assertions we
// care about (the audio path is exercised separately via the `tiktokAudioDataUrl`
// retry-without-audio behaviour in `handleSocialPost`, not inside the injector).

class FakeVideoFrame {
  constructor(_source, init = {}) {
    this.timestamp = init.timestamp ?? 0;
    this.duration = init.duration ?? 0;
  }
  close() {}
}

class FakeVideoEncoder {
  constructor({ output, error }) {
    this._output = output;
    this._error = error;
  }
  configure() {}
  encode(frame, opts = {}) {
    const chunk = {
      type: opts.keyFrame ? 'key' : 'delta',
      timestamp: frame.timestamp,
      byteLength: 16,
      copyTo: (buf) => new Uint8Array(buf).fill(0),
    };
    // No `decoderConfig` in `meta` — muxMP4 falls back to its built-in SPS/PPS.
    this._output(chunk, {});
  }
  async flush() {}
  close() {}
}
FakeVideoEncoder.isConfigSupported = jest.fn(async (config) => ({ supported: true, config }));

const fakeCtx2d = {
  fillStyle: '#000', strokeStyle: '#000', font: '', textAlign: 'left', textBaseline: 'alphabetic',
  shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
  fillRect: jest.fn(), strokeRect: jest.fn(), clearRect: jest.fn(),
  drawImage: jest.fn(), fillText: jest.fn(), strokeText: jest.fn(),
  measureText: jest.fn((text) => ({ width: (text || '').length * 8 })),
  getImageData: jest.fn((_x, _y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) })),
  createLinearGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
  createRadialGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
};

beforeEach(() => {
  global.VideoFrame = FakeVideoFrame;
  global.VideoEncoder = FakeVideoEncoder;
  delete global.AudioEncoder;
  delete global.AudioData;
  delete global.AudioContext;
  delete global.webkitAudioContext;

  HTMLCanvasElement.prototype.getContext = jest.fn(() => fakeCtx2d);
  HTMLCanvasElement.prototype.toDataURL = jest.fn(() => 'data:image/jpeg;base64,ZmFrZQ==');

  // jsdom doesn't decode images — fire onload via a 0ms fake setTimeout so that
  // jest.advanceTimersByTimeAsync() drains it predictably for any number of images.
  // Using queueMicrotask() caused the multi-image chain to outlast advanceTimersByTimeAsync's
  // single-level microtask drain, leaving build_video_done unfired in step-1 tests.
  class FakeImage {
    constructor() {
      this.naturalWidth = 800;
      this.naturalHeight = 600;
      this._src = '';
    }
    set src(v) {
      this._src = v;
      setTimeout(() => this.onload && this.onload(), 0);
    }
    get src() { return this._src; }
  }
  global.Image = FakeImage;
});
