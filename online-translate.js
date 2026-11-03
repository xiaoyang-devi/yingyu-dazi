// Planning is local. Only translateOnline sends sentence bodies after the UI obtains consent.
import {units} from './local-translate.js?v=8';

const endpoint = 'https://api.mymemory.translated.net/get';
const needsTranslation = text => /\p{Script=Han}/u.test(text);
const encoder = new TextEncoder();
const maxBytes = 500, maxCharacters = 5000, maxLines = 200;
const quotaMessage = '在线翻译今天的免费用量已用完。可稍后再试，或选择本机翻译。';
const invalidResult = () => Error('在线翻译没有返回可朗读的英文。可缩短选区后重试，或选择本机翻译。');
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
          lines.push({speaker:message.speaker,zh:spaces + part,en:needsTranslation(q) ? '' : q});
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
  return {lines,queries:[...unique],characters};
}

export function planOnline(messages) {
  const {queries,characters} = prepare(messages);
  return {count:queries.length,characters,segments:queries};
}

function english(data) {
  if ([true,1,'1','true'].includes(data?.quotaFinished) || Number(data?.responseStatus) === 429) throw Error(quotaMessage);
  const raw = data?.responseData?.translatedText;
  if (Number(data?.responseStatus) !== 200 || typeof raw !== 'string' || raw.length > 8000) throw invalidResult();
  if (/^\s*MYMEMORY WARNING/i.test(raw)) throw Error(quotaMessage);
  // Some translation-memory records contain entity-escaped punctuation. Never parse HTML.
  const named = {amp:'&',apos:"'",quot:'"',lt:'<',gt:'>',nbsp:' '};
  const text = raw.replace(/&(amp|apos|quot|lt|gt|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi, (match,entity) => {
    entity = entity.toLowerCase();
    if (entity[0] !== '#') return named[entity];
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    return code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  }).trim();
  const numeric = /[0-9]/.test(text) && /^[0-9\p{Sc}\s.,+%‰°:()'’/–—−-]+$/u.test(text);
  if ((!/\p{Script=Latin}/u.test(text) && !numeric) || needsTranslation(text) || /<\/?[a-z][^>]*>/i.test(text) ||
      /\bMYMEMORY WARNING\b|^QUERY LENGTH LIMIT EXCEEDED|^INVALID (?:SOURCE|TARGET) LANGUAGE/i.test(text)) throw invalidResult();
  return text;
}

async function request(q,controller) {
  const timer = setTimeout(() => controller.abort(Error('在线翻译响应超时。可稍后重试，或选择本机翻译。')),20000);
  try {
    const response = await fetch(endpoint,{
      method:'POST',body:new URLSearchParams({q,langpair:'zh-CN|en-US'}),
      credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',signal:controller.signal
    });
    if (response.status === 429) throw Error(quotaMessage);
    if (!response.ok) throw Error('在线翻译服务暂时不可用。可稍后重试，或选择本机翻译。');
    let data;
    try { data = await response.json(); } catch { throw invalidResult(); }
    return english(data);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason || cancelled();
    if (error instanceof TypeError) throw Error('未能连接在线翻译服务。可检查网络后重试，或选择本机翻译。');
    throw error;
  } finally { clearTimeout(timer); }
}

export async function translateOnline(messages,onProgress = () => {},{signal} = {}) {
  if (signal?.aborted) throw cancelled();
  const {lines,queries} = prepare(messages);
  if (!queries.length) return lines;
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  signal?.addEventListener('abort',abort,{once:true});
  const translations = new Map();
  let next = 0;
  function progress() {
    const loaded = translations.size, total = queries.length;
    onProgress({stage:'translate',phase:'translate',unit:'lines',loaded,total,
      message:'在线翻译已完成 ' + loaded + ' / ' + total + ' 个不同片段。'});
  }
  async function take() {
    while (!controller.signal.aborted && next < queries.length) {
      const q = queries[next++];
      const result = await request(q,controller);
      if (controller.signal.aborted) throw controller.signal.reason || cancelled();
      translations.set(q,result);
      progress();
    }
  }
  try {
    progress();
    await Promise.all(Array.from({length:Math.min(2,queries.length)},take));
    if (controller.signal.aborted) throw controller.signal.reason || cancelled();
    for (const line of lines) if (!line.en) line.en = translations.get(line.zh.trim());
    return lines;
  } finally {
    controller.abort();
    signal?.removeEventListener('abort',abort);
  }
}
