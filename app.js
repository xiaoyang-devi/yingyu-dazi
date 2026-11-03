import {parseText} from './intake.js?v=4';
import {translateLocally, cancelLocalTranslation} from './local-translate.js?v=8';
import {LOCAL_VOICES, renderLocalVoice, releaseLocalVoice} from './local-voice.js?v=7';
import {planOnline, translateOnline, isReadableEnglish} from './online-translate.js?v=10.1';
import {cloudPanel} from './cloud-panel.js?v=10';
import {localEnglishVoices, createLocalReader} from './native-speech.js';

import {savePracticeCard, updatePracticePosition} from './library.js?v=9';
import {practiceShelf} from './library-view.js?v=9';

const id = key => document.getElementById(key);
const source = id('source'), audio = id('audio');
const siteBase = new URL('./', import.meta.url);
const voiceLabels = {
  af_heart:'Heart · 美式女声', am_michael:'Michael · 美式男声',
  bf_emma:'Emma · 英式女声', af_bella:'Bella · 美式女声', am_fenrir:'Fenrir · 美式男声',
  bm_george:'George · 英式男声', bf_isabella:'Isabella · 英式女声'
};
const speakerNames = messages => [...new Set(messages.map(m => m.speaker))];
const pad = n => String(n).padStart(2,'0');
const han = /\p{Script=Han}/u;
const reader = createLocalReader();
const onlineMode = () => id('engine').value === 'online';
const nativeMode = () => id('engine').value !== 'kokoro';
const castChoices = {kokoro:new Map(),native:new Map()};
const choices = () => nativeMode() ? castChoices.native : castChoices.kokoro;
const kokoroNote = id('downloadNote').textContent;
let systemVoices = [], cachedTranslation = null;
let onlinePlan = null, onlineIssue = '', onlineRequest = null, consentSignature = '';
let onlineCache = new Map(), reviewLines = null;
function clearReview() {
  reviewLines = null;
  id('translationReview').hidden = true;
  id('reviewRows').replaceChildren();
}
function resetOnlineSelection() {
  clearReview();
  onlineCache = new Map();
  revokeConsent();
}
function revokeConsent() {
  id('onlineConsent').checked = false;
  consentSignature = '';
}
function previewOnline() {
  const list = id('sendLines');
  list.replaceChildren();
  if (!id('sendPreview').open || !onlinePlan) return;
  for (const line of onlinePlan.segments) {
    const item = document.createElement('li');
    item.textContent = line;
    list.append(item);
  }
}
function updateOnlinePlan() {
  onlinePlan = null;
  onlineIssue = '';
  if (onlineMode() && parsed) {
    try {onlinePlan = planOnline(parsed.messages,{cache:onlineCache});} catch (error) {onlineIssue = error.message;}
  }
  const needed = Boolean(onlinePlan?.count);
  id('onlineTerms').hidden = !needed;
  if (!needed || (consentSignature && consentSignature !== JSON.stringify(onlinePlan.segments))) revokeConsent();
  if (needed) id('onlineScope').textContent = '本次将发送 ' + onlinePlan.count + ' 段中文或中英混合正文，共 ' + onlinePlan.characters + ' 字符';
  if (onlineMode()) id('quickIntro').textContent = onlineIssue || (onlinePlan && !needed
    ? '纯英文可直接制卡。卡片里可选系统朗读，或选 Heart 女声和 Michael 男声在线配音。'
    : '首次也无需下载模型。MyMemory 翻译后，可听系统朗读，或选 Heart 女声和 Michael 男声在线配音。');
  if (onlineMode() && reviewLines && !needed && reviewedLines().some(line => !line.en)) id('quickIntro').textContent = '剩余符号可以直接在本页补写英文。';
  else if (onlineMode() && onlineCache.size && onlinePlan) id('quickIntro').textContent = needed
    ? '已完成的译文保留在本页，本次只发送还需要翻译的原句。'
    : '本次所需译文已齐全，可以直接制卡。';
  if (onlineMode()) id('generate').textContent = reviewLines && needed ? '只重试待译的 ' + onlinePlan.count + ' 段' : '▷ 生成在线快读卡';
  previewOnline();
}
id('sendPreview').ontoggle = previewOnline;
id('onlineConsent').onchange = () => {
  consentSignature = id('onlineConsent').checked && onlinePlan ? JSON.stringify(onlinePlan.segments) : '';
};
let parsed = null, parseIssue = '', castNames = [], jobVersion = 0, working = false;
let card = null, active = 0, playbackVersion = 0, openingAudio = false, endedAll = false;
let cardVersion = 0, demoVersion = 0, saving = false;

