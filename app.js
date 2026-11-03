import {parseText} from './intake.js?v=4';
import {translateLocally, cancelLocalTranslation} from './local-translate.js';
import {LOCAL_VOICES, renderLocalVoice, releaseLocalVoice} from './local-voice.js?v=3';
import {localEnglishVoices, createLocalReader} from './native-speech.js';

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
const nativeMode = () => id('engine').value === 'native';
const castChoices = {kokoro:new Map(),native:new Map()};
const choices = () => castChoices[id('engine').value];
const kokoroNote = id('downloadNote').textContent;
let systemVoices = [], cachedTranslation = null;
let parsed = null, parseIssue = '', castNames = [], jobVersion = 0, working = false;
let card = null, active = 0, playbackVersion = 0, openingAudio = false, endedAll = false;
let cardVersion = 0, demoVersion = 0, saving = false;

function note(node, message, error = false) {
  node.textContent = message;
  node.dataset.kind = error ? 'error' : 'info';
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
      : '浏览器暂未提供本地英语声音。可先在设备的语音设置中安装英语声音，再回到此页，或选用 Kokoro。';
    force ||= changed;
  }
  if (force) buildRoles(parsed ? speakerNames(parsed.messages) : [],true);
}
function changeEngine() {
  reader.stop();
  paintTransport();
  const native = nativeMode();
  id('nativeSupport').hidden = !native;
  id('downloadTitle').textContent = native ? '系统声音实时朗读 · 无需下载 Kokoro' : '首次生成约需下载 250 MB';
  id('downloadNote').textContent = native
    ? '仅使用设备已有的本地英语声音。纯英文可直接练习；中文首次仍需下载约 130 MB 的翻译模型。轻量模式不保存音频。'
    : kokoroNote;
  id('generate').textContent = native ? '▷ 准备轻量朗读' : '▷ 生成英语听力卡';
  note(id('progress'),'');
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
  scannedText = raw;
  corpus = null;
  corpusError = '';
  prefix = [0];
  if (raw.trim()) {
    try { corpus = known || parseText(raw); } catch (e) { corpusError = e.message; }
  }
  const total = corpus?.messages.length || 0;
  id('range').hidden = total < 2;
  if (corpus) {
    for (const message of corpus.messages) prefix.push(prefix.at(-1) + [...message.text].length);
    id('rangeFrom').max = id('rangeTo').max = total;
    setRange(1,suggestedEdge(1,1));
  }
  id('range').open = total > maxMessages || prefix.at(-1) > maxCharacters;
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
          : '本次最多制作 60 条、6,000 个正文字。请缩短下面的消息范围。';
      } else parsed = {messages:corpus.messages.slice(first-1,last),skipped:corpus.skipped};
    }
    note(id('rangeNote'),parseIssue || '仅制作选中的 ' + count + ' 条文字，原文框保留整份记录。每次最多 60 条、6,000 个正文字。',!!parseIssue);
  }
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
  id('generate').disabled = working || value;
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
    note(id('progress'),'');
    note(id('fileStatus'),'已导入 ' + result.messages.length + ' 条文字、' + speakerNames(result.messages).length + ' 位发言人。' +
      (id('range').open ? '记录较长，已选好第一段，可调整制作范围。' : '可在「角色与声音」中选声。'));
  } catch (e) {
    if (ticket === importTicket) note(id('fileStatus'),'导入未完成。' + (e.message || '请重新选择 ZIP 或 TXT。'),true);
  } finally {
    if (ticket === importTicket) setReading(false);
  }
};
function editedRange() {
  if (readingFile) {
    cancelImport();
    note(id('fileStatus'),'已取消导入，保留当前范围。');
  }
  cachedTranslation = null;
  note(id('progress'),'');
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
  note(id('progress'),'');
  scan();
});
source.addEventListener('blur', () => {
  if (parseIssue && source.value.trim()) note(id('progress'),parseIssue,true);
});

function setBusy(value) {
  working = value;
  source.readOnly = value;
  id('generate').disabled = value || readingFile;
  id('engine').disabled = id('chatFile').disabled = id('rangeFrom').disabled = id('rangeTo').disabled = value;
  if (value) id('nextRange').disabled = id('prevRange').disabled = true;
  else scan();
  id('cancel').hidden = !value;
  id('editor').setAttribute('aria-busy',String(value));
  for (const select of id('cast').querySelectorAll('select')) select.disabled = value || nativeMode() && !systemVoices.length;
}
function cancelJob() {
  if (!working) return;
  jobVersion++;
  cancelLocalTranslation();
  releaseLocalVoice();
  setBusy(false);
  note(id('progress'),nativeMode() ? '已取消。原文仍在，可以调整后再试。' : '已取消。你可以改选「轻量朗读」继续，原文仍在。');
}
id('cancel').onclick = cancelJob;

