// Planning is local. Only translateOnline sends sentence bodies after the UI obtains consent.
import {units} from './local-translate.js?v=8';
import {translateBackupSegment} from './backup-translate.js?v=13';

const endpoint = 'https://api.mymemory.translated.net/get';
const needsTranslation = text => /\p{Script=Han}/u.test(text);
const encoder = new TextEncoder();
const maxBytes = 500, maxCharacters = 6000, maxLines = 200;
const quotaMessage = 'MyMemory 的免费翻译用量已耗尽。可启用备用翻译后重试，或稍后再试。';
const rateMessage = 'MyMemory 暂时限制了请求频率，请稍后重试。';
const invalidResult = '服务未返回可确认的英文译文。';
const cancelled = () => new DOMException('已取消在线翻译。','AbortError');

function byteParts(text) {
  if (!needsTranslation(text) || encoder.encode(text.trim()).length <= maxBytes) return [text];
  const parts = [];
  let part = '', length = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (length + size > maxBytes) {parts.push(part); part = ''; length = 0;}
    part += char;
    length += size;
  }
  if (part) parts.push(part);
  return parts;
}

function directEnglish(text) {
  if (needsTranslation(text)) return '';
  if (/^[?？\s]+$/u.test(text)) return 'Huh?';
  return isReadableEnglish(text) ? text : '';
}

function prepare(messages) {
  if (!Array.isArray(messages) || !messages.length) throw Error('请先导入聊天文字。');
  const lines = [], unique = new Set();
  let characters = 0;
  for (const message of messages) {
    if (typeof message?.speaker !== 'string' || !message.speaker.trim() || typeof message.text !== 'string' || !message.text.trim()) {
      throw Error('消息需要有效的发言人和正文。');
    }
    const first = lines.length;
    let spaces = '';
    for (const unit of units(message.text)) {
      // MyMemory accepts one paragraph per lookup. Preserve separators in the displayed source.
      const paragraphs = unit.match(/[^\r\n\u2028\u2029]+(?:\r\n|[\r\n\u2028\u2029])?|\r\n|[\r\n\u2028\u2029]/gu) || [];
      for (const paragraph of paragraphs) {
        for (const part of byteParts(paragraph)) {
          const q = part.trim();
          if (!q) {
            if (lines.length > first) lines.at(-1).zh += part;
            else spaces += part;
            continue;
          }
          lines.push({speaker:message.speaker,zh:spaces + part,en:directEnglish(q)});
          spaces = '';
          if (lines.length > maxLines) throw Error('每次最多生成 200 句，请缩短选区。');
          if (needsTranslation(q) && !unique.has(q)) {
            unique.add(q);
            characters += Array.from(q).length;
            if (characters > maxCharacters) throw Error('所选中文片段超过在线快读单次 6,000 字符的上限，请缩短选区。');
          }
        }
      }
    }
  }
  return {lines,queries:[...unique]};
}

// The cache belongs to the current selection. Only the caller decides when to discard it.
export function planOnline(messages,{cache} = {}) {
  const {queries} = prepare(messages);
  const segments = queries.filter(q => !isReadableEnglish(cache?.get(q)));
  return {count:segments.length,characters:segments.reduce((n,q) => n + Array.from(q).length,0),segments};
}

