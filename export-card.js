// Build one audio track from the exact PCM clips used in this listening session.
const rate = 24000;
const gapFrames = Math.round(rate * 0.16);
const maximumBytes = 48 * 1024 * 1024;

async function pcmFrom(blob) {
  if (!(blob instanceof Blob) || blob.size <= 44) throw Error('缺少可保存的录音。');
  const header = await blob.slice(0, 44).arrayBuffer(), view = new DataView(header);
  const label = (offset, length) => String.fromCharCode(...new Uint8Array(header, offset, length));
  if (label(0, 4) !== 'RIFF' || label(8, 8) !== 'WAVEfmt ' || label(36, 4) !== 'data' ||
      view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 ||
      view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== rate ||
      view.getUint16(34, true) !== 16 || view.getUint32(40, true) !== blob.size - 44 ||
      blob.size % 2) throw Error('录音格式不完整，请重新生成后保存。');
  return blob.slice(44);
}

function waveHeader(original, bytes) {
  const view = new DataView(original);
  view.setUint32(4, bytes + 36, true);
  view.setUint32(40, bytes, true);
  return original;
}

function audioBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(Error('浏览器内存不足，请分段保存。'));
    reader.readAsDataURL(blob);
  });
}

export async function buildListeningCard(lines, title) {
  if (!Array.isArray(lines) || !lines.length) throw Error('还没有可保存的对话。');
  const parts = [], cues = [], gap = new Uint8Array(gapFrames * 2);
  let frames = 0;
  for (const line of lines) {
    const pcm = await pcmFrom(line.blob);
    if (cues.length) { parts.push(gap); frames += gapFrames; }
    const start = frames / rate;
    frames += pcm.size / 2;
    if (frames * 2 > maximumBytes) throw Error('对话太长，请将原文分段生成后分别保存。');
    parts.push(pcm);
    cues.push({speaker:line.speaker, zh:line.zh, en:line.en, start, end:frames / rate});
  }
  const template = await fetch(new URL('./offline-player.txt', import.meta.url), {credentials:'omit'});
  if (!template.ok) throw Error('跟读文件模板未载入，请检查网络后再保存。');
  const html = await template.text();
  if (!html.includes('@@EMBEDDED_WAV@@') || !html.includes('@@EMBEDDED_CUES@@')) throw Error('跟读文件模板加载不完整。');
  const header = waveHeader(await lines[0].blob.slice(0, 44).arrayBuffer(), frames * 2);
  const audio = new Blob([header, ...parts], {type:'audio/wav'});
  const metadata = {title: title || '英语对话跟读', duration:frames / rate, cues};
  const escaped = JSON.stringify(metadata).replace(/[<>&\u2028\u2029]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4,'0'));
  const encoded = await audioBase64(audio);
  return new Blob([html.replace('@@EMBEDDED_WAV@@', () => encoded).replace('@@EMBEDDED_CUES@@', () => escaped)], {type:'text/html;charset=utf-8'});
}

export async function downloadListeningCard(lines, title) {
  const file = await buildListeningCard(lines, title);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = (title || '英语听力卡').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 72) + '-双语跟读.html';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}
