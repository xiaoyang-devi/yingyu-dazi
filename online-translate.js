// Planning is local. Only translateOnline sends sentence bodies after the UI obtains consent.
import {units} from './local-translate.js?v=8';

const endpoint = 'https://api.mymemory.translated.net/get';
const needsTranslation = text => /\p{Script=Han}/u.test(text);
const encoder = new TextEncoder();
const maxBytes = 500, maxCharacters = 5000, maxLines = 200;
const quotaMessage = '在线翻译达到免费用量或请求频率限制。可稍后再试，或选择本机翻译。';
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
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
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
            if (characters > maxCharacters) throw Error('所选中文片段超过在线快读单次 5,000 字符的上限，请缩短选区。');
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
  if ([true,1,'1','true'].includes(data?.quotaFinished) || status === 429 || /^MYMEMORY WARNING/i.test(primary)) throw Error(quotaMessage);
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

async function request(q,controller) {
  const timer = setTimeout(() => controller.abort(Error('在线翻译响应超时。可稍后重试，或选择本机翻译。')),20000);
  try {
    const response = await fetch(endpoint,{
      method:'POST',body:new URLSearchParams({q,langpair:'zh-CN|en-US'}),
      credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',signal:controller.signal
    });
    if (response.status === 429) throw Error(quotaMessage);
    if ([400,413,422].includes(response.status)) return '';
    if (!response.ok) throw Error('在线翻译服务暂时不可用。可稍后重试，或选择本机翻译。');
    let data;
    try { data = await response.json(); } catch { throw Error('在线翻译服务返回的数据暂时无法读取。请稍后重试。'); }
    return english(data,q);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason || cancelled();
    if (error instanceof TypeError) throw Error('未能连接在线翻译服务。可检查网络后重试，或选择本机翻译。');
    throw error;
  } finally { clearTimeout(timer); }
}

export async function translateOnline(messages,onProgress = () => {},{signal,cache = new Map()} = {}) {
  if (signal?.aborted) throw cancelled();
  const {lines,queries} = prepare(messages);
  const pending = queries.filter(q => !isReadableEnglish(cache.get(q)));
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  signal?.addEventListener('abort',abort,{once:true});
  const invalid = new Set();
  let next = 0, processed = queries.length - pending.length, stopReason = '';
  function progress() {
    const total = queries.length;
    onProgress({stage:'translate',phase:'translate',unit:'lines',loaded:processed,total,
      message:'已处理 ' + processed + ' / ' + total + ' 个不同片段。' + (invalid.size ? '其中 ' + invalid.size + ' 段需核对英文。' : '')});
  }
  async function take() {
    while (!controller.signal.aborted && next < pending.length) {
      const q = pending[next++];
      let result;
      try { result = await request(q,controller); }
      catch (error) {
        if (signal?.aborted) throw cancelled();
        if (!stopReason) {
          stopReason = error.message || '在线翻译暂时不可用。';
          controller.abort();
        }
        return;
      }
      if (controller.signal.aborted) return;
      if (result) cache.set(q,result);
      else invalid.add(q);
      processed++;
      progress();
    }
  }
  try {
    if (queries.length) progress();
    await Promise.all(Array.from({length:Math.min(2,pending.length)},take));
    if (signal?.aborted) throw cancelled();
    for (const line of lines) {
      if (line.en) continue;
      const q = line.zh.trim(), en = cache.get(q);
      if (isReadableEnglish(en)) line.en = en;
      else if (!needsTranslation(q)) line.failureReason = '原文只有符号或表情，可补写想听的英文。';
      else line.failureReason = invalid.has(q) ? invalidResult : stopReason || invalidResult;
    }
    return lines;
  } finally {
    controller.abort();
    signal?.removeEventListener('abort',abort);
  }
}