async function makeLines(messages, tell) {
  const lines = await translateLocally(messages, progress => tell(typeof progress === 'string' ? progress : progress.message));
  if (!lines.length || lines.some(line => !line.en?.trim())) throw Error('部分句子没有可朗读的英文，请检查原文。');
  // The translator preserves exact source spans and skips inference on English.
  return lines.map(line => han.test(line.zh) ? line : {...line,en:line.zh});
}
async function voiceLine(line, voice, tell) {
  let timer, arm;
  const idle = new Promise((_, reject) => {
    arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reject(Error('配音长时间没有进度。请检查网络、保持页面打开，或把材料分段重试。')),180000);
    };
    arm();
  });
  try {
    const audio = renderLocalVoice(line.en,voice,message => { arm(); tell(message); });
    return await Promise.race([audio,idle]);
  } finally { clearTimeout(timer); }
}
id('generate').onclick = async () => {
  if (working || readingFile) return;
  scan();
  if (!parsed) {
    note(id('progress'),parseIssue || '请先粘贴一段聊天，或选择微信 ZIP。',true);
    if (corpus && !id('range').hidden) { id('range').open = true; id('rangeFrom').focus(); } else source.focus();
    return;
  }
  const native = nativeMode();
  if (native) {
    refreshVoices();
    if (!systemVoices.length) { note(id('progress'),'这台设备暂时没有可用的本地英语声音。请安装英语声音后再试，或选用 Kokoro。',true); return; }
  }
  if ((!native || parsed.messages.some(m => han.test(m.text))) && (!globalThis.isSecureContext || !globalThis.Worker || !globalThis.WebAssembly)) {
    note(id('progress'),'本机生成需要通过 HTTPS 在新版 Safari 或 Chrome 中打开。',true);
    return;
  }
  const token = ++jobVersion, input = parsed.messages, voices = new Map(choices()), original = source.value, selection = id('rangeFrom').value + '-' + id('rangeTo').value;
  const live = () => token === jobVersion;
  const tell = message => { if (live() && message) note(id('progress'),message); };
  demoVersion++;
  setBusy(true);
  tell('正在按发言顺序整理对话…');
  try {
    const lines = cachedTranslation?.original === original && cachedTranslation.selection === selection ? cachedTranslation.lines : await makeLines(input,tell);
    if (!live()) return;
    cachedTranslation = {original,selection,lines};
    const people = speakerNames(input);
    const title = people.slice(0,2).join('、') + (people.length > 2 ? '等' : '') + '的对话';
    if (native) {
      openCard({title,lines,voices,native:true,demo:false});
      tell('已准备 ' + lines.length + ' 段，点「播放」使用本地系统声音。');
      showPlayer();
      return;
    }
    const ready = [];
    for (const [i,line] of lines.entries()) {
      const stage = '配音 ' + (i+1) + ' / ' + lines.length + ' · ' + line.speaker;
      tell(stage);
      const blob = await voiceLine(line,voices.get(line.speaker),detail => tell(stage + '　' + detail));
      if (!live()) return;
      if (!(blob instanceof Blob) || blob.size < 44) throw Error('录音内容不完整，请重试。');
      ready.push({...line,blob});
    }
    openCard({title,lines:ready,demo:false});
    tell('已生成 ' + ready.length + ' 段英语。点「播放」开始听。');
    showPlayer();
  } catch (error) {
    if (live()) note(id('progress'),'生成未完成。' + (error.message || '请分段重试。') + (native ? '' : ' 可改选「轻量朗读」继续。'),true);
  } finally {
    if (live()) { releaseLocalVoice(); setBusy(false); }
  }
};

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
function openCard(next) {
  clearAudio();
  cardVersion++;
  saving = false;
  active = 0;
  endedAll = false;
  card = {...next,urls:next.native ? [] : next.lines.map(line => line.blob ? URL.createObjectURL(line.blob) : line.audio)};
  id('cardTitle').textContent = next.title;
  id('cardMeta').textContent = (next.native ? '轻量朗读 · 本机系统声音 · ' : next.demo ? '双人试听 · ' : '本机生成 · ') + next.lines.length + ' 段对白';
  id('player').hidden = false;
  id('saveCard').hidden = !!(next.demo || next.native);
  id('saveCard').disabled = false;
  id('saveNote').hidden = true;
  note(id('playerNote'),'点任意一句从这里听。');
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
  if (active + 1 < card.lines.length) playLine(active+1,true,true);
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
window.addEventListener('pagehide', event => {
  cancelImport();
  cancelJob();
  reader.stop();
  playbackVersion++;
  openingAudio = false;
  audio.pause();
  if (!event.persisted) { clearAudio(); card = null; }
});
scan();
