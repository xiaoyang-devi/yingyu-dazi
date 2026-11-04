// The caller obtains consent before calling this module. Importing it performs no network requests.
export const CLOUD_VOICES = Object.freeze(['af_heart', 'am_michael']);

const api = 'https://api.tts.ai';
const audioOrigins = new Set([api, 'https://cdn.tts.ai']);
const maxPart = 500;
const recentSubmissions = [];
const maxAudioBytes = 12 * 1024 * 1024;
const cancelled = () => new DOMException('已取消在线配音。', 'AbortError');
const invalidAudio = () => Error('在线配音返回的录音不完整，请重试。');

export function splitLine(text) {
  const chars = Array.from(text.trim());
  if (!chars.length) throw Error('这句缺少英文台词。');
  const parts = [];
  for (let start = 0; start < chars.length;) {
    let end = Math.min(start + maxPart, chars.length);
    if (end < chars.length) {
      for (let k = end - 1; k >= start + maxPart / 2; k--) {
        if (/\s/u.test(chars[k])) { end = k + 1; break; }
      }
    }
    const part = chars.slice(start, end).join('').trim();
    if (part) parts.push(part);
    start = end;
  }
  return parts;
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason || cancelled()); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason || cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, {once:true});
  });
}

// The free endpoint allows ten submissions per minute. Count submitted attempts even if cancelled.
async function waitForSubmission(signal, onWait, switchOnRateLimit) {
  for (;;) {
    if (signal.aborted) throw signal.reason || cancelled();
    const now = performance.now();
    while (recentSubmissions.length && now - recentSubmissions[0] >= 60000) recentSubmissions.shift();
    if (recentSubmissions.length < 10) {
      recentSubmissions.push(now);
      onWait(0);
      return;
    }
    const waitMs = Math.ceil(60000 - (now - recentSubmissions[0]));
    if (switchOnRateLimit) throw new VoiceRateLimitError(waitMs);
    onWait(waitMs);
    await pause(waitMs, signal);
  }
}

async function request(url, options, signal) {
  const res = await fetch(url, {...options, signal, credentials:'omit', referrerPolicy:'no-referrer', cache:'no-store', redirect:'error'});
  if (res.status === 429 || res.status === 402) {
    // A throttled poll or download is not a rejected synthesis request.
    if (url === api + '/v1/tts/' && options.method === 'POST' && await confirmsQuota(res)) {
      throw new VoiceQuotaError('TTS.ai 本次免费配音字符不足。');
    }
    if (url === api + '/v1/tts/' && options.method === 'POST' && res.status === 429) {
      const retry = res.headers.get('Retry-After');
      const milliseconds = /^\d+(?:\.\d+)?$/.test(retry || '') ? Number(retry)*1000 : Date.parse(retry) - Date.now();
      throw new VoiceRateLimitError(Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 60000);
    }
    throw Error('TTS.ai 暂时限制请求。请稍后重试，已完成的录音会保留。');
  }
  if (!res.ok) {
    const error = Error('在线配音服务暂时不可用。可稍后重试，或在制作台选择纯本机配音。');
    error.status = res.status;
    throw error;
  }
  return res;
}

class VoiceQuotaError extends Error {}

class VoiceRateLimitError extends Error {
  constructor(waitMs) {
    super('TTS.ai 暂时限制配音请求。已完成的录音会保留。');
    this.retryAt = Date.now() + Math.max(1000,waitMs);
  }
}