function note(node, message, error = false) {
  node.textContent = message;
  node.dataset.kind = error ? 'error' : 'info';
}
// A missing worker event is ambiguous on a phone: the engine might still be
// compiling or the page may have been suspended. Warn without killing work.
let waitTimer, jobKind = '', wakeLock, wakeRequest = 0;
let progressFileGroup = '';
function foregroundMessage(returned = false) {
  const message = document.hidden ? '页面已进入后台。iPhone 可能暂停下载，回到本页后再继续。'
    : returned ? '已回到前台。等待浏览器恢复下载，已保存的完整分块可在重试时复用。'
    : 'iPhone 切到后台或锁屏时，下载可能暂停。请尽量保持本页在前台。';
  id('foregroundNote').textContent = message + (wakeLock && !wakeLock.released ? ' 已请求保持亮屏。' : '');
}
async function syncWakeLock() {
  const ticket = ++wakeRequest;
  if (!working || onlineMode() || !id('stayAwake').checked || document.hidden || !navigator.wakeLock) {
    const old = wakeLock;
    wakeLock = null;
    if (old) await old.release().catch(() => {});
    return;
  }
  if (wakeLock && !wakeLock.released) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (ticket !== wakeRequest) {await lock.release();return;}
    wakeLock = lock;
    foregroundMessage();
    lock.addEventListener('release',() => {if (wakeLock === lock) {wakeLock = null;foregroundMessage();}});
  } catch { if (working && !document.hidden) id('foregroundNote').textContent += ' 浏览器暂未允许保持亮屏。'; }
}
id('stayAwake').disabled = !navigator.wakeLock;
if (!navigator.wakeLock) id('stayAwake').parentElement.append('（当前浏览器不支持）');
id('stayAwake').onchange = () => {foregroundMessage();syncWakeLock();};
document.addEventListener('visibilitychange',() => {
  if (working) foregroundMessage(!document.hidden);
  syncWakeLock();
});
function clearWaitHint() {
  clearTimeout(waitTimer);
  id('jobWait').hidden = true;
}
function watchVisibleWork() {
  clearWaitHint();
  const panel = id('jobProgress');
  if (!working || onlineMode() || document.hidden || panel.hidden || panel.dataset.stage === 'complete') return;
  waitTimer = setTimeout(() => {
    if (!working || document.hidden || panel.hidden) return;
    const hint = navigator.onLine === false && ['translation-model','voice-model'].includes(panel.dataset.stage)
      ? '设备显示离线。首次使用需联网下载模型。恢复网络后可重试。'
      : '这一步暂时没有新进度，网页仍在等待。可在本页稍等。若一直不动，点「重新尝试」可从已保存的分块继续。';
    id('waitHint').textContent = hint;
    id('jobWait').hidden = false;
  }, 45000);
}
document.addEventListener('visibilitychange',watchVisibleWork);
// Percentages are local to the current measured operation, never a time estimate.
function resetJobProgress() {
  clearWaitHint();
  const panel = id('jobProgress');
  panel.hidden = true;
  id('checkpointNote').hidden = true;
  progressFileGroup = '';
  delete panel.dataset.stage;
  delete panel.dataset.phase;
  delete panel.dataset.indeterminate;
  id('jobBar').removeAttribute('value');
  id('jobBar').removeAttribute('aria-valuetext');
  id('jobMetric').textContent = id('jobDetail').textContent = '';
  note(id('progress'),'');
}
function megabytes(bytes) {
  if (bytes > 0 && bytes < 10000) return '不到 0.01 MB';
  return (bytes / 1000000).toLocaleString('zh-CN',{maximumFractionDigits:bytes < 1000000 ? 2 : 1}) + ' MB';
}
function showJob(stage,phase,title,message,measure = {}) {
  const panel = id('jobProgress'), bar = id('jobBar');
  const first = panel.hidden, change = first || panel.dataset.stage !== stage || panel.dataset.phase !== phase;
  panel.hidden = false;
  panel.dataset.stage = stage;
  panel.dataset.phase = phase;
  watchVisibleWork();
  id('jobLabel').textContent = stage.endsWith('-model') ? '模型准备 · 本阶段进度' : jobKind === 'pack' ? '提前准备' : '听力卡制作进度';
  id('foregroundNote').hidden = stage === 'complete' || onlineMode();
  id('switchOnline').hidden = stage === 'complete' || onlineMode();
  if (stage === 'complete') id('checkpointNote').hidden = true;
  id('jobStage').textContent = title;
  const {loaded,total,unit} = measure;
  const hasLoaded = Number.isFinite(loaded) && loaded >= 0;
  const measured = hasLoaded && Number.isFinite(total) && total > 0 && loaded <= total;
  const bytes = unit === 'bytes', counted = unit === 'lines';
  const fraction = measured && (bytes || counted || unit === 'complete') ? Math.floor(100*loaded/total) : null;
  let metric = '', detail = message || '正在设备上处理…';
  if (bytes && hasLoaded) {
    let size = '模型文件已准备 ' + megabytes(loaded) + (measured ? ' / ' + megabytes(total) : '');
    if (Number.isFinite(measure.cachedBytes) && measure.cachedBytes > 0 && measure.cachedBytes < loaded) {
      size += '，其中缓存 ' + megabytes(measure.cachedBytes);
    }
    detail = size + '。' + detail;
    if (fraction === null) metric = megabytes(loaded);
  }
  if (counted && measured) metric = loaded + ' / ' + total;
  else if (fraction !== null) metric = fraction + '%';
  id('jobMetric').textContent = metric;
  id('jobDetail').textContent = detail;
  panel.dataset.indeterminate = String(fraction === null);
  if (fraction === null) bar.removeAttribute('value'); else bar.value = fraction;
  bar.setAttribute('aria-valuetext',metric ? metric + '。' + detail : detail);
  // Use the live region for stage changes only, so screen readers do not announce every network chunk.
  if (change) note(id('progress'),title);
  if (first) {
    const bounds = panel.getBoundingClientRect();
    if (bounds.bottom > (window.visualViewport?.height || innerHeight)-8 || bounds.top < 0) {
      panel.scrollIntoView({block:'nearest',behavior:'auto'});
    }
  }
}
function showModel(stage,info) {
  if (progressFileGroup !== stage) {
    progressFileGroup = stage;
    id('checkpointNote').hidden = true;
  }
  if (info.checkpointBytes || info.resumedBytes || info.checkpointUnavailable) {
    const parts = [];
    if (info.resumedBytes) parts.push('从上次断点读取 ' + megabytes(info.resumedBytes));
    if (info.checkpointBytes) parts.push('已在本机保存 ' + megabytes(info.checkpointBytes) + ' 完整分块');
    if (info.checkpointUnavailable) parts.push('部分文件暂时无法保存断点，请保持本页打开');
    id('checkpointNote').textContent = parts.join(' · ');
    id('checkpointNote').hidden = false;
  }
  const model = stage === 'voice-model' ? '配音模型' : '翻译模型';
  const phase = info.cached ? 'cache' : info.phase || 'prepare';
  const verb = phase === 'cache' ? '读取缓存中的' : phase === 'download' ? '下载或读取' : phase === 'connect' ? '正在连接本站 · ' : phase === 'retry' ? '正在重连 · ' : '准备';
  // Some older workers only return message strings. They cannot supply a measurable total.
  const message = String(info.message || '正在本机准备模型文件。').replace(/\s*[·•]?\s*\d+(?:\.\d+)?\s*%/g,'').trim();
  showJob(stage,phase,verb + model,message,info);
}
function showTranslation(info) {
  const data = typeof info === 'string' ? {message:info} : info;
  if (data.stage === 'translate') showJob('translate',data.phase || 'translate','逐句翻译',data.message,data);
  else showModel('translation-model',data);
}
function showSpeech(index,total,line,message) {
  const context = '第 ' + (index+1) + ' 句 · ' + line.speaker;
  showJob('synthesize','synthesize','逐句配音',message ? context + '。' + message : context + ' 正在设备上合成。',
    {unit:'lines',loaded:index,total});
}
function finishJob(summary) {
  showJob('complete','complete','制作完成',summary,{unit:'complete',loaded:1,total:1});
  note(id('progress'),summary);
}
function buildRoles(names, force = false) {
  const people = corpus?.people || names;
  const selected = choices();
  const options = nativeMode() ? systemVoices.map(v => [v.key,v.name + ' · ' + v.lang])
    : LOCAL_VOICES.map(value => [value,voiceLabels[value] || value]);
  const available = options.map(([value]) => value);
  const present = new Set(people);
  for (const [name,voice] of selected) if (!present.has(name) || !available.includes(voice)) selected.delete(name);
  const reserved = new Set(selected.values());
  const families = new Map(systemVoices.map(v => [v.key,v.family]));
  const familyOf = voice => families.get(voice) || voice;
  const usedFamilies = new Set([...reserved].map(familyOf));
  // Assign from the entire source so changing batches never changes someone's voice.
  for (const [i,name] of people.entries()) {
    if (selected.has(name) || !available.length) continue;
    const voice = available.find(v => !usedFamilies.has(familyOf(v))) || available.find(v => !reserved.has(v)) || available[i % available.length];
    selected.set(name,voice);
    reserved.add(voice);
    usedFamilies.add(familyOf(voice));
  }
  if (!force && names.length === castNames.length && names.every((name,i) => name === castNames[i])) return;
  castNames = names;
  const rows = names.map(name => {
    const voice = selected.get(name);
    const row = document.createElement('label'), label = document.createElement('span'), select = document.createElement('select');
    row.className = 'cast-row';
    label.textContent = name;
    select.setAttribute('aria-label', name + ' 的声音');
    for (const [value,caption] of options) select.add(new Option(caption,value));
    if (voice) select.value = voice;
    else select.add(new Option('未找到本地英语声音',''));
    select.disabled = working || !voice;
    select.onchange = () => selected.set(name, select.value);
    row.append(label,select);
    return row;
  });
  id('cast').replaceChildren(...rows);
}
function refreshVoices(force = false) {
  if (nativeMode()) {
    const next = localEnglishVoices();
    const changed = next.length !== systemVoices.length || next.some((v,i) => v.key !== systemVoices[i]?.key);
    systemVoices = next;
    const count = next.length;
    id('nativeSupport').textContent = count > 1 ? '这台设备有 ' + count + ' 种可用的本地英语声音，可在「角色与声音」中调整。'
      : count === 1 ? '只检测到 1 种本地英语声音，所有角色将共用。'
      : onlineMode() ? '这台设备暂未提供本地英语声音。生成译文后，可直接选在线自然配音。' : '浏览器暂未提供本地英语声音。可先在设备的语音设置中安装英语声音，再回到此页，或选用 Kokoro。';
    force ||= changed;
  }
  if (force) buildRoles(parsed ? speakerNames(parsed.messages) : [],true);
}
function changeEngine() {
  cloud.cancel();
  reader.stop();
  paintTransport();
  const native = nativeMode(), online = onlineMode();
  resetOnlineSelection();
  id('packPanel').hidden = online;
  id('quickIntro').hidden = !online;
  id('nativeSupport').hidden = !native;
  id('downloadTitle').textContent = native ? '系统声音实时朗读 · 无需下载 Kokoro' : '首次生成约需下载 250 MB';
  id('downloadNote').textContent = native
    ? '仅使用设备已有的本地英语声音。纯英文可直接练习；中文首次仍需下载约 130 MB 的翻译模型。轻量模式不保存音频。'
    : kokoroNote;
  id('generate').textContent = online ? '▷ 生成在线快读卡' : native ? '▷ 生成本机朗读卡' : '▷ 生成英语听力卡';
  resetJobProgress();
  id('packStatus').textContent = '';
  delete id('packStatus').dataset.ready;
  refreshVoices(true);
  scan();
}
id('engine').onchange = changeEngine;
globalThis.speechSynthesis?.addEventListener?.('voiceschanged', () => refreshVoices());
window.addEventListener('pageshow', () => refreshVoices());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshVoices();
  else if (reader.state !== 'idle') { reader.stop(); paintTransport(); }
});
const maxMessages = 60, maxCharacters = 6000;
let scannedText, corpus, corpusError = '', prefix = [], importTicket = 0, readingFile = false;
function suggestedEdge(anchor, direction) {
  let edge = anchor;
  while (Math.abs(edge-anchor)+1 < maxMessages) {
    const next = edge + direction;
    if (next < 1 || next > corpus.messages.length) break;
    if (prefix[Math.max(anchor,next)] - prefix[Math.min(anchor,next)-1] > maxCharacters) break;
    edge = next;
  }
  return edge;
}
function setRange(first,last) {
  id('rangeFrom').value = first;
  id('rangeTo').value = last;
}
function resetSource(raw, known) {
  resetOnlineSelection();
  scannedText = raw;
  corpus = null;
  corpusError = '';
  prefix = [0];
  if (raw.trim()) {
    try { corpus = known || parseText(raw); } catch (e) { corpusError = e.message; }
  }
  const total = corpus?.messages.length || 0;
  if (corpus) {
    for (const message of corpus.messages) prefix.push(prefix.at(-1) + [...message.text].length);
    id('rangeFrom').max = id('rangeTo').max = total;
    setRange(1,suggestedEdge(1,1));
  }
  const oversized = total > maxMessages || prefix.at(-1) > maxCharacters;
  id('range').hidden = total < 2 && !oversized;
  id('range').open = oversized;
  if (corpus) corpus.people = speakerNames(corpus.messages);
  id('materials').textContent = corpus
    ? corpus.people.length + ' 位发言人 · ' + total + ' 条文字' + (corpus.skipped ? ' · 已跳过 ' + corpus.skipped + ' 条' : '')
    : raw.trim() ? '请核对昵称、日期时间与正文的排版' : '支持中文、英文和中英混合聊天';
}
function excerpt(message) {
  const start = message.text.slice(0,72).replace(/\s+/gu,' ');
  return message.speaker + '「' + Array.from(start).slice(0,24).join('') + (start.length > 24 ? '…' : '') + '」';
}
function scan() {
  if (source.value !== scannedText) resetSource(source.value);
  parsed = null;
  parseIssue = corpusError;
  let amount = 0;
  if (corpus) {
    const first = Number(id('rangeFrom').value), last = Number(id('rangeTo').value), total = corpus.messages.length;
    const valid = Number.isInteger(first) && Number.isInteger(last) && first >= 1 && first <= last && last <= total;
    const count = last-first+1;
    id('prevRange').disabled = working || !valid || first === 1;
    id('nextRange').disabled = working || !valid || last === total;
    id('rangeSummary').textContent = valid ? '第 ' + first + '–' + last + ' 条' : '共 ' + total + ' 条';
    id('rangePreview').textContent = valid ? excerpt(corpus.messages[first-1]) + (first === last ? '' : ' → ' + excerpt(corpus.messages[last-1])) : '';
    if (!valid) parseIssue = '请填写 1 到 ' + total + ' 之间的消息编号，结束编号应大于或等于起始编号。';
    else {
      amount = prefix[last]-prefix[first-1];
      if (count > maxMessages || amount > maxCharacters) {
        parseIssue = count === 1 ? '这一条正文超过 6,000 字。请在原文框中拆短，或选择其他消息。'
          : '本次最多制作 60 条、6,000 个正文字。请缩短所选范围。';
      } else parsed = {messages:corpus.messages.slice(first-1,last),skipped:corpus.skipped};
    }
    note(id('rangeNote'),parseIssue || '仅制作选中的 ' + count + ' 条文字，原文框保留整份记录。每次最多 60 条、6,000 个正文字。',!!parseIssue);
  }
  updateOnlinePlan();
  id('characters').textContent = amount.toLocaleString('en-US') + ' / 6,000 正文字';
  const names = parsed ? speakerNames(parsed.messages) : [];
  buildRoles(names);
  id('roles').hidden = !names.length;
  id('peopleCount').textContent = names.length + ' 位';
  const count = nativeMode() ? systemVoices.length : LOCAL_VOICES.length;
  id('roleHint').textContent = !count ? '请先在设备上准备本地英语声音。' : names.length > count
    ? '可选 ' + count + ' 种声音，超过这个人数时会共用部分声音。' : '按发言顺序分配声音，可为每个人重新选择。';
}
function setReading(value) {
  readingFile = value;
  id('cancelFile').hidden = !value;
  id('generate').disabled = id('preparePack').disabled = working || value;
}
function cancelImport() {
  importTicket++;
  if (readingFile) setReading(false);
}
id('cancelFile').onclick = () => {
  cancelImport();
  note(id('fileStatus'),'已取消导入，原文和听力卡仍在。');
};
id('chatFile').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || working) return;
  const ticket = ++importTicket;
  resetJobProgress();
  setReading(true);
  note(id('fileStatus'),'正在本机读取聊天文字…');
  try {
    const {readChatText} = await import('./chat-file.js');
    if (ticket !== importTicket) return;
    const raw = await readChatText(file);
    if (ticket !== importTicket) return;
    // Validate first so a damaged archive never replaces a usable draft.
    const result = parseText(raw);
    source.value = raw;
    cachedTranslation = null;
    resetSource(source.value,result);
    scan();
    resetJobProgress();
    note(id('fileStatus'),'已导入 ' + result.messages.length + ' 条文字、' + speakerNames(result.messages).length + ' 位发言人。' +
      (parseIssue ? parseIssue : id('range').open ? '记录较长，已选好第一段，可调整制作范围。' : '可在「角色与声音」中选声。'));
  } catch (e) {
    if (ticket === importTicket) note(id('fileStatus'),'导入未完成。' + (e.message || '请重新选择 ZIP 或 TXT。'),true);
  } finally {
    if (ticket === importTicket) setReading(false);
  }
};
function editedRange() {
  resetOnlineSelection();
  if (readingFile) {
    cancelImport();
    note(id('fileStatus'),'已取消导入，保留当前范围。');
  }
  cachedTranslation = null;
  resetJobProgress();
  scan();
}
for (const key of ['rangeFrom','rangeTo']) id(key).addEventListener('input',editedRange);
id('nextRange').onclick = () => {
  const first = Number(id('rangeTo').value)+1;
  if (!corpus || first > corpus.messages.length) return;
  setRange(first,suggestedEdge(first,1));
  editedRange();
};
id('prevRange').onclick = () => {
  const last = Number(id('rangeFrom').value)-1;
  if (!corpus || last < 1) return;
  setRange(suggestedEdge(last,-1),last);
  editedRange();
};
source.addEventListener('input', () => {
  if (working) cancelJob();
  cancelImport();
  cachedTranslation = null;
  note(id('fileStatus'),'');
  resetJobProgress();
  scan();
});
source.addEventListener('blur', () => {
  if (parseIssue && source.value.trim()) note(id('progress'),parseIssue,true);
});

