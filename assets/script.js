// Audio Analyzer: BPM, rough structure, chord progression
// All processing is done client-side using the Web Audio API and simple DSP.
//
// Notes:
// - Estimates are heuristic and may be off for complex mixes.
// - Works best on clean recordings with steady rhythm.

(function () {
  const fileInput = document.getElementById("fileInput");
  const statusEl = document.getElementById("status");
  const resultsEl = document.getElementById("results");
  const bpmEl = document.getElementById("bpmResults");
  const structureEl = document.getElementById("structureResults");
  const chordTimelineEl = document.getElementById("chordTimeline");
  const chordFrequencyEl = document.getElementById("chordFrequency");
  const audioPlayer = document.getElementById("audioPlayer");
  const playerSection = document.getElementById("playerSection");

  if (!fileInput) {
    console.warn("Audio analyzer UI not present.");
    return;
  }

  let audioCtx;

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    resetUI();

    // Show audio preview
    const objectURL = URL.createObjectURL(file);
    audioPlayer.src = objectURL;
    playerSection.style.display = "block";

    setStatus("Decoding audio...");

    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume(); // ensure unlocked on user gesture

      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await decodeAudio(arrayBuffer, audioCtx);

      setStatus("Analyzing... This can take a few seconds for longer files.");

      const analysis = await analyzeAudioBuffer(audioBuffer);

      renderResults(analysis);
      clearStatus();
    } catch (err) {
      console.error(err);
      setStatus("Error: " + (err && err.message ? err.message : String(err)));
    }
  });

  function resetUI() {
    bpmEl.textContent = "";
    structureEl.textContent = "";
    statusEl.style.display = "none";
    resultsEl.style.display = "none";
    if (chordTimelineEl) chordTimelineEl.innerHTML = "";
    if (chordFrequencyEl) chordFrequencyEl.innerHTML = "";
  }

  function setStatus(text) {
    statusEl.style.display = "block";
    statusEl.textContent = text;
  }

  function clearStatus() {
    statusEl.style.display = "none";
    statusEl.textContent = "";
  }

  function renderResults(analysis) {
    resultsEl.style.display = "block";

    // BPM
    const bpmLines = [];
    if (analysis.mainBpm) {
      bpmLines.push(`Estimated BPM: ${analysis.mainBpm.toFixed(1)}`);
    } else {
      bpmLines.push("Estimated BPM: Not found");
    }
    if (analysis.bpmCandidates && analysis.bpmCandidates.length > 0) {
      const alts = analysis.bpmCandidates
        .slice(0, 5)
        .map((b) => `${b.bpm.toFixed(1)} (${(b.confidence * 100).toFixed(0)}%)`)
        .join(", ");
      bpmLines.push(`Other candidates: ${alts}`);
    }
    bpmEl.innerHTML = `<p class="small">${bpmLines.join("<br>")}</p>`;

    // Structure
    if (analysis.segments && analysis.segments.length > 0) {
      const items = analysis.segments.map((seg) => {
        return `<li><span class="badge">${seg.label}</span> ${fmtTime(seg.start)} – ${fmtTime(seg.end)}</li>`;
      });
      structureEl.innerHTML = `<ul class="list">${items.join("")}</ul>`;
    } else {
      structureEl.textContent = "No clear segments detected.";
    }

    // Chords visualizations only (no textual progression)
    if (analysis.chords && analysis.chords.length > 0) {
      renderChordTimeline(analysis.chords, analysis.duration);
      renderChordFrequency(analysis.chords, analysis.duration);
    } else {
      const tl = document.getElementById("chordTimeline");
      const fq = document.getElementById("chordFrequency");
      if (tl) tl.innerHTML = "<p class='small'>No chords detected.</p>";
      if (fq) fq.innerHTML = "";
    }
  }

  async function decodeAudio(arrayBuffer, ctx) {
    // Safari supports the callback style; modern browsers support Promise
    try {
      return await ctx.decodeAudioData(arrayBuffer);
    } catch (e) {
      return new Promise((resolve, reject) => {
        ctx.decodeAudioData(arrayBuffer, resolve, reject);
      });
    }
  }

  function fmtTime(seconds) {
    seconds = Math.max(0, seconds || 0);
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
    // Could add ms if needed
  }

  // Core analysis
  async function analyzeAudioBuffer(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const duration = audioBuffer.duration;

    // Convert to mono
    const mono = toMono(audioBuffer);

    // Analysis params
    const frameSize = 2048;
    const hopSize = 1024;
    const window = makeHannWindow(frameSize);
    const nyquist = sampleRate / 2;
    const nFrames = Math.max(0, 1 + Math.floor((mono.length - frameSize) / hopSize));

    // Buffers reused to reduce allocations
    const real = new Float32Array(frameSize);
    const imag = new Float32Array(frameSize);
    const mags = new Float32Array(frameSize / 2);

    const spectralFlux = new Float32Array(nFrames);
    const chromaSeries = new Array(nFrames);
    let prevMags = null;

    const minFreq = 50;
    const maxFreq = 5000;

    // Precompute bin ranges
    const binHz = sampleRate / frameSize;
    const minBin = Math.max(1, Math.floor(minFreq / binHz));
    const maxBin = Math.min(mags.length - 1, Math.floor(maxFreq / binHz));

    for (let i = 0; i < nFrames; i++) {
      const start = i * hopSize;

      // Copy and window
      for (let j = 0; j < frameSize; j++) {
        real[j] = (mono[start + j] || 0) * window[j];
        imag[j] = 0;
      }

      // FFT
      fftInPlace(real, imag);

      // Magnitudes (half spectrum)
      for (let k = 0; k < mags.length; k++) {
        const re = real[k];
        const im = imag[k];
        mags[k] = Math.sqrt(re * re + im * im);
      }

      // Spectral flux (positive changes)
      let flux = 0;
      if (prevMags) {
        for (let k = minBin; k <= maxBin; k++) {
          const diff = mags[k] - prevMags[k];
          if (diff > 0) flux += diff;
        }
      }
      spectralFlux[i] = flux;
      prevMags = Float32Array.from(mags); // make a copy

      // Chroma features per frame
      chromaSeries[i] = computeChroma(mags, sampleRate, frameSize);
    }

    // Normalize and smooth onset envelope
    const onsetEnv = smoothArray(normalizeArray(spectralFlux), 4);

    // BPM estimation via autocorrelation
    const bpmEst = estimateTempo(onsetEnv, sampleRate, hopSize);

    // Novelty from frame-to-frame chroma change
    const chromaNovelty = new Float32Array(nFrames);
    for (let i = 1; i < nFrames; i++) {
      const a = chromaSeries[i - 1];
      const b = chromaSeries[i];
      chromaNovelty[i] = chromaDistance(a, b);
    }
    const noveltySm = smoothArray(normalizeArray(chromaNovelty), 6);

    // Segment boundaries: peaks in novelty above a dynamic threshold
    const minSegGapFrames = Math.max(12, Math.floor((sampleRate / hopSize) * 2)); // ~2s min gap
    const segIdxs = pickPeaks(noveltySm, minSegGapFrames, dynamicThreshold(noveltySm));
    // Ensure 0 and end are included
    if (segIdxs.length === 0 || segIdxs[0] !== 0) segIdxs.unshift(0);
    if (segIdxs[segIdxs.length - 1] !== nFrames - 1) segIdxs.push(nFrames - 1);

    // Build segments in seconds
    const segmentsRaw = [];
    for (let i = 0; i < segIdxs.length - 1; i++) {
      const s = segIdxs[i] * hopSize / sampleRate;
      const e = segIdxs[i + 1] * hopSize / sampleRate;
      segmentsRaw.push({ start: s, end: e });
    }

    // Label segments by chroma centroid similarity (A/B/C...)
    const segLabels = labelSegmentsByChroma(segmentsRaw, chromaSeries);
    const segments = segmentsRaw.map((seg, idx) => ({ ...seg, label: segLabels[idx] }));

    // Chord progression: windowed chroma -> template match
    const mainBpm = bpmEst.mainBpm || bpmEst.bpmCandidates[0]?.bpm || null;
    const chords = detectChords(chromaSeries, sampleRate, hopSize, mainBpm);

    return {
      sampleRate,
      duration,
      mainBpm: bpmEst.mainBpm || null,
      bpmCandidates: bpmEst.bpmCandidates || [],
      segments,
      chords
    };
  }

  function toMono(audioBuffer) {
    const { numberOfChannels, length } = audioBuffer;
    if (numberOfChannels === 1) {
      return audioBuffer.getChannelData(0);
    }
    const mono = new Float32Array(length);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        mono[i] += data[i] / numberOfChannels;
      }
    }
    return mono;
  }

  function makeHannWindow(N) {
    const w = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
    }
    return w;
  }

  // In-place iterative Cooley-Tukey FFT (radix-2)
  function fftInPlace(real, imag) {
    const n = real.length;

    // Bit-reversal permutation
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i < j) {
        const tr = real[i]; real[i] = real[j]; real[j] = tr;
        const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
      let m = n >> 1;
      while (m >= 1 && j >= m) {
        j -= m;
        m >>= 1;
      }
      j += m;
    }

    // Danielson-Lanczos section
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wcos = Math.cos(ang);
      const wsin = Math.sin(ang);

      for (let i = 0; i < n; i += len) {
        let wr = 1.0, wi = 0.0;
        const half = len >>> 1;
        for (let k = 0; k < half; k++) {
          const j2 = i + k + half;

          const tr = real[j2] * wr - imag[j2] * wi;
          const ti = real[j2] * wi + imag[j2] * wr;

          const ur = real[i + k];
          const ui = imag[i + k];

          real[i + k] = ur + tr;
          imag[i + k] = ui + ti;

          real[j2] = ur - tr;
          imag[j2] = ui - ti;

          // rotate twiddle
          const tmp = wr;
          wr = tmp * wcos - wi * wsin;
          wi = tmp * wsin + wi * wcos;
        }
      }
    }
  }

  // Compute 12-bin chroma from magnitude spectrum
  function computeChroma(mags, sampleRate, frameSize) {
    const chroma = new Float32Array(12);
    const binHz = sampleRate / frameSize;
    const nyquist = sampleRate / 2;

    for (let k = 1; k < mags.length; k++) {
      const f = k * binHz;
      if (f < 50 || f > 5000) continue; // focus on typical musical range
      const m = mags[k];
      // Map frequency -> MIDI -> pitch class
      const midi = 69 + 12 * Math.log2(f / 440);
      const pc = Math.round(midi) % 12;
      if (pc >= 0 && pc < 12) {
        // log compression to balance harmonics
        chroma[pc] += Math.log1p(m);
      }
    }

    // Normalize
    const sum = chroma.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < 12; i++) chroma[i] /= sum;

    return chroma;
  }

  function normalizeArray(arr) {
    const out = new Float32Array(arr.length);
    let max = -Infinity, min = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v > max) max = v;
      if (v < min) min = v;
    }
    const range = (max - min) || 1;
    for (let i = 0; i < arr.length; i++) {
      out[i] = (arr[i] - min) / range;
    }
    return out;
  }

  function smoothArray(arr, win) {
    const out = new Float32Array(arr.length);
    const w = Math.max(1, win | 0);
    let acc = 0;
    for (let i = 0; i < arr.length; i++) {
      acc += arr[i];
      if (i >= w) acc -= arr[i - w];
      out[i] = acc / Math.min(i + 1, w);
    }
    return out;
  }

  function estimateTempo(onsetEnv, sampleRate, hopSize) {
    const lMin = Math.max(2, Math.floor((sampleRate / hopSize) * (60 / 220)));
    const lMax = Math.min(onsetEnv.length - 2, Math.floor((sampleRate / hopSize) * (60 / 50)));

    const ac = new Float32Array(lMax + 1);
    for (let lag = lMin; lag <= lMax; lag++) {
      let sum = 0;
      for (let t = lag; t < onsetEnv.length; t++) {
        sum += onsetEnv[t] * onsetEnv[t - lag];
      }
      ac[lag] = sum;
    }

    // Find peaks
    const peaks = [];
    for (let lag = lMin + 1; lag <= lMax - 1; lag++) {
      const v = ac[lag];
      if (v > ac[lag - 1] && v > ac[lag + 1]) {
        peaks.push({ lag, score: v });
      }
    }
    peaks.sort((a, b) => b.score - a.score);

    const candidates = peaks.slice(0, 8).map(p => ({
      bpm: (60 * sampleRate) / (hopSize * p.lag),
      confidence: p.score / (peaks[0]?.score || 1)
    }));

    // Adjust for double/half tempo redundancies
    const merged = mergeTempoCandidates(candidates);

    return {
      mainBpm: merged[0]?.bpm || null,
      bpmCandidates: merged
    };
  }

  function mergeTempoCandidates(cands) {
    const out = [];
    for (const c of cands) {
      let bpm = c.bpm;
      // Bring into 60-200 range
      while (bpm < 60) bpm *= 2;
      while (bpm > 200) bpm /= 2;
      const existing = out.find(x => Math.abs(x.bpm - bpm) < 1.0);
      if (existing) {
        existing.confidence = Math.max(existing.confidence, c.confidence);
      } else {
        out.push({ bpm, confidence: c.confidence });
      }
    }
    out.sort((a, b) => b.confidence - a.confidence);
    return out;
  }

  function chromaDistance(a, b) {
    // 1 - cosine similarity
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < 12; i++) {
      const ai = a[i], bi = b[i];
      dot += ai * bi;
      na += ai * ai;
      nb += bi * bi;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
    return 1 - (dot / denom);
  }

  function dynamicThreshold(arr) {
    // mean + k*std
    let mean = 0;
    for (let i = 0; i < arr.length; i++) mean += arr[i];
    mean /= arr.length;
    let v2 = 0;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] - mean;
      v2 += d * d;
    }
    const std = Math.sqrt(v2 / arr.length);
    return mean + 0.6 * std;
  }

  function pickPeaks(arr, minDistance, threshold) {
    const peaks = [];
    for (let i = 1; i < arr.length - 1; i++) {
      if (arr[i] > threshold && arr[i] > arr[i - 1] && arr[i] > arr[i + 1]) {
        peaks.push(i);
        i += minDistance; // skip ahead to enforce min gap
      }
    }
    return peaks;
  }

  function labelSegmentsByChroma(segments, chromaSeries) {
    const labels = [];
    const centroids = [];

    const labelChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let nextLabelIdx = 0;

    const totalDuration = segments[segments.length - 1].end || 1;
    const framesPerSecond = chromaSeries.length / totalDuration;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const sFrame = Math.max(0, Math.floor(seg.start * framesPerSecond));
      const eFrame = Math.min(chromaSeries.length - 1, Math.max(sFrame + 1, Math.floor(seg.end * framesPerSecond)));

      const centroid = new Float32Array(12);
      let count = 0;
      for (let f = sFrame; f <= eFrame; f++) {
        const c = chromaSeries[f];
        if (!c) continue;
        for (let k = 0; k < 12; k++) centroid[k] += c[k];
        count++;
      }
      if (count > 0) for (let k = 0; k < 12; k++) centroid[k] /= count;

      // Compare with previous centroids
      let matchedLabel = null;
      for (let j = 0; j < centroids.length; j++) {
        const sim = 1 - chromaDistance(centroid, centroids[j]);
        if (sim >= 0.95) {
          matchedLabel = labels[j];
          break;
        }
      }
      if (!matchedLabel) {
        matchedLabel = labelChars[nextLabelIdx] || `S${nextLabelIdx + 1}`;
        nextLabelIdx++;
        centroids.push(centroid);
      }
      labels.push(matchedLabel);
    }

    return labels;
  }

  function detectChords(chromaSeries, sampleRate, hopSize, bpm) {
    const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

    const majorTemplate = new Array(12).fill(0);
    majorTemplate[0] = 1; // root
    majorTemplate[4] = 1; // major third
    majorTemplate[7] = 1; // perfect fifth

    const minorTemplate = new Array(12).fill(0);
    minorTemplate[0] = 1;
    minorTemplate[3] = 1; // minor third
    minorTemplate[7] = 1;

    const framesPerSecond = sampleRate / hopSize;
    const beatSec = bpm ? (60 / bpm) : 0.5; // fallback window 0.5s
    const winFrames = Math.max(8, Math.floor(framesPerSecond * beatSec)); // at least ~8 frames

    const chords = [];
    let lastLabel = null;

    for (let i = 0; i < chromaSeries.length; i += winFrames) {
      const end = Math.min(chromaSeries.length - 1, i + winFrames - 1);
      const cMean = new Float32Array(12);
      let count = 0;
      for (let f = i; f <= end; f++) {
        const c = chromaSeries[f];
        if (!c) continue;
        for (let k = 0; k < 12; k++) cMean[k] += c[k];
        count++;
      }
      if (count > 0) for (let k = 0; k < 12; k++) cMean[k] /= count;

      // Normalize mean chroma
      let sum = 0;
      for (let k = 0; k < 12; k++) sum += cMean[k];
      sum = sum || 1;
      for (let k = 0; k < 12; k++) cMean[k] /= sum;

      // Match to templates across all roots
      let best = { chord: "N", score: 0 };
      for (let r = 0; r < 12; r++) {
        let scoreMaj = 0, scoreMin = 0;
        for (let k = 0; k < 12; k++) {
          const idxMaj = (k + r) % 12;
          scoreMaj += cMean[idxMaj] * majorTemplate[k];
          const idxMin = (k + r) % 12;
          scoreMin += cMean[idxMin] * minorTemplate[k];
        }
        if (scoreMaj > best.score) best = { chord: `${names[r]} major`, score: scoreMaj };
        if (scoreMin > best.score) best = { chord: `${names[r]} minor`, score: scoreMin };
      }

      // Confidence threshold to mark "N" (no chord)
      const conf = best.score; // already normalized-ish by chroma sum
      const label = conf >= 0.12 ? best.chord : "N";

      // Only emit when the chord changes from the last emitted label
      if (label !== lastLabel) {
        const startSec = i / framesPerSecond;
        chords.push({ start: startSec, chord: label, confidence: Math.min(1, conf) });
        lastLabel = label;
      }
    }

    return chords;
  }

