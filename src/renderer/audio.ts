function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToPcm16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer);
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.round(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let source = start; source < end; source += 1) sum += input[source];
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

export class MicrophoneStream {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private muted = true;

  async start(onAudio: (base64Pcm16: string) => void): Promise<void> {
    if (this.stream) {
      this.muted = false;
      return;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.context = new AudioContext();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (this.muted) return;
      const samples = resample(event.inputBuffer.getChannelData(0), this.context?.sampleRate ?? 48000, 24000);
      const pcm = new Int16Array(samples.length);
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      onAudio(bytesToBase64(new Uint8Array(pcm.buffer)));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.context.destination);
    this.muted = false;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  stop(): void {
    this.muted = true;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.context = undefined;
    this.stream = undefined;
    this.source = undefined;
    this.processor = undefined;
  }
}

export class RealtimePcmPlayer {
  private context?: AudioContext;
  private nextStart = 0;
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private flushTimer?: number;
  private activeSources = 0;
  private playbackActive = false;

  constructor(private readonly onPlaybackState?: (active: boolean) => void) {}

  play(base64Pcm16: string): void {
    const pcm = base64ToPcm16(base64Pcm16);
    if (pcm.length === 0) return;
    this.setPlaybackActive(true);
    this.pending.push(pcm);
    this.pendingSamples += pcm.length;
    if (this.pendingSamples >= 2_400) this.flush();
    else if (this.flushTimer === undefined) this.flushTimer = window.setTimeout(() => this.flush(), 20);
  }

  stop(): void {
    if (this.flushTimer !== undefined) window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending = [];
    this.pendingSamples = 0;
    this.activeSources = 0;
    void this.context?.close();
    this.context = undefined;
    this.nextStart = 0;
    this.setPlaybackActive(false);
  }

  private flush(): void {
    if (this.flushTimer !== undefined) window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pendingSamples === 0) return;

    this.context ??= new AudioContext({ sampleRate: 24_000 });
    const buffer = this.context.createBuffer(1, this.pendingSamples, 24_000);
    const channel = buffer.getChannelData(0);
    let offset = 0;
    for (const pcm of this.pending) {
      for (let index = 0; index < pcm.length; index += 1) channel[offset + index] = pcm[index] / 0x8000;
      offset += pcm.length;
    }
    this.pending = [];
    this.pendingSamples = 0;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const startAt = Math.max(this.context.currentTime + 0.02, this.nextStart);
    this.activeSources += 1;
    source.onended = () => {
      this.activeSources = Math.max(0, this.activeSources - 1);
      if (this.activeSources === 0 && this.pendingSamples === 0) this.setPlaybackActive(false);
    };
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;
  }

  private setPlaybackActive(active: boolean): void {
    if (this.playbackActive === active) return;
    this.playbackActive = active;
    this.onPlaybackState?.(active);
  }
}
