// Echo suppression for the microphone capture.
//
// The meeting plugin records two streams: WASAPI loopback (what the meeting
// plays through the speakers) and the microphone (the user, plus whatever the
// speakers leak into it).  Without a reference-based gate the leaked remote
// speech is transcribed a second time and attributed to 自己.
//
// A full AEC (WebRTC AEC3 style adaptive filter) is not worth it here: a wrong
// filter makes the record worse, and this plugin's clock alignment is only as
// good as the two sockets.  Instead this module decides per microphone VAD
// segment whether the segment is *only* speaker echo, using the loopback as
// the reference:
//
//   1. both streams become 10 ms RMS→dB envelopes,
//   2. the microphone segment is correlated against the loopback envelope over
//      a delay search (the acoustic path can be 0–450 ms behind the render),
//   3. a segment is echo when the envelopes are strongly correlated AND the
//      microphone is not louder than the loopback by more than a margin
//      (louder means the user is talking over the echo → keep, double-talk),
//   4. quiet or reference-less stretches keep everything.
//
// The decision is conservative by design: a missed echo costs one duplicate
// line (the meeting.mjs text-level duplicate guard catches most of them), while
// a wrongly dropped near-end sentence loses what the user actually said.
//
// Pure functions + one stateful class, so scripts/selftest.mjs can exercise it
// with synthetic echo/double-talk signals and no audio device.

const SAMPLE_RATE = 16000;
const FRAME_MS = 10;
const FRAME_SAMPLES = Math.round(SAMPLE_RATE * FRAME_MS / 1000);

function toDb(value) {
  return 20 * Math.log10(value + 1e-9);
}

function dbEnvelope(samples, endMs) {
  const frames = Math.floor(samples.length / FRAME_SAMPLES);
  const result = [];
  if (frames === 0) return result;
  let smoothed = null;
  for (let index = 0; index < frames; index += 1) {
    let sum = 0;
    const offset = index * FRAME_SAMPLES;
    for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
      const value = samples[offset + sample];
      sum += value * value;
    }
    const db = toDb(Math.sqrt(sum / FRAME_SAMPLES));
    smoothed = smoothed === null ? db : smoothed * 0.6 + db * 0.4;
    result.push({ t: endMs - (frames - index) * FRAME_MS, db: smoothed });
  }
  return result;
}

/** Pearson correlation over paired dB envelopes. */
export function correlation(left, right) {
  const length = Math.min(left.length, right.length);
  if (length < 2) return 0;
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < length; index += 1) {
    leftMean += left[index];
    rightMean += right[index];
  }
  leftMean /= length;
  rightMean /= length;
  let covariance = 0;
  let leftPower = 0;
  let rightPower = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    covariance += a * b;
    leftPower += a * a;
    rightPower += b * b;
  }
  const denominator = Math.sqrt(leftPower * rightPower);
  return denominator <= 1e-9 ? 0 : covariance / denominator;
}

/**
 * Character-bigram Dice similarity for the text-level duplicate guard.
 * Normalizes case, whitespace and punctuation, so "对，我们下周再定。" and
 * "对我们下周再定" score as the same sentence.
 */