function setBusy(value) {
  working = value;
  id('onlineConsent').disabled = value;
  for (const field of id('reviewRows').querySelectorAll('textarea')) field.disabled = value;
  if (reviewLines) updateReviewSummary();
  if (!value) clearWaitHint();
  source.readOnly = value;
  id('generate').disabled = id('preparePack').disabled = value || readingFile;
  id('libraryTab').disabled = value;
  if (value) foregroundMessage();
  syncWakeLock();
  id('engine').disabled = id('chatFile').disabled = id('rangeFrom').disabled = id('rangeTo').disabled = value;
  if (value) id('nextRange').disabled = id('prevRange').disabled = true;
  else scan();
  id('cancel').hidden = !value;
  id('generate').setAttribute('aria-busy',String(value));
  id('progress').classList.toggle('sr-only',value);
  for (const select of id('cast').querySelectorAll('select')) select.disabled = value || nativeMode() && !systemVoices.length;
}
function cancelJob() {
  if (!working) return;
  jobVersion++;
  onlineRequest?.abort();
  onlineRequest = null;
  resetJobProgress();
  cancelLocalTranslation();
  releaseLocalVoice();
  setBusy(false);
  if (jobKind === 'pack') note(id('packStatus'),'准备已取消。下次可复用已保存的模型分块。');
  note(id('progress'),'已取消。原文和所选范围都保留在本页，可以重新生成。');
}
id('cancel').onclick = cancelJob;
id('switchOnline').onclick = () => {
  if (onlineMode()) return;
  cancelJob();
  id('engine').value = 'online';
  changeEngine();
  if (onlinePlan?.count) id('onlineConsent').focus(); else source.focus();
};
id('retryJob').onclick = () => {
  if (!working) return;
  cancelJob();
  if (jobKind === 'pack') preparePack(true);
  else startGeneration(true);
};

