// 탭 소리를 16kHz 모노로 받아 0.1초(1600샘플)씩 패널로 넘긴다.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600);
    this.n = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (channels && channels.length) {
      const len = channels[0].length;
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (let c = 0; c < channels.length; c++) v += channels[c][i];
        this.buf[this.n++] = v / channels.length;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice());
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