export function textSimilarity(left, right) {
  const normalize = (value) => String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  const a = normalize(left);
  const b = normalize(right);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const grams = (text) => {
    const set = new Map();
    for (let index = 0; index < text.length - 1; index += 1) {
      const gram = text.slice(index, index + 2);
      set.set(gram, (set.get(gram) ?? 0) + 1);
    }
    return set;
  };
  const first = grams(a);
  const second = grams(b);
  let overlap = 0;
  for (const [gram, count] of first) {
    const other = second.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  const total = (a.length - 1) + (b.length - 1);
  return total <= 0 ? 0 : (2 * overlap) / total;
}

/**
 * Per-meeting echo gate.
 *
 * Feed loopback audio with `pushReference(samples, atMs)`; for a microphone VAD
 * segment call `decide(samples, startMs, endMs)` with the wall-clock times of
 * the segment (computable from the first microphone chunk's arrival time).
 */
export class EchoGate {
  constructor(options = {}) {
    this.windowMs = Number(options.windowMs) || 60000;
    this.minDelayMs = Number.isFinite(Number(options.minDelayMs)) ? Number(options.minDelayMs) : -50;
    this.maxDelayMs = Number.isFinite(Number(options.maxDelayMs)) ? Number(options.maxDelayMs) : 450;
    this.stepMs = Number(options.stepMs) || FRAME_MS;
    this.threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.75;
    this.marginDb = Number.isFinite(Number(options.marginDb)) ? Number(options.marginDb) : 6;
    this.minOverlapMs = Number(options.minOverlapMs) || 300;
    this.minSegmentMs = Number(options.minSegmentMs) || 200;
    this.minReferenceDb = Number.isFinite(Number(options.minReferenceDb))
      ? Number(options.minReferenceDb) : -62;
    this.minMicDb = Number.isFinite(Number(options.minMicDb)) ? Number(options.minMicDb) : -58;
    this.shadow = options.shadow === true;
    this.reference = [];
    this.last = null;
    this.stats = { segments: 0, dropped: 0, kept: 0, shadows: 0 };
  }

  /** Append loopback audio (16 kHz mono float) that ended at wall-clock `atMs`. */
  pushReference(samples, atMs) {
    if (!samples || samples.length === 0) return;
    const endMs = Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now();
    for (const frame of dbEnvelope(samples, endMs)) this.reference.push(frame);
    const cutoff = endMs - this.windowMs;
    if (this.reference.length > 0 && this.reference[0].t < cutoff) {
      this.reference = this.reference.filter((frame) => frame.t >= cutoff);
    }
  }

  /** Reference dB at (or near) a wall-clock time, or undefined. */
  referenceDbAt(timeMs) {
    const frames = this.reference;
    if (frames.length === 0) return undefined;
    let low = 0;
    let high = frames.length - 1;
    if (timeMs < frames[0].t - FRAME_MS || timeMs > frames[high].t + FRAME_MS) return undefined;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (frames[middle].t <= timeMs) low = middle;
      else high = middle;
    }
    const best = Math.abs(frames[low].t - timeMs) <= Math.abs(frames[high].t - timeMs) ? frames[low] : frames[high];
    return Math.abs(best.t - timeMs) > FRAME_MS * 2 ? undefined : best.db;
  }

  /**
   * Decide whether one microphone segment is only speaker echo.
   *
   * @param {Float32Array} samples 16 kHz mono microphone audio of the segment.
   * @param {number} startMs wall-clock start of the segment.
   * @param {number} endMs wall-clock end of the segment.
   * @returns {{action: 'keep'|'drop', echo: boolean, r: number, lagMs: number,
   *   deltaDb: number, overlapMs: number, reason: string}}
   */
  decide(samples, startMs, endMs) {
    const micFrames = dbEnvelope(samples, Number.isFinite(Number(endMs))
      ? Number(endMs)
      : (Number(startMs) || Date.now()) + (samples.length / SAMPLE_RATE) * 1000);
    this.stats.segments += 1;
    const durationMs = (samples.length / SAMPLE_RATE) * 1000;
    const micMeanDb = micFrames.length === 0
      ? -100
      : micFrames.reduce((sum, frame) => sum + frame.db, 0) / micFrames.length;
    const decision = {
      action: 'keep', echo: false, r: 0, lagMs: 0, deltaDb: 0,
      overlapMs: 0, reason: 'insufficient-reference'
    };
    if (this.reference.length === 0 || micFrames.length === 0) {
      this.record(decision);
      return decision;
    }
    if (micMeanDb < this.minMicDb) {
      decision.reason = 'quiet';
      this.record(decision);
      return decision;
    }
    // Judge the reference energy around the segment's own delay window, not
    // over the whole buffer: a long silence before the leak would otherwise
    // average the reference below the floor and let the echo through.
    const windowStart = micFrames[0].t - this.maxDelayMs - FRAME_MS;
    const windowEnd = micFrames[micFrames.length - 1].t + FRAME_MS;
    const referenceWindow = this.reference.filter((frame) => frame.t >= windowStart && frame.t <= windowEnd);
    const referenceFrames = referenceWindow.length > 0 ? referenceWindow : this.reference;
    let referenceSum = 0;
    for (const frame of referenceFrames) referenceSum += frame.db;
    if (referenceSum / referenceFrames.length < this.minReferenceDb) {
      decision.reason = 'silent-reference';
      this.record(decision);
      return decision;
    }

    let best = { r: 0, lagMs: 0, deltaDb: 0, overlapMs: 0, echoes: false };
    for (let lag = this.minDelayMs; lag <= this.maxDelayMs; lag += this.stepMs) {
      const micValues = [];
      const referenceValues = [];
      for (const frame of micFrames) {
        const referenceDb = this.referenceDbAt(frame.t - lag);
        if (referenceDb === undefined) continue;
        micValues.push(frame.db);
        referenceValues.push(referenceDb);
      }
      const overlapMs = micValues.length * FRAME_MS;
      if (overlapMs < this.minOverlapMs || micValues.length < micFrames.length * 0.6) continue;
      const r = correlation(micValues, referenceValues);
      const micMean = micValues.reduce((sum, value) => sum + value, 0) / micValues.length;
      const referenceMean = referenceValues.reduce((sum, value) => sum + value, 0) / referenceValues.length;
      const deltaDb = micMean - referenceMean;
      // Prefer a lag where the microphone is not louder than its own echo.
      const echoes = deltaDb <= this.marginDb;
      if (r > best.r) {
        best = { r, lagMs: lag, deltaDb, overlapMs, echoes };
      } else if (!best.echoes && echoes && r >= best.r * 0.92) {
        best = { r, lagMs: lag, deltaDb, overlapMs, echoes };
      }
    }
    decision.r = Math.round(best.r * 1000) / 1000;
    decision.lagMs = best.lagMs;
    decision.deltaDb = Math.round(best.deltaDb * 10) / 10;
    decision.overlapMs = best.overlapMs;
    const isShort = durationMs < this.minSegmentMs;
    if (best.r >= this.threshold && best.echoes) {
      decision.echo = true;
      decision.reason = isShort ? 'echo-short' : 'echo';
      decision.action = this.shadow ? 'keep' : 'drop';
      if (this.shadow) this.stats.shadows += 1;
      else this.stats.dropped += 1;
    } else if (best.r >= this.threshold && !best.echoes) {
      decision.reason = 'double-talk';
      this.stats.kept += 1;
    } else {
      decision.reason = 'no-match';
      this.stats.kept += 1;
    }
    this.record(decision);
    return decision;
  }

  record(decision) {
    this.last = { ...decision, at: Date.now() };
  }

  reset() {
    this.reference = [];
    this.last = null;
    this.stats = { segments: 0, dropped: 0, kept: 0, shadows: 0 };
  }
}

export { FRAME_MS, FRAME_SAMPLES, SAMPLE_RATE };
