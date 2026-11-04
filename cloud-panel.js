// Rendering the choices or the transcript never contacts the speech service.
import {CLOUD_VOICES,cloudClipKey,renderCloudDialogue} from './cloud-voice.js?v=15';

export function cloudPanel(onReady,backupAllowed) {
  const el = key => document.getElementById(key);
  const panel = el('cloudPanel'), consent = el('cloudConsent'), generate = el('cloudGenerate');
  const labels = {af_heart:'Heart · 女声',am_michael:'Michael · 男声'};
  let card, request, cast = new Map(), clips = new Map(), routeState = {};

  function key(line) { return cloudClipKey(cast.get(line.speaker),line.en); }
  function note(message, error = false) {
    el('cloudStatus').textContent = message;
    el('cloudStatus').dataset.kind = error ? 'error' : 'info';
  }
  function controls() {
    const busy = Boolean(request);
    consent.disabled = el('cloudSwap').disabled = busy;
    el('proofBackup').disabled = el('legacyBackup').disabled = el('allowBackup').disabled = busy;
    generate.disabled = busy || !consent.checked;
    el('cloudCancel').hidden = !busy;
    for (const select of el('cloudCast').querySelectorAll('select')) select.disabled = busy;
  }
  function review() {
    consent.checked = false;
    const pending = new Map();
    for (const line of card.lines) {
      const k = key(line);
      if (!clips.has(k)) pending.set(k,line.en);
    }
    const list = el('cloudLines');
    list.replaceChildren();
    let length = 0;
    for (const text of pending.values()) {
      length += Array.from(text).length;
      const li = document.createElement('li');
      li.lang = 'en';
      li.textContent = text;
      list.append(li);
    }
    el('cloudScope').textContent = '查看待发送的 ' + pending.size + ' 段英文（' + length.toLocaleString('zh-CN') + ' 字符）';
    const tooLong = length > 5000 && !backupAllowed();
    controls();
    consent.disabled = tooLong || Boolean(request);
    if (tooLong) note('所选英文超过 5,000 字符。请在制作台缩短选区后再配音。',true);
  }
  function drawCast() {
    const rows = Array.from(cast,([name,voice]) => {
      const row = document.createElement('label'), tag = document.createElement('span'), select = document.createElement('select');
      row.className = 'cast-row';
      tag.textContent = name;
      select.setAttribute('aria-label',name + ' 的在线配音');
      for (const k of CLOUD_VOICES) select.add(new Option(labels[k],k));
      select.value = voice;
      select.onchange = () => {cast.set(name,select.value);note('');review();};
      row.append(tag,select);
      return row;
    });
    el('cloudCast').replaceChildren(...rows);
  }
  function cancel() {
    if (!request) {
      if (consent.checked && card) review();
      return;
    }
    request.abort();
    request = null;
    note('已停止。已收到的录音留在这张卡里，本次已发出的请求可能仍会完成。');
    review();
  }
  function open(next,keepVoices = false) {
    cancel();
    const previousCast = keepVoices ? cast : null;
    if (!keepVoices) routeState = {};
    card = next?.native && next.online || next?.cloud && next.voices?.size ? next : null;
    cast = new Map();
    if (keepVoices && card) {
      const lines = new Set(card.lines.map(line => line.en));
      for (const k of clips.keys()) if (!lines.has(JSON.parse(k)[1])) clips.delete(k);
    } else clips = new Map();
    note('');
    panel.hidden = !card?.native;
    panel.open = false;
    el('cloudCast').replaceChildren();
    el('cloudLines').replaceChildren();
    el('cloudPreview').open = consent.checked = false;
    if (!card) return;
    for (const name of new Set(card.lines.map(line => line.speaker))) {
      const chosen = card.cloud ? card.voices.get(name) : previousCast?.get(name);
      cast.set(name,CLOUD_VOICES.includes(chosen) ? chosen : CLOUD_VOICES[cast.size % CLOUD_VOICES.length]);
    }
    if (card.cloud) {
      for (const line of card.lines) clips.set(key(line),{blob:line.blob,voiceProvider:line.voiceProvider || 'tts.ai'});
      return;
    }
    el('cloudSwap').hidden = cast.size < 2;
    drawCast();
    review();
  }
  el('cloudSwap').onclick = () => {
    if (!card || request) return;
    for (const [name,voice] of cast) cast.set(name,CLOUD_VOICES.find(k => k !== voice));
    drawCast();note('已交换声音。');review();
  };
  consent.onchange = controls;
  el('cloudCancel').onclick = cancel;
  async function render(lines,onLine) {
    if (!card || request) throw Error('已有配音任务正在进行。');
    const job = new AbortController();
    request = job;
    controls();
    try {
      return await renderCloudDialogue(lines,cast,clips,job.signal,onLine,{allowBackup:backupAllowed(),routeState});
    } finally {
      if (request === job) { request = null; controls(); }
    }
  }
  generate.onclick = async () => {
    if (!card || request || !consent.checked || consent.disabled || panel.hidden) return;
    const current = card;
    consent.checked = false;
    try {
      const lines = await render(current.lines,(i,line,voice,provider,status = {}) => {
        const label = provider === 'mixed' ? '含备用 · ' + (voice === 'af_heart' ? 'Heart / Bella 女声' : 'Michael 男声')
          : provider === 'huggingface' ? '备用 · ' + (voice === 'af_heart' ? 'Bella 女声' : 'Michael 男声') : labels[voice];
        if (status.phase === 'switching') note((status.reason === 'rate-limit' ? '主服务生成限速' : '主服务配音额度不足') + '，正在切换备用自然配音。已完成的录音会保留。');
        else if (status.phase === 'waiting') note('主服务生成限速，约 ' + Math.max(1,Math.ceil(status.waitMs / 1000)) + ' 秒后继续。');
        else note('正在配第 ' + (i+1) + ' / ' + current.lines.length + ' 句 · ' + label + '。');
      });
      if (card === current) onReady(current,lines,new Map(cast));
    } catch (error) {
      if (card !== current || error.name === 'AbortError') return;
      review();
      note((error.message || '在线配音未完成。') + ' 译文仍在，已收到的录音可在本页重用。',true);
    }
  };
  return {open,cancel,render,refresh() { if (card?.native && !request) { note(''); review(); } }};
}
