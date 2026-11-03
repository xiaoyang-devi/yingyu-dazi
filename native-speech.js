const familiarNames = ['samantha','daniel','ava','alex','serena','karen','allison','tom','moira','oliver','tessa','fiona','nathan','aaron','victoria','david','zira','mark','hazel','susan'];
const novelty = /^(?:albert|bad news|good news|bells|boing|zarvox|bubbles|cellos|organ|bahh|hysterical|deranged|trinoids|wobble|whisper|jester|superstar)\b/i;
function profile(voice) {
  const name = voice.name.toLowerCase();
  const words = new Set(name.match(/[a-z]+/g) || []);
  const rank = familiarNames.findIndex(person => words.has(person));
  // Apple can expose the same speaker in compact, enhanced and premium quality.
  const family = rank >= 0 ? familiarNames[rank] : name.replace(/\s*[（(][^()（）]*[）)]/g,'').trim();
  const priority = rank >= 0 ? rank : novelty.test(family) ? 200 : 100;
  const quality = /premium/i.test(voice.voiceURI) ? 2 : /enhanced/i.test(voice.voiceURI) ? 1 : 0;
  return {family,priority,quality};
}

// Uses only voices the browser identifies as local English speech services.
export function localEnglishVoices() {
  if (typeof globalThis.SpeechSynthesisUtterance !== 'function') return [];
  let voices;
  try { voices = globalThis.speechSynthesis?.getVoices() || []; } catch { return []; }
  const found = new Map();
  for (const voice of voices) {
    if (voice.localService !== true || !/^en(?:[-_]|$)/i.test(voice.lang)) continue;
    const key = JSON.stringify([voice.voiceURI,voice.name,voice.lang]);
    if (!found.has(key)) found.set(key,{key,name:voice.name,lang:voice.lang,voice,...profile(voice)});
  }
  return [...found.values()].sort((a,b) => a.priority-b.priority || b.quality-a.quality ||
    Number(b.voice.default)-Number(a.voice.default) || Number(/^en[-_]US$/i.test(b.lang))-Number(/^en[-_]US$/i.test(a.lang)) ||
    a.name.localeCompare(b.name) || a.lang.localeCompare(b.lang));
}

export function createLocalReader() {
  let current = null;
  function stop() {
    if (!current) return;
    current = null; // Ignore late events from cancelled utterances.
    const synth = globalThis.speechSynthesis;
    synth.cancel();
    if (synth.paused) synth.resume();
  }
  function start(options, offset = 0) {
    stop();
    // Resolve again at playback time. Never fall back to the browser's default voice.
    const voice = localEnglishVoices().find(v => v.key === options.key)?.voice;
    if (!voice) throw Error('所选本地英语声音已不可用。请重新选择声音并准备朗读。');
    const synth = globalThis.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(options.text.slice(offset));
    const run = {options,utterance,offset,position:offset,state:'playing'};
    current = run;
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = options.rate;
    utterance.onboundary = event => {
      if (current !== run || !Number.isInteger(event.charIndex)) return;
      run.position = Math.max(offset, Math.min(options.text.length-1,offset+event.charIndex));
      options.update();
    };
    utterance.onpause = () => { if (current === run) { run.state = 'paused'; options.update(); } };
    utterance.onresume = () => { if (current === run) { run.state = 'playing'; options.update(); } };
    utterance.onend = () => {
      if (current !== run) return;
      current = null;
      options.end();
    };
    utterance.onerror = () => {
      if (current !== run) return;
      current = null;
      options.error('系统朗读已中断。请点「播放」从本句重试，或选择其他本地英语声音。');
    };
    try {
      if (synth.paused) synth.resume();
      synth.speak(utterance);
    } catch (e) {
      current = null;
      throw e;
    }
    options.update();
  }
  return {
    start,stop,
    get state() { return current?.state || 'idle'; },
    get fraction() { return current ? current.position / current.options.text.length : 0; },
    pause() {
      if (!current || current.state !== 'playing') return;
      current.state = 'paused';
      globalThis.speechSynthesis.pause();
      current?.options.update();
    },
    resume(rate) {
      if (!current || current.state !== 'paused') return;
      if (current.options.rate !== rate) { start({...current.options,rate},current.position); return; }
      current.state = 'playing';
      globalThis.speechSynthesis.resume();
      current?.options.update();
    },
    changeRate(rate) {
      if (current?.state === 'playing' && current.options.rate !== rate) {
        start({...current.options,rate},current.position);
      }
    }
  };
}