// Color mapping by chord label
  function chordColor(label) {
    if (!label || label === "N") {
      return "hsl(0, 0%, 78%)";
    }
    const parts = label.split(" ");
    const root = parts[0]; // e.g., "C", "C#", "D"
    const quality = (parts[1] || "").toLowerCase(); // "major" | "minor"
    const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const pc = names.indexOf(root);
    const hue = pc >= 0 ? Math.round((pc / 12) * 360) : 0;
    const sat = quality === "minor" ? 55 : 65;
    const light = quality === "minor" ? 45 : 60;
    return `hsl(${hue}, ${sat}%, ${light}%)`;
  }

  function shortChordLabel(label) {
    if (!label || label === "N") return "N";
    const parts = label.split(" ");
    const root = parts[0];
    const quality = (parts[1] || "").toLowerCase();
    return quality === "minor" ? `${root}min` : `${root}maj`;
  }

  function renderChordTimeline(chords, duration) {
    const tl = document.getElementById("chordTimeline");
    if (!tl) return;
    tl.innerHTML = "";

    const dur = Math.max(0.1, duration || (chords[chords.length - 1]?.start || 0));
    const pxPerSec = Math.min(18, Math.max(6, 1000 / dur));
    const height = Math.round(pxPerSec * dur);
    tl.style.height = `${height}px`;

    // Minute ticks
    const minutes = Math.floor(dur / 60);
    for (let m = 1; m <= minutes; m++) {
      const tick = document.createElement("div");
      tick.className = "timeline-tick";
      tick.style.top = `${Math.round(m * 60 * pxPerSec)}px`;
      tick.textContent = `${m}m`;
      tl.appendChild(tick);
    }

    // Blocks
    for (let i = 0; i < chords.length; i++) {
      const start = chords[i].start;
      const end = i < chords.length - 1 ? chords[i + 1].start : dur;
      const h = Math.max(2, Math.round((end - start) * pxPerSec));
      const top = Math.round(start * pxPerSec);

      const block = document.createElement("div");
      block.className = "timeline-block";
      block.style.top = `${top}px`;
      block.style.height = `${h}px`;
      block.style.background = chordColor(chords[i].chord);

      const label = document.createElement("span");
      label.className = "timeline-label";
      label.textContent = shortChordLabel(chords[i].chord);

      block.appendChild(label);
      tl.appendChild(block);
    }
  }

  function renderChordFrequency(chords, duration) {
    const fq = document.getElementById("chordFrequency");
    if (!fq) return;
    fq.innerHTML = "";

    const dur = Math.max(0.1, duration || (chords[chords.length - 1]?.start || 0));
    const totals = new Map();

    for (let i = 0; i < chords.length; i++) {
      const start = chords[i].start;
      const end = i < chords.length - 1 ? chords[i + 1].start : dur;
      const d = Math.max(0, end - start);
      const key = chords[i].chord;
      totals.set(key, (totals.get(key) || 0) + d);
    }

    // Sort by total duration desc and limit to top 12
    const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12);

    // Build bars
    fq.style.display = "flex";
    fq.style.alignItems = "flex-end";

    if (sorted.length === 0) {
      fq.innerHTML = "<p class=\"small\">No chord frequency data.</p>";
      return;
    }

    for (const [label, total] of sorted) {
      const item = document.createElement("div");
      item.className = "freq-item";

      const line = document.createElement("div");
      line.className = "freq-line";
      const pctVal = Math.max(0, Math.round((total / dur) * 100));
      line.style.height = `${pctVal}%`;
      line.style.minHeight = pctVal > 0 ? "4px" : "0px";
      line.style.background = chordColor(label);

      const pct = document.createElement("div");
      pct.className = "freq-percentage";
      pct.textContent = `${pctVal}%`;

      const cap = document.createElement("div");
      cap.className = "freq-label";
      cap.textContent = shortChordLabel(label);

      item.appendChild(line);
      item.appendChild(pct);
      item.appendChild(cap);
      fq.appendChild(item);
    }
  }

})();