function decodeText(raw) {
  if (typeof raw !== 'string' || raw.length > 8000) return '';
  // Some translation-memory records contain entity-escaped punctuation. Never parse HTML.
  const named = {amp:'&',apos:"'",quot:'"',lt:'<',gt:'>',nbsp:' '};
  return raw.replace(/&(amp|apos|quot|lt|gt|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi, (match,entity) => {
    entity = entity.toLowerCase();
    if (entity[0] !== '#') return named[entity];
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    return code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  }).trim();
}

export function isReadableEnglish(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) return false;
  const letters = text.match(/\p{L}/gu) || [];
  const numeric = /[0-9]/.test(text) && /^[0-9\p{Sc}\s.,+%‰°:()'’/–—−-]+$/u.test(text);
  return (numeric || letters.length > 0 && letters.every(ch => /\p{Script=Latin}/u.test(ch))) &&
    !/<\/?[a-z][^>]*>|&(?:lt|gt);|\bMYMEMORY WARNING\b|^QUERY LENGTH LIMIT EXCEEDED|^INVALID (?:SOURCE|TARGET) LANGUAGE/i.test(text) &&
    !/^\s*\[\s*\]\s*\/\s*\([a-z]{1,8}\)\s*\/?\s*$/i.test(text);
}

function english(data,source) {
  const status = Number(data?.responseStatus), primary = decodeText(data?.responseData?.translatedText);
  if ([400,413,422].includes(status)) return '';
  if (status !== 200) throw Error('在线翻译服务暂时无法返回英文。请稍后重试。');
  const matches = Array.isArray(data.matches) ? data.matches : [];
  // A close match to a different source can have a high score even for one-character replies.
  const exact = matches.filter(m => typeof m?.segment === 'string' &&
    m.segment.trim().normalize('NFC') === source.normalize('NFC') &&
    /^zh(?:[-_]|$)/i.test(m.source) && /^en(?:[-_]|$)/i.test(m.target));
  const candidates = exact.map(m => decodeText(m.translation));
  if (isReadableEnglish(primary) && (candidates.includes(primary) ||
      !matches.some(m => decodeText(m?.translation) === primary))) return primary;
  return candidates.find(isReadableEnglish) || '';
}

// A bare 429 is also used for short rate limits. Only a provider quota flag or a
// specific daily-allowance warning authorizes routing a body to another service.
class DailyQuotaError extends Error {
  constructor(warning) {
    super(quotaMessage);
    const match = /NEXT AVAILABLE IN\s+(\d{1,2}) HOURS?\s+(\d{1,2}) MINUTES?\s+(\d{1,2}) SECONDS?/i.exec(warning);
    const seconds = match && (+match[1] * 3600 + +match[2] * 60 + +match[3]);
    // When no reset time is supplied, recheck on a later retry.
    this.until = Date.now() + (seconds > 0 && seconds <= 86400 ? seconds : 300) * 1000;
  }
}

async function request(q,signal) {
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  if (signal.aborted) throw cancelled();
  signal.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(() => controller.abort(Error('在线翻译响应超时。可稍后重试，或选择本机翻译。')),20000);
  try {
    const response = await fetch(endpoint,{
      method:'POST',body:new URLSearchParams({q,langpair:'zh-CN|en-US'}),
      credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',signal:controller.signal
    });
    if ([400,413,422].includes(response.status)) return '';
    if (!response.ok && response.status !== 429) throw Error('在线翻译服务暂时不可用。可稍后重试，或选择本机翻译。');
    let data;
    try { data = await response.json(); }
    catch { throw Error(response.status === 429 ? rateMessage : '在线翻译服务返回的数据暂时无法读取。请稍后重试。'); }
    const limited = response.status === 429 || Number(data?.responseStatus) === 429;
    const warning = /^MYMEMORY WARNING:\s*YOU USED ALL AVAILABLE FREE TRANSLATIONS(?: FOR TODAY)?(?:[.\s]|$)/i;
    const details = decodeText(data?.responseDetails), translated = decodeText(data?.responseData?.translatedText);
    if ([true,1,'1','true'].includes(data?.quotaFinished) || warning.test(details) || limited && warning.test(translated)) {
      throw new DailyQuotaError(warning.test(details) ? details : translated);
    }
    if (limited) throw Error(rateMessage);
    return english(data,q);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason || cancelled();
    if (error instanceof TypeError) throw Error('未能连接在线翻译服务。可检查网络后重试，或选择本机翻译。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort',abort);
  }
}

// routeState belongs to a single selection. Reusing it requires fresh backup consent.
export async function translateOnline(messages,onProgress = () => {},{signal,cache = new Map(),allowBackup = false,routeState = {}} = {}) {
  if (signal?.aborted) throw cancelled();
  const {lines,queries} = prepare(messages);
  const pending = queries.filter(q => !isReadableEnglish(cache.get(q)));
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  signal?.addEventListener('abort',abort,{once:true});
  const failures = new Map();
  let next = 0, processed = queries.length - pending.length, stopReason = '';
  let exhausted = allowBackup && routeState.primaryQuotaUntil > Date.now();
  if (!exhausted && pending.length) delete routeState.primaryQuotaUntil;
  function progress(provider) {
    onProgress({stage:'translate',phase:'translate',provider,unit:'lines',loaded:processed,total:queries.length,
      message:'已处理 ' + processed + ' / ' + queries.length + ' 个不同片段。' + (failures.size ? '其中 ' + failures.size + ' 段需核对或重试。' : '')});
  }
  function record(q,result,provider) {
    if (isReadableEnglish(result)) cache.set(q,result);
    else failures.set(q,invalidResult);
    processed++;
    progress(provider);
  }
  async function take() {
    while (!controller.signal.aborted && !exhausted && !stopReason && next < pending.length) {
      const q = pending[next++];
      try {
        const result = await request(q,controller.signal);
        if (!controller.signal.aborted) record(q,result,'primary');
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof DailyQuotaError) {
          exhausted = true;
          routeState.primaryQuotaUntil = error.until;
        } else {
          stopReason = error.message || '在线翻译暂时不可用。';
          failures.set(q,stopReason);
          processed++;
          progress('primary');
        }
      }
    }
  }
  try {
    if (queries.length) progress(exhausted ? 'backup' : 'primary');
    // Finish both outstanding lookups before forming the backup queue. A slow
    // success (or an invalid translation) must never be submitted a second time.
    await Promise.all(Array.from({length:Math.min(2,pending.length)},take));
    if (allowBackup && exhausted && !controller.signal.aborted) {
      const remaining = pending.filter(q => !isReadableEnglish(cache.get(q)) && !failures.has(q));
      if (remaining.length) progress('backup');
      for (const q of remaining) {
        if (controller.signal.aborted) break;
        try {
          const result = await translateBackupSegment(q,controller.signal);
          if (!controller.signal.aborted) record(q,result,'backup');
        } catch (error) {
          stopReason = error.message || '备用翻译暂时不可用，请稍后重试。';
          break;
        }
      }
    } else if (exhausted) {
      stopReason = quotaMessage;
    }
    if (controller.signal.aborted) throw cancelled();
    for (const line of lines) {
      if (line.en) continue;
      const q = line.zh.trim(), en = cache.get(q);
      if (isReadableEnglish(en)) line.en = en;
      else if (!needsTranslation(q)) line.failureReason = '未识别出可朗读的英文，可手动填写这句台词。';
      else line.failureReason = failures.get(q) || stopReason || invalidResult;
    }
    return lines;
  } finally {
    controller.abort();
    signal?.removeEventListener('abort',abort);
  }
}