async function confirmsQuota(response) {
  // The provider documents 402 insufficient_credits separately from 429 rate_limited.
  // A bare 429, an unreadable response or a Retry-After header alone says nothing about daily characters.
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object') return false;
  const code = String(data.error?.code || data.code || data.error || '').toLowerCase();
  if (code === 'insufficient_credits' || /^(?:daily|anonymous_daily)_(?:character_|usage_)?(?:quota|limit)(?:_exceeded|_reached|_exhausted)?$/.test(code)) return true;
  const detail = [data.error?.message, data.error, data.detail, data.message].filter(v => typeof v === 'string').join(' ').toLowerCase();
  if (response.status === 402 && /insufficient (?:credits|characters)|not enough (?:credits|characters)/.test(detail)) return true;
  if (/per (?:minute|second)|\/(?:min|second)\b|concurrent requests/.test(detail)) return false;
  const daily = /\bdaily\b|\bper day\b|\/day\b|\btoday(?:'s)?\b/.test(detail);
  const exhausted = /\bexceed(?:ed|s)?\b|\b(?:reached|exhausted|insufficient|used up|used all)\b|\bused your (?:5,?000 )?free daily characters\b/.test(detail);
  return daily && exhausted && /\b(?:quota|limit|allowance|characters?|credits?)\b/.test(detail);
}

async function json(res) {
  try { return await res.json(); }
  catch { throw Error('在线配音服务未返回有效的任务信息。'); }
}

export function waveFromParts(header, pcm) {
  const bytes = pcm.reduce((sum, chunk) => sum + chunk.size, 0);
  const v = new DataView(header);
  v.setUint32(4, bytes + 36, true);
  v.setUint32(40, bytes, true);
  return new Blob([header, ...pcm], {type:'audio/wav'});
}

// Keep quiet consonants and breaths. In 5-ms windows, disregard DC offset and the
// near-zero dither that Kokoro leaves in its long pauses. Never trim an interior pause.
function trimQuietEdges(view, blob) {
  const frames = (blob.size - 44) / 2, windowFrames = 120;
  let first = frames, last = 0, audible = false;
  for (let start = 0; start < frames; start += windowFrames) {
    const end = Math.min(frames, start + windowFrames);
    let sum = 0, energy = 0;
    for (let i = start; i < end; i++) {
      const sample = view.getInt16(44 + 2 * i, true);
      sum += sample;
      energy += sample * sample;
    }
    const count = end - start;
    const variance = energy / count - (sum / count) ** 2;
    if (variance > 8 ** 2) {
      first = Math.min(first, start);
      last = end;
      if (variance > 24 ** 2) audible = true;
    }
  }
  if (!audible) throw Error('在线配音返回了一段静音，请重试。');
  const from = Math.max(0, first - 1680), to = Math.min(frames, last + 3120); // 70 / 130 ms at 24 kHz
  if (from === 0 && to === frames) return blob.slice(0, blob.size, 'audio/wav');
  return waveFromParts(view.buffer.slice(0,44), [blob.slice(44 + from * 2, 44 + to * 2)]);
}

// Only accept the canonical PCM format used by the library and downloadable listening cards.
export async function readWave(res) {
  if (Number(res.headers.get('Content-Length')) > maxAudioBytes) throw invalidAudio();
  const blob = await res.blob();
  if (blob.size <= 44 || blob.size > maxAudioBytes || blob.size % 2) throw invalidAudio();
  const v = new DataView(await blob.arrayBuffer());
  if (v.getUint32(0) !== 0x52494646 || v.getUint32(4,true) !== blob.size - 8 ||
      v.getUint32(8) !== 0x57415645 || v.getUint32(12) !== 0x666d7420 ||
      v.getUint32(16,true) !== 16 || v.getUint16(20,true) !== 1 || v.getUint16(22,true) !== 1 ||
      v.getUint32(24,true) !== 24000 || v.getUint32(28,true) !== 48000 ||
      v.getUint16(32,true) !== 2 || v.getUint16(34,true) !== 16 ||
      v.getUint32(36) !== 0x64617461 || v.getUint32(40,true) !== blob.size - 44) throw invalidAudio();
  return trimQuietEdges(v, blob);
}

async function generatePart(text, voice, signal, job, onSubmitted) {
  if (!job.uuid) {
    const created = await json(await request(api + '/v1/tts/', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'kokoro', text, voice, language:'en', format:'wav', speed:1})
    }, signal));
    if (typeof created?.uuid !== 'string' || !/^[a-z\d-]{1,80}$/i.test(created.uuid)) {
      throw Error('在线配音未返回任务编号。');
    }
    job.uuid = created.uuid;
    onSubmitted(Array.from(text).length);
  }
  const poll = api + '/v1/speech/results/?uuid=' + encodeURIComponent(job.uuid);
  for (;;) {
    await pause(1000, signal);
    const result = await json(await request(poll, {}, signal));
    if (result?.status === 'completed') {
      if (typeof result.result_url !== 'string') throw invalidAudio();
      let source;
      try { source = new URL(result.result_url, api); } catch { throw invalidAudio(); }
      if (!audioOrigins.has(source.origin) || source.username || source.password) throw invalidAudio();
      return readWave(await request(source.href, {}, signal));
    }
    if (!['queued','pending','processing','running','started','in_progress'].includes(result?.status)) {
      // A failed remote job needs a new submission on an explicit retry.
      delete job.uuid;
      throw Error('在线配音未能完成这句英文。可稍后重试，或在制作台选择纯本机配音。');
    }
  }
}

