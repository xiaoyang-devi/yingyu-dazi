import {parseText} from './intake.js';
import {translateLocally, cancelLocalTranslation} from './local-translate.js';
import {LOCAL_VOICES, renderLocalVoice, releaseLocalVoice} from './local-voice.js';

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
const choices = new Map();
let parsed = null, parseIssue = '', castNames = [], jobVersion = 0, working = false;
let card = null, active = 0, playbackVersion = 0, openingAudio = false, endedAll = false;
let cardVersion = 0, demoVersion = 0, saving = false;

function note(node, message, error = false) {
  node.textContent = message;
  node.dataset.kind = error ? 'error' : 'info';
}
function buildRoles(names) {
  if (names.length === castNames.length && names.every((name, i) => name === castNames[i])) return;
  castNames = names;
  for (const name of choices.keys()) if (!names.includes(name)) choices.delete(name);
  const reserved = new Set(choices.values());
  const rows = names.map((name, i) => {
    const voice = choices.get(name) || LOCAL_VOICES.find(v => !reserved.has(v)) || LOCAL_VOICES[i % LOCAL_VOICES.length];
    choices.set(name, voice);
    reserved.add(voice);
    const row = document.createElement('label'), label = document.createElement('span'), select = document.createElement('select');
    row.className = 'cast-row';
    label.textContent = name;
    select.setAttribute('aria-label', name + ' 的声音');
    for (const value of LOCAL_VOICES) select.add(new Option(voiceLabels[value] || value,value));
    select.value = voice;
    select.onchange = () => choices.set(name, select.value);
    row.append(label,select);
    return row;
  });
  id('cast').replaceChildren(...rows);
}
function scan() {
  const text = source.value, amount = [...text].length;
  parsed = null;
  parseIssue = '';
  id('characters').textContent = amount.toLocaleString('en-US') + ' / 6,000';
  try {
    if (amount > 6000) throw Error('一次最多 6,000 个字符，请选取一部分对话。');
    if (text.trim()) {
      const result = parseText(text);
      if (result.messages.length > 60) throw Error('一次最多 60 条消息，请分成两次制作。');
      parsed = result;
    }
  } catch (e) { parseIssue = e.message; }
  const names = parsed ? speakerNames(parsed.messages) : [];
  buildRoles(names);
  id('roles').hidden = !names.length;
  id('peopleCount').textContent = names.length + ' 位';
  id('materials').textContent = parsed
    ? names.length + ' 位发言人 · ' + parsed.messages.length + ' 条文字' + (parsed.skipped ? ' · 已跳过 ' + parsed.skipped + ' 条' : '')
    : text.trim() ? '请用「名字：内容」标明发言人' : '支持中文、英文和中英混合聊天';
  id('roleHint').textContent = names.length > LOCAL_VOICES.length
    ? '可选 ' + LOCAL_VOICES.length + ' 种声音，超过这个人数时会共用部分声音。' : '按发言顺序分配声音，可为每个人重新选择。';
}
source.addEventListener('input', () => {
  if (working) cancelJob();
  note(id('progress'),'');
  scan();
});
source.addEventListener('blur', () => {
  if (parseIssue && source.value.trim()) note(id('progress'),parseIssue,true);
});