async function makeLines(messages, tell, bypassCache) {
  const lines = await translateLocally(messages,tell,{bypassCache});
  if (!lines.length || lines.some(line => !line.en?.trim())) throw Error('部分句子没有可朗读的英文，请检查原文。');
  // The translator preserves exact source spans and skips inference on English.
  return lines.map(line => han.test(line.zh) ? line : {...line,en:line.zh});
}
function reviewedLines() {
  return reviewLines.map(line => ({speaker:line.speaker,zh:line.zh,en:line.en || onlineCache.get(line.zh.trim()) || ''}));
}
function updateReviewSummary() {
  const lines = reviewedLines(), missing = lines.filter(line => !line.en).length, ready = lines.length - missing;
  id('reviewSummary').textContent = '已准备 ' + ready + ' / ' + lines.length + ' 句，尚有 ' + missing + ' 句待补。';
  id('finishReview').textContent = missing ? '仅用已译的 ' + ready + ' 句制卡（略过 ' + missing + ' 句）' : '用完整译文生成听力卡';
  id('finishReview').disabled = working || ready === 0 || !!id('reviewRows').querySelector('[aria-invalid="true"]');
}
function showReview(lines) {
  reviewLines = lines;
  const missing = new Map();
  for (const [i,line] of lines.entries()) {
    if (line.en) continue;
    const key = line.zh.trim();
    if (!missing.has(key)) missing.set(key,{reason:line.failureReason,positions:[]});
    missing.get(key).positions.push(i+1);
  }
  const rows = Array.from(missing,([key,{reason,positions}]) => {
    const row = document.createElement('label'), heading = document.createElement('strong');
    const original = document.createElement('span'), detail = document.createElement('small'), field = document.createElement('textarea');
    heading.textContent = '第 ' + positions.join('、') + ' 句';
    original.textContent = key;
    detail.textContent = reason;
    field.lang = 'en'; field.rows = 2; field.maxLength = 8000;
    field.placeholder = '填写这句的英文';
    field.oninput = () => {
      const text = field.value.trim(), valid = text && isReadableEnglish(text);
      if (valid) onlineCache.set(key,text); else onlineCache.delete(key);
      field.setAttribute('aria-invalid',String(!!text && !valid));
      detail.textContent = text && !valid ? '请填写可朗读的英文。' : valid ? '已在本页补好。' : reason;
      revokeConsent();updateOnlinePlan();updateReviewSummary();
    };
    row.append(heading,original,detail,field);
    return row;
  });
  id('reviewRows').replaceChildren(...rows);
  id('translationReview').hidden = false;
  updateReviewSummary();
  id('reviewHeading').focus();
}
function dialogueTitle(messages) {
  const people = speakerNames(messages);
  return people.slice(0,2).join('、') + (people.length > 2 ? '等' : '') + '的对话';
}
id('finishReview').onclick = () => {
  if (!reviewLines || working || id('finishReview').disabled) return;
  const lines = reviewedLines().filter(line => line.en), total = reviewLines.length;
  const partial = lines.length < total;
  openCard({title:dialogueTitle(parsed.messages) + (partial ? '（节选 ' + lines.length + '/' + total + ' 句）' : ''),
    lines,voices:new Map(choices()),native:true,online:true,demo:false});
  if (!partial) clearReview();
  revokeConsent();updateOnlinePlan();
  finishJob(partial ? '已制成节选卡。待译的原句仍在上方，可以继续补全。' : '完整听力卡已就绪。');
  showPlayer();
};
id('generate').onclick = () => startGeneration(false);
async function startGeneration(bypassCache) {
  if (working || readingFile) return;
  resetJobProgress();
  scan();
  if (!parsed) {
    note(id('progress'),parseIssue || '请先粘贴一段聊天，或选择微信 ZIP。',true);
    if (corpus && !id('range').hidden) { id('range').open = true; id('rangeFrom').focus(); } else source.focus();
    return;
  }
  const native = nativeMode(), online = onlineMode();
  if (online) {
    const invalid = id('reviewRows').querySelector('[aria-invalid="true"]');
    if (invalid) {note(id('progress'),'请先改好或清空标出的英文。',true);invalid.focus();return;}
    if (onlineIssue) {note(id('progress'),onlineIssue,true);return;}
    if (onlinePlan?.count && (!id('onlineConsent').checked || consentSignature !== JSON.stringify(onlinePlan.segments))) {
      revokeConsent();
      note(id('progress'),'请先查看本次要发送的正文并勾选同意，或改选纯本机模式。',true);
      id('onlineConsent').focus();
      return;
    }
  }
  if (native) {
    refreshVoices();
    if (!online && !systemVoices.length) { note(id('progress'),'这台设备暂时没有可用的本地英语声音。请安装英语声音后再试，或选用 Kokoro。',true); return; }
  }
  if (!online && (!native || parsed.messages.some(m => han.test(m.text))) && (!globalThis.isSecureContext || !globalThis.Worker || !globalThis.WebAssembly)) {
    note(id('progress'),'本机生成需要通过 HTTPS 在新版 Safari 或 Chrome 中打开。',true);
    return;
  }
  const token = ++jobVersion, input = parsed.messages, voices = new Map(choices()), original = source.value, selection = id('rangeFrom').value + '-' + id('rangeTo').value;
  const live = () => token === jobVersion;
  cloud.cancel();
  demoVersion++;
  jobKind = 'card';
  if (online) {
    onlineRequest = new AbortController();
    revokeConsent();
  }
  setBusy(true);
  showJob('prepare','prepare',online ? '准备在线快读' : '准备制作','正在检查所选消息、角色与英语台词。');
  try {
    const reuse = !online && cachedTranslation?.original === original && cachedTranslation.selection === selection;
    if (reuse) {
      const count = cachedTranslation.lines.length;
      showJob('translate','cache','复用本次选区的译文','已完成的英文稿保存在本页。',{unit:'lines',loaded:count,total:count});
    }
    let lines;
    if (online) {
      lines = await translateOnline(input,info => {
        if (live()) showJob('online','translate','MyMemory 在线翻译',info.message,info);
      },{signal:onlineRequest.signal,cache:onlineCache});
    } else {
      lines = reuse ? cachedTranslation.lines : await makeLines(input, info => { if (live()) showTranslation(info); },bypassCache);
    }
    if (!live()) return;
    if (online && lines.some(line => !line.en)) {
      resetJobProgress();
      showReview(lines);
      note(id('progress'),'已保留本次结果。请核对上方列出的待译原句。');
      return;
    }
    clearReview();
    if (!online) cachedTranslation = {original,selection,lines};
    const title = dialogueTitle(input);
    if (native) {
      openCard({title,lines,voices,native:true,online,demo:false});
      finishJob(online ? '已准备 ' + lines.length + ' 段英文，可在卡片里选择「自然双人配音」。' : '已准备 ' + lines.length + ' 段，点「播放」使用本地系统声音。');
      showPlayer();
      return;
    }
    const ready = [];
    showModel('voice-model',{phase:'prepare',message:'正在启动本机语音组件，并检查所需的声音文件。'});
    for (const [i,line] of lines.entries()) {
      if (i) showSpeech(i,lines.length,line);
      const blob = await renderLocalVoice(line.en,voices.get(line.speaker),(message,detail) => {
        if (!live()) return;
        const info = detail || message;
        const data = typeof info === 'string' ? {message:info} : info;
        if (data.stage === 'load') showModel('voice-model',data);
        else if (data.stage === 'synthesize') showSpeech(i,lines.length,line,data.message);
        else if (/模型|组件/u.test(data.message || '')) showModel('voice-model',data);
        else showSpeech(i,lines.length,line,data.message);
      },{bypassCache});
      if (!live()) return;
      if (!(blob instanceof Blob) || blob.size < 44) throw Error('录音内容不完整，请重试。');
      ready.push({...line,blob});
    }
    openCard({title,lines:ready,demo:false});
    finishJob('已生成 ' + ready.length + ' 段英语。点「播放」开始听。');
    showPlayer();
  } catch (error) {
    if (live()) {
      const panel = id('jobProgress'), stage = panel.dataset.stage;
      const voiceFailed = !native && ['voice-model','synthesize'].includes(stage);
      const where = id('jobStage').textContent, metric = id('jobMetric').textContent;
      resetJobProgress();
      note(id('progress'),'生成未完成（' + where + (metric ? '，' + metric : '') + '）。' + (error.message || '请重试。') +
        (online ? ' 原文已保留。重试时请再次确认发送。' : voiceFailed ? ' 译文已保留在本页，可改选「纯本机翻译 · 系统朗读」直接使用。' : ' 原文仍在，点生成可重试。'),true);
    }
  } finally {
    if (live()) { onlineRequest = null; releaseLocalVoice(); setBusy(false); }
  }
}