export async function synthesizeCloudLine(text, voice, signal, {jobs = [],onSubmitted = () => {},onWait = () => {},switchOnRateLimit = false,beforeSubmit = () => {}} = {}) {
  if (signal?.aborted) throw cancelled();
  if (!CLOUD_VOICES.includes(voice)) throw Error('请选择在线配音提供的音色。');
  if (typeof text !== 'string') throw Error('这句缺少英文台词。');
  if (Array.from(text).length > 5000) throw new VoiceQuotaError('这句英文已超过 TTS.ai 每天 5,000 字符的免费额度。');
  const parts = splitLine(text);
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  signal?.addEventListener('abort', abort, {once:true});
  const clips = [];
  try {
    for (const [i,part] of parts.entries()) {
      if (controller.signal.aborted) throw controller.signal.reason || cancelled();
      const job = jobs[i] || (jobs[i] = {});
      if (job.blob) { clips.push(job.blob); continue; }
      if (!job.uuid) {
        beforeSubmit();
        await waitForSubmission(controller.signal,onWait,switchOnRateLimit);
      }
      if (controller.signal.aborted) throw controller.signal.reason || cancelled();
      const timer = setTimeout(() => controller.abort(Error('在线配音响应超时。请检查网络后重试，或在制作台选择纯本机配音。')), 60000);
      try {
        const blob = await generatePart(part, voice, controller.signal,job,onSubmitted);
        if (controller.signal.aborted) throw controller.signal.reason || cancelled();
        job.blob = blob;
        job.voiceProvider = 'tts.ai';
        clips.push(blob);
      } catch (error) {
        if ([404,410].includes(error.status)) delete job.uuid;
        throw error;
      }
      finally { clearTimeout(timer); }
    }
    if (controller.signal.aborted) throw controller.signal.reason || cancelled();
    return await joinClips(clips,controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason || cancelled();
    if (error instanceof TypeError) throw Error('未能连接在线配音服务，请检查网络或选择纯本机配音。');
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function joinClips(clips,signal) {
  if (clips.length === 1) return clips[0];
  const header = await clips[0].slice(0,44).arrayBuffer();
  if (signal.aborted) throw signal.reason || cancelled();
  return waveFromParts(header,clips.map(clip => clip.slice(44)));
}

function providerFor(jobs) {
  const providers = new Set(jobs.map(job => job.voiceProvider || 'tts.ai'));
  return providers.size > 1 ? 'mixed' : providers.values().next().value;
}

export const cloudClipKey = (voice,text) => JSON.stringify([voice,text]);

// Only call after the user approves this selection. Cache by exact text AND voice
// so retries, repeated sentences and edits reuse matching audio.
export async function renderCloudDialogue(lines,voices,clips,signal,onLine,{allowBackup = false,allowSecondary = false,routeState = {},onReady = () => {}} = {}) {
  if (signal.aborted) throw signal.reason || cancelled();
  const quotaDay = new Date().toISOString().slice(0,10);
  if (routeState.day !== quotaDay) {
    routeState.day = quotaDay;
    routeState.primaryCharacters = 0;
    routeState.primaryExhausted = false;
  }
  const jobs = routeState.primaryJobs || (routeState.primaryJobs = new Map());
  const tasks = new Map(), ready = new Array(lines.length);
  let characters = 0, completed = 0;
  function progress(task,provider,phase,waitMs,reason) {
    const i = task.indices[0];
    onLine(i,lines[i],task.voice,provider,{completed,total:lines.length,phase,waitMs,reason});
  }
  function publish(task,clip) {
    if (signal.aborted) return;
    clips.set(task.key,clip);
    for (const i of task.indices) {
      if (signal.aborted) return;
      ready[i] = {...lines[i],...clip};
      completed++;
      onReady(i,ready[i]);
    }
    if (!signal.aborted) progress(task,clip.voiceProvider,'ready');
  }
  for (const [i,line] of lines.entries()) {
    const voice = voices.get(line.speaker), key = cloudClipKey(voice,line.en);
    if (!CLOUD_VOICES.includes(voice)) throw Error('请选择有效的自然配音音色。');
    if (tasks.has(key)) { tasks.get(key).indices.push(i); continue; }
    const parts = splitLine(line.en), partJobs = jobs.get(key) || [];
    jobs.set(key,partJobs);
    const needed = parts.reduce((sum,part,i) => sum + (partJobs[i]?.uuid || partJobs[i]?.blob ? 0 : Array.from(part).length),0);
    tasks.set(key,{key,voice,text:line.en,parts,indices:[i],jobs:partJobs,needed});
    if (!clips.has(key)) characters += needed;
  }
  if (characters > 5000 && !allowBackup) throw Error('本次待配音的英文超过 5,000 字符，请缩短选区，或允许使用备用配音。');
  const pending = [];
  for (const task of tasks.values()) {
    let clip = clips.get(task.key);
    if (clip instanceof Blob) clip = {blob:clip,voiceProvider:'tts.ai'};
    if (clip) publish(task,clip);
    else pending.push(task);
  }
  let next = 0, reserved = 0, failure = null, budgetBlocked = false;
  let preferSecondary = allowBackup && allowSecondary && routeState.backupCooldownUntil > Date.now();
  let rateLimited = allowBackup && routeState.primaryCooldownUntil > Date.now()
    ? new VoiceRateLimitError(routeState.primaryCooldownUntil - Date.now()) : null;
  async function primaryWorker() {
    while (!signal.aborted && !failure && !budgetBlocked && !preferSecondary && (!allowBackup || !routeState.primaryExhausted && !rateLimited) && next < pending.length) {
      const task = pending[next];
      // A prior attempt can already have accepted Gradio work. Resume that
      // route below, even if the primary service's cooldown has since ended.
      if (task.jobs.some(job => job?.backup || job?.secondary)) { next++; continue; }
      // Reserve both in-flight jobs before submitting either, then charge only
      // accepted jobs. Retries reuse accepted UUIDs and completed audio pieces.
      if (routeState.primaryCharacters + reserved + task.needed > 5000) {
        budgetBlocked = true;
        return;
      }
      next++;
      let reservation = task.needed;
      reserved += reservation;
      progress(task,'tts.ai','synthesize');
      try {
        const blob = await synthesizeCloudLine(task.text,task.voice,signal,{
          jobs:task.jobs,
          switchOnRateLimit:allowBackup,
          beforeSubmit() {
            if (allowBackup && rateLimited) throw rateLimited;
            if (allowBackup && routeState.primaryExhausted) throw new VoiceQuotaError('TTS.ai 本次免费字符不足。');
          },
          onSubmitted(length) {
            routeState.primaryCharacters += length;
            reserved -= length;
            reservation -= length;
          },
          onWait(waitMs) { if (!signal.aborted) progress(task,'tts.ai',waitMs ? 'waiting' : 'synthesize',waitMs); }
        });
        publish(task,{blob,voiceProvider:providerFor(task.jobs)});
      } catch (error) {
        if (error instanceof VoiceQuotaError) {
          routeState.primaryExhausted = true;
          if (!allowBackup) failure ||= error;
        } else if (error instanceof VoiceRateLimitError) {
          routeState.primaryCooldownUntil = Math.max(routeState.primaryCooldownUntil || 0,error.retryAt);
          rateLimited = error;
          if (!allowBackup) failure ||= error;
        } else failure ||= error;
      } finally {
        reserved -= reservation;
      }
    }
  }
  // Free TTS.ai permits two concurrent jobs. Keep the second slot useful while
  // the first is polling, without increasing the ten-submission rolling limit.
  await Promise.all(Array.from({length:Math.min(2,pending.length)},primaryWorker));
  if (signal.aborted) throw signal.reason || cancelled();
  if (failure) throw failure;
  if (budgetBlocked) routeState.primaryExhausted = true;
  for (const task of pending) {
    if (clips.has(task.key)) continue;
    if (!allowBackup) throw new VoiceQuotaError('TTS.ai 本次免费字符不足。可以稍后再试，或允许备用服务继续配音。');
    if (signal.aborted) throw signal.reason || cancelled();
    if (task.parts.some((part,i) => !task.jobs[i]?.blob && !task.jobs[i]?.uuid)) {
      progress(task,'huggingface','switching',Math.max(0,(routeState.primaryCooldownUntil || 0) - Date.now()),
        budgetBlocked ? 'budget' : routeState.primaryExhausted ? 'daily-quota' : 'rate-limit');
    }
    const {synthesizeBackupLine} = await import('./backup-voice.js?v=16');
    if (signal.aborted) throw signal.reason || cancelled();
    const hasAccepted = state => state?.eventId || state?.event_id || state?.resultURL || state?.blob ||
      state?.parts?.some(piece => piece.eventId || piece.event_id || piece.resultURL || piece.blob);
    const isBusy = error => error?.name === 'BackupVoiceBusyError' &&
      ['backup-rate-limit','backup-timeout','backup-unavailable'].includes(error.reason);
    async function fallbackPart(part,job) {
      async function secondary() {
        if (signal.aborted) throw signal.reason || cancelled();
        if (!allowSecondary) throw Error('另一备用配音服务尚未获得本次授权，请先勾选同意。');
        const {synthesizeSecondaryLine} = await import('./secondary-voice.js?v=16');
        if (signal.aborted) throw signal.reason || cancelled();
        progress(task,'huggingface-secondary','synthesize');
        const blob = await synthesizeSecondaryLine(part,task.voice,signal,{
          job:job.secondary || (job.secondary = {}),maxWaitMs:90000
        });
        if (signal.aborted) throw signal.reason || cancelled();
        return {blob,voiceProvider:'huggingface-secondary'};
      }
      // Once another provider accepted a part, retry that same task instead of
      // submitting a new duplicate while the original Space is still busy.
      if (hasAccepted(job.secondary)) return secondary();
      if (!preferSecondary || hasAccepted(job.backup)) {
        progress(task,'huggingface','synthesize');
        try {
          const blob = await synthesizeBackupLine(part,task.voice,signal,{
            job:job.backup || (job.backup = {}),
            // On a retry during cooldown, briefly retrieve an already accepted
            // result. This never posts a new job; known audio gets normal time.
            maxWaitMs:preferSecondary && !job.backup.parts?.every(piece => piece.blob || piece.resultURL)
              ? 1000 : allowSecondary ? 30000 : 90000
          });
          if (signal.aborted) throw signal.reason || cancelled();
          return {blob,voiceProvider:'huggingface'};
        } catch (error) {
          if (signal.aborted) throw signal.reason || cancelled();
          if (!isBusy(error) || !allowSecondary) throw error;
          routeState.backupCooldownUntil = Math.max(routeState.backupCooldownUntil || 0,error.retryAt || Date.now()+60000);
          routeState.backupBusyReason = error.reason;
          preferSecondary = true;
        }
      }
      progress(task,'huggingface-secondary','switching',Math.max(0,(routeState.backupCooldownUntil || 0)-Date.now()),
        routeState.backupBusyReason || 'backup-unavailable');
      return secondary();
    }
    const parts = [];
    for (const [i,part] of task.parts.entries()) {
      if (signal.aborted) throw signal.reason || cancelled();
      const job = task.jobs[i] || (task.jobs[i] = {});
      if (!job.blob) {
        if (job.uuid) {
          // An accepted primary task may still be retrievable. Never submit its
          // text to a second provider just because a later submission was limited.
          progress(task,'tts.ai','synthesize');
          job.blob = await synthesizeCloudLine(part,task.voice,signal,{jobs:[job]});
          job.voiceProvider = 'tts.ai';
        } else {
          const clip = await fallbackPart(part,job);
          if (signal.aborted) throw signal.reason || cancelled();
          Object.assign(job,clip);
        }
      }
      parts.push(job.blob);
    }
    const blob = await joinClips(parts,signal);
    publish(task,{blob,voiceProvider:providerFor(task.jobs)});
  }
  if (signal.aborted) throw signal.reason || cancelled();
  return ready;
}