function setBusy(value) {
  working = value;
  source.readOnly = value;
  id('generate').disabled = value;
  id('cancel').hidden = !value;
  id('editor').setAttribute('aria-busy',String(value));
  for (const select of id('cast').querySelectorAll('select')) select.disabled = value;
}
function cancelJob() {
  if (!working) return;
  jobVersion++;
  cancelLocalTranslation();
  releaseLocalVoice();
  setBusy(false);
  note(id('progress'),'已取消。原文仍在，可以调整后再试。');
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
  if (working) return;
  scan();
  if (!parsed) { note(id('progress'),parseIssue || '请先粘贴一段带发言人名字的聊天。',true); source.focus(); return; }
  if (!globalThis.isSecureContext || !globalThis.Worker || !globalThis.WebAssembly) {
    note(id('progress'),'本机生成需要通过 HTTPS 在新版 Safari 或 Chrome 中打开。',true);
    return;
  }
  const token = ++jobVersion, input = parsed.messages, voices = new Map(choices);
  const live = () => token === jobVersion;
  const tell = message => { if (live() && message) note(id('progress'),message); };
  demoVersion++;
  setBusy(true);
  tell('正在按发言顺序整理对话…');
  try {
    const lines = await makeLines(input,tell);
    if (!live()) return;
    const ready = [];
    for (const [i,line] of lines.entries()) {
      const stage = '配音 ' + (i+1) + ' / ' + lines.length + ' · ' + line.speaker;
      tell(stage);
      const blob = await voiceLine(line,voices.get(line.speaker),detail => tell(stage + '　' + detail));
      if (!live()) return;
      if (!(blob instanceof Blob) || blob.size < 44) throw Error('录音内容不完整，请重试。');
      ready.push({...line,blob});
    }
    const people = speakerNames(input);
    openCard({title:people.slice(0,2).join('、') + (people.length > 2 ? '等' : '') + '的对话',lines:ready,demo:false});
    tell('已生成 ' + ready.length + ' 段英语。点「播放」开始听。');
    showPlayer();
  } catch (error) {
    if (live()) note(id('progress'),'生成未完成。' + (error.message || '请分段重试。'),true);
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
  card = {...next,urls:next.lines.map(line => line.blob ? URL.createObjectURL(line.blob) : line.audio)};
  id('cardTitle').textContent = next.title;
  id('cardMeta').textContent = (next.demo ? '双人试听 · ' : '本机生成 · ') + next.lines.length + ' 段对白';
  id('player').hidden = false;
  id('saveCard').hidden = next.demo;
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
  const running = openingAudio || !audio.paused && !audio.ended;
  id('play').textContent = running ? 'Ⅱ 暂停' : endedAll ? '↻ 重听' : '▷ 播放';
  id('position').textContent = pad(active+1) + ' / ' + pad(count);
  const elapsed = audio.currentSrc === card.urls[active] && Number.isFinite(audio.duration) && audio.duration > 0
    ? Math.min(1,audio.currentTime / audio.duration) : 0;
  id('meter').firstElementChild.style.width = (endedAll ? 100 : 100*(active+elapsed)/count) + '%';
}
async function playLine(index, restart, scroll) {
  if (!card?.urls[index]) return;
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
  if (openingAudio || !audio.paused && !audio.ended) {
    playbackVersion++; openingAudio = false; audio.pause(); paintTransport();
  } else playLine(endedAll ? 0 : active,endedAll,false);
};
audio.addEventListener('ended',() => {
  if (!card || audio.currentSrc !== card.urls[active] || !audio.ended) return;
  if (active + 1 < card.lines.length) playLine(active+1,true,true);
  else { endedAll = true; paintTransport(); }
});
for (const event of ['play','pause','timeupdate','loadedmetadata']) audio.addEventListener(event,paintTransport);
audio.addEventListener('error',() => {
  if (card && audio.error && audio.getAttribute('src') === card.urls[active]) {
    openingAudio = false;
    note(id('playerNote'),'这句音频无法载入。可点其他句，或重新打开材料。',true);
    paintTransport();
  }
});
id('rate').onchange = () => { audio.playbackRate = Number(id('rate').value); };
id('showChinese').onchange = () => id('lines').classList.toggle('hide-zh',!id('showChinese').checked);
id('follow').onchange = () => { if (id('follow').checked && !audio.paused) highlight(true); };
id('saveCard').onclick = async () => {
  if (!card || card.demo || saving) return;
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
  cancelJob();
  playbackVersion++;
  openingAudio = false;
  audio.pause();
  if (!event.persisted) { clearAudio(); card = null; }
});
scan();