function demoAudio(path) {
  const relative = String(path).replace(/^\.?\//u,'');
  if (!/^demo\/[A-Za-z0-9_-]+\.mp3$/u.test(relative)) throw Error('示例音频路径无效。');
  return new URL(relative,siteBase).href;
}
let demoCard = null, demoPending = null;
function loadDemo() {
  if (!demoPending) {
    demoPending = (async () => {
      const response = await fetch(new URL('demo/manifest.json',siteBase));
      if (!response.ok) throw Error('示例暂时无法打开，请检查网络后再试。');
      const data = await response.json();
      if (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 60) throw Error('示例数据无效。');
      const lines = data.lines.map(line => {
        if (![line.speaker,line.en,line.zh].every(s => typeof s === 'string' && s.trim())) throw Error('示例缺少完整台词。');
        return {...line,audio:demoAudio(line.audio)};
      });
      demoCard = {title:String(data.title || '双人听力示例'),lines,demo:true};
      return demoCard;
    })().finally(() => { demoPending = null; });
  }
  return demoPending;
}
loadDemo().catch(() => {}); // Small same-site demo metadata only. Models are loaded by Generate.
id('demo').onclick = async () => {
  const token = ++demoVersion;
  cloud.cancel();
  id('demo').disabled = true;
  try {
    const demo = demoCard || await loadDemo();
    if (token !== demoVersion) return;
    if (!card?.demo) openCard(demo);
    showPlayer();
    playLine(0,true,false);
  } catch (error) { if (token === demoVersion) note(id('progress'),error.message,true); }
  finally { id('demo').disabled = false; }
};

function showPlayer() { id('player').scrollIntoView({block:'start',behavior:'auto'}); }
function clearAudio() {
  reader.stop();
  playbackVersion++;
  openingAudio = false;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (card) for (const url of card.urls) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}
const cloud = cloudPanel((previous,lines) => {
  if (card !== previous) return;
  const title = id('practiceTitle').value.trim() || previous.title;
  openCard({title,lines,cloud:true,resumeIndex:active});
  note(id('playerNote'),'自然配音已就绪，点「播放」听对话。');
  showPlayer();
});
const proof = id('proofPanel');
const shortReply = text => /^\p{Script=Han}{1,2}[。！？!?，,]*$/u.test(text.trim());
proof.ontoggle = () => {
  const rows = id('proofRows');
  if (!proof.open || proof.hidden) {rows.replaceChildren();return;}
  cloud.cancel();
  id('cloudPanel').hidden = true;
  const fields = card.lines.map((line,i) => {
    const label = document.createElement('label'), original = document.createElement('span'), field = document.createElement('textarea');
    original.textContent = (i+1) + ' · ' + line.speaker + '　' + line.zh + (shortReply(line.zh) ? '　· 短回复，请结合上下句核对' : '');
    field.value = line.en; field.lang = 'en'; field.rows = 2; field.maxLength = 8000;
    label.append(original,field);
    return label;
  });
  rows.replaceChildren(...fields);
  note(id('proofNote'),'');
};
proof.addEventListener('toggle',() => {if (!proof.open && !proof.hidden && card) id('cloudPanel').hidden = false;});
id('applyProof').onclick = () => {
  if (!proof.open || proof.hidden || !card?.online) return;
  const fields = [...id('proofRows').querySelectorAll('textarea')];
  if (fields.length !== card.lines.length) return;
  const invalid = fields.findIndex((field,i) => !isReadableEnglish(field.value) && field.value.trim() !== card.lines[i].en);
  if (invalid >= 0) {
    note(id('proofNote'),'请核对第 ' + (invalid+1) + ' 句，填写可朗读的英文。',true);
    fields[invalid].focus();return;
  }
  const lines = card.lines.map((line,i) => ({...line,en:fields[i].value.trim()}));
  openCard({title:id('practiceTitle').value.trim() || card.title,lines,native:true,online:true,voices:card.voices,resumeIndex:active},true);
  note(id('playerNote'),'已更新英文台词。');
};
function openCard(next,keepCloudVoices = false) {
  clearAudio();
  cardVersion++;
  saving = false;
  active = Number.isInteger(next.resumeIndex) && next.resumeIndex >= 0 && next.resumeIndex < next.lines.length ? next.resumeIndex : 0;
  endedAll = false;
  id('repeatLine').checked = false;
  card = {...next,urls:next.native ? [] : next.lines.map(line => line.blob ? URL.createObjectURL(line.blob) : line.audio)};
  proof.hidden = !next.online || !next.native;
  const shortCount = next.lines.filter(line => shortReply(line.zh)).length;
  id('proofHint').textContent = shortCount ? shortCount + ' 句短回复建议结合上下文核对' : '按上下文修改译文';
  proof.open = false;
  id('proofRows').replaceChildren();
  cloud.open(card,keepCloudVoices);
  const textOnly = next.native && !next.voices?.size;
  if (textOnly && next.online) id('cloudPanel').open = true;
  id('cardTitle').textContent = next.title;
  id('cardMeta').textContent = (next.cloud ? 'Kokoro 在线配音 · ' : textOnly ? '英文已就绪 · ' : next.native ? '本机系统声音 · ' : next.demo ? 'Heart × Michael 双人试听 · ' : '已配音 · ') + next.lines.length + ' 段对白';
  id('player').hidden = false;
  id('cardActions').hidden = !!next.demo;
  id('practiceTitle').value = next.title;
  id('practiceTitle').readOnly = !!next.libraryId;
  id('savePractice').disabled = !!next.libraryId || textOnly;
  id('savePractice').textContent = next.libraryId ? '已存入我的练习' : '存入我的练习';
  note(id('librarySaveNote'),'');
  card.lastPosition = active;
  id('saveCard').hidden = !!(next.demo || next.native);
  id('saveCard').disabled = false;
  id('saveNote').hidden = true;
  note(id('playerNote'),textOnly ? '设备没有本地英语声音，生成自然配音后即可播放和保存。' : '点任意一句从这里听。');
  id('play').disabled = !!textOnly;
  const nodes = next.lines.map((line,i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'line';
    for (const [cls,content] of [['no',pad(i+1)],['name',line.speaker],['en',line.en],['zh',line.zh]]) {
      const span = document.createElement('span');
      span.className = 'line-' + cls;
      if (cls === 'en') span.lang = 'en';
      if (cls === 'no') span.setAttribute('aria-hidden','true');
      span.textContent = content;
      button.append(span);
    }
    button.onclick = () => playLine(i,true,false);
    return button;
  });
  id('lines').replaceChildren(...nodes);
  highlight(false);
  paintTransport();
}
function highlight(scroll) {
  if (!card) return;
  if (card.libraryId && active !== card.lastPosition) {
    const target = card;
    target.lastPosition = active;
    updatePracticePosition(target.libraryId,active).catch(() => {
      if (card === target) note(id('librarySaveNote'),'这次的播放位置未能保存。',true);
    });
  }
  const rows = id('lines').children;
  for (let i=0;i<rows.length;i++) {
    rows[i].classList.toggle('active',i === active);
    if (i === active) rows[i].setAttribute('aria-current','true');
    else rows[i].removeAttribute('aria-current');
  }
  const row = rows[active];
  if (scroll && id('follow').checked && row) {
    const rect = row.getBoundingClientRect(), deck = id('player').querySelector('.transport').getBoundingClientRect();
    if (rect.top < deck.bottom || rect.bottom > window.innerHeight - 12) {
      row.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    }
  }
}
function paintTransport() {
  if (!card) return;
  const count = card.lines.length;
  const running = card.native ? reader.state === 'playing' : openingAudio || !audio.paused && !audio.ended;
  id('play').textContent = running ? 'Ⅱ 暂停' : endedAll ? '↻ 重听' : '▷ 播放';
  id('prevLine').disabled = active === 0;
  id('nextLine').disabled = active === count-1;
  id('position').textContent = pad(active+1) + ' / ' + pad(count);
  const elapsed = card.native ? reader.fraction : audio.currentSrc === card.urls[active] && Number.isFinite(audio.duration) && audio.duration > 0
    ? Math.min(1,audio.currentTime / audio.duration) : 0;
  id('meter').firstElementChild.style.width = (endedAll ? 100 : 100*(active+elapsed)/count) + '%';
}
async function playLine(index, restart, scroll) {
  if (!card?.lines[index]) return;
  if (card.native) {
    active = index;
    endedAll = false;
    highlight(scroll);
    const line = card.lines[index];
    if (!card.voices?.size) { note(id('playerNote'),'生成上方的自然配音后即可播放。');paintTransport();return; }
    note(id('playerNote'),'系统声音正在本机朗读，可点击任意一句跳听。');
    try {
      reader.start({text:line.en, key:card.voices.get(line.speaker), rate:Number(id('rate').value),
        update:paintTransport, end:advance, error:message => { note(id('playerNote'),message,true); paintTransport(); }});
    } catch (e) { note(id('playerNote'),e.message,true); paintTransport(); }
    return;
  }
  const token = ++playbackVersion;
  active = index;
  endedAll = false;
  openingAudio = true;
  if (audio.getAttribute('src') !== card.urls[index]) audio.src = card.urls[index];
  else if (restart) { try { audio.currentTime = 0; } catch {} }
  audio.playbackRate = Number(id('rate').value);
  note(id('playerNote'),'点任意一句从这里听。');
  highlight(scroll);
  paintTransport();
  try { await audio.play(); }
  catch {
    if (token === playbackVersion) note(id('playerNote'),'音频未能开始播放。请再点「播放」，或检查示例音频的网络连接。',true);
  } finally {
    if (token === playbackVersion) { openingAudio = false; paintTransport(); }
  }
}
id('play').onclick = () => {
  if (!card) return;
  if (card.native) {
    try {
      if (reader.state === 'playing') reader.pause();
      else if (reader.state === 'paused') reader.resume(Number(id('rate').value));
      else playLine(endedAll ? 0 : active,true,false);
    } catch (e) { reader.stop(); note(id('playerNote'),e.message,true); paintTransport(); }
    return;
  }
  if (openingAudio || !audio.paused && !audio.ended) {
    playbackVersion++; openingAudio = false; audio.pause(); paintTransport();
  } else playLine(endedAll ? 0 : active,endedAll,false);
};
function advance() {
  if (!card) return;
  if (id('repeatLine').checked) playLine(active,true,false);
  else if (active + 1 < card.lines.length) playLine(active+1,true,true);
  else { endedAll = true; paintTransport(); }
}
audio.addEventListener('ended',() => {
  if (card && !card.native && audio.currentSrc === card.urls[active] && audio.ended) advance();
});
for (const event of ['play','pause','timeupdate','loadedmetadata']) audio.addEventListener(event,paintTransport);
audio.addEventListener('error',() => {
  if (card && audio.error && audio.getAttribute('src') === card.urls[active]) {
    openingAudio = false;
    note(id('playerNote'),'这句音频无法载入。可点其他句，或重新打开材料。',true);
    paintTransport();
  }
});
id('rate').onchange = () => {
  const rate = Number(id('rate').value);
  if (!card?.native) { audio.playbackRate = rate; return; }
  try { reader.changeRate(rate); } catch (e) { reader.stop(); note(id('playerNote'),e.message,true); paintTransport(); }
};
id('showChinese').onchange = () => id('lines').classList.toggle('hide-zh',!id('showChinese').checked);
id('follow').onchange = () => { if (id('follow').checked && (reader.state === 'playing' || !audio.paused)) highlight(true); };
id('saveCard').onclick = async () => {
  if (!card || card.demo || card.native || saving) return;
  const target = card, version = cardVersion;
  saving = true;
  id('saveCard').disabled = true;
  id('saveNote').hidden = false;
  note(id('saveNote'),'正在整理音频与字幕…');
  try {
    const {downloadListeningCard} = await import('./export-card.js');
    if (version !== cardVersion) return;
    await downloadListeningCard(target.lines,target.title);
    if (version === cardVersion) note(id('saveNote'),'已请求保存。可在浏览器下载或系统分享菜单中查看。');
  } catch (e) {
    if (version === cardVersion) note(id('saveNote'),e.message || '保存未完成，请重试。',true);
  } finally {
    if (version === cardVersion) { saving = false; id('saveCard').disabled = false; }
  }
};
id('prevLine').onclick = () => playLine(active-1,true,true);
id('nextLine').onclick = () => playLine(active+1,true,true);

id('savePractice').onclick = async () => {
  if (!card || card.demo || card.libraryId || id('savePractice').disabled) return;
  const target = card;
  target.title = id('practiceTitle').value.trim() || id('cardTitle').textContent;
  id('practiceTitle').value = id('cardTitle').textContent = target.title;
  id('practiceTitle').readOnly = id('savePractice').disabled = true;
  note(id('librarySaveNote'),'正在保存到这台设备…');
  try {
    const entry = await savePracticeCard(target);
    target.libraryId = entry.id;
    if (card === target) {
      target.lastPosition = -1;
      highlight(false);
      id('savePractice').textContent = '已存入我的练习';
      note(id('librarySaveNote'),'已保存。下次打开「我的练习」即可接着听。');
    }
    if (!id('libraryView').hidden) shelf.refresh();
  } catch (error) {
    if (card === target) {
      note(id('librarySaveNote'),error.message,true);
      id('practiceTitle').readOnly = id('savePractice').disabled = false;
    }
  }
};

const shelf = practiceShelf({
  onOpen(saved) {showStudio(); openCard(saved);showPlayer();id('cardTitle').focus({preventScroll:true});},
  onDelete(deleted) {
    if (card?.libraryId !== deleted) return;
    delete card.libraryId;
    id('practiceTitle').readOnly = id('savePractice').disabled = false;
    id('savePractice').textContent = '存入我的练习';
    note(id('librarySaveNote'),'此卡已从练习库移除。');
  }
});
function showStudio() {
  shelf.leave();
  id('studioView').hidden = false;
  id('libraryView').hidden = true;
  id('studioTab').setAttribute('aria-current','page');
  id('libraryTab').removeAttribute('aria-current');
}
id('studioTab').onclick = id('returnStudio').onclick = () => {showStudio();window.scrollTo(0,0);};
document.querySelector('.brand').onclick = () => showStudio();
id('libraryTab').onclick = () => {
  if (working) return;
  cloud.cancel();
  demoVersion++;
  playbackVersion++;
  openingAudio = false;
  audio.pause(); reader.stop(); paintTransport();
  id('studioView').hidden = true;
  id('libraryView').hidden = false;
  id('libraryTab').setAttribute('aria-current','page');
  id('studioTab').removeAttribute('aria-current');
  window.scrollTo(0,0);
  shelf.refresh();
};
window.addEventListener('pagehide', event => {
  cancelImport();
  cancelJob();
  cloud.cancel();
  reader.stop();
  playbackVersion++;
  openingAudio = false;
  audio.pause();
  if (!event.persisted) { clearAudio(); card = null; }
});
changeEngine();

id('preparePack').onclick = () => preparePack(false);
async function preparePack(bypassCache) {
  if (onlineMode() || working || readingFile) return;
  const native = nativeMode(), token = ++jobVersion;
  const live = () => jobVersion === token;
  jobKind = 'pack';
  resetJobProgress();
  delete id('packStatus').dataset.ready;
  note(id('packStatus'),'正在用示例检查本机模型…');
  setBusy(true);
  try {
    await translateLocally([{speaker:'试音',text:'你好。'}],info => {
      if (live()) showTranslation(info);
    },{bypassCache});
    if (!live()) return;
    if (!native) {
      for (const voice of ['af_heart','am_michael']) {
        await renderLocalVoice('Hi.',voice,(message,detail) => {
          if (!live()) return;
          if (detail?.stage === 'load') showModel('voice-model',detail);
          else showJob('check','synthesize','检查配音',voice === 'af_heart' ? '正在测试 Heart 女声。' : '正在测试 Michael 男声。');
        },{bypassCache});
        if (!live()) return;
      }
    }
    const result = native ? '翻译模型检查完成。可以导入中文聊天了。' : '翻译和双人配音均已试运行。可以导入聊天了。';
    note(id('packStatus'),result);
    id('packStatus').dataset.ready = 'true';
    showJob('complete','complete','准备完成',result,{unit:'complete',loaded:1,total:1});
  } catch (error) {
    if (live()) {resetJobProgress();note(id('packStatus'),'准备未完成。' + error.message,true);}
  } finally {if (live()) {releaseLocalVoice();setBusy(false);}}
}
if ('serviceWorker' in navigator) window.addEventListener('load',() => {
  navigator.serviceWorker.register(new URL('./study-sw.js',siteBase)).catch(() => {});
});

for (const [button,panel] of [['formatHelp','formatGuide'],['installHelp','installTip']]) {
  id(button).onclick = () => {
    const expanded = id(panel).hidden;
    id(panel).hidden = !expanded;
    id(button).setAttribute('aria-expanded',String(expanded));
  };
}
id('shareSite').onclick = async () => {
  const link = siteBase.href;
  try {
    if (navigator.share) await navigator.share({title:'英语搭子',url:link});
    else {
      await navigator.clipboard.writeText(link);
      note(id('shareStatus'),'已复制网站链接。');
    }
  } catch (error) {
    if (error.name !== 'AbortError') note(id('shareStatus'),'网站链接为 ' + link);
  }
};
