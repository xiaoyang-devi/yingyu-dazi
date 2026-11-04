import {listPracticeCards, loadPracticeCard, deletePracticeCard} from './library.js?v=16';

const id = key => document.getElementById(key);
function node(tag,text,cls) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function action(text,key,value,handler) {
  const btn = node('button',text,'plain');
  btn.type = 'button';
  btn.dataset[key] = value;
  btn.onclick = handler;
  return btn;
}
export function practiceShelf({onOpen,onDelete}) {
  let visit = 0;
  const status = message => { id('libraryStatus').textContent = message; };
  function item(row,ticket) {
    const el = node('article','','shelf-item');
    const caption = node('div','');
    const date = row.createdAt ? new Date(row.createdAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'}) + ' · ' : '';
    const subtitle = row.unavailable ? '这张卡暂时无法读取。' : date + row.lineCount + ' 句 · ' + (row.native ? '系统朗读' : '含配音') + ' · 上次第 ' + ((row.position || 0)+1) + ' 句';
    caption.append(node('strong',row.title),node('p',subtitle,'small'));
    const buttons = node('div','','shelf-actions');
    const open = action('继续听','open',row.id,async () => {
      open.disabled = true;
      try {
        const card = await loadPracticeCard(row.id);
        if (visit === ticket) onOpen(card);
      } catch (error) { if (visit === ticket) status(error.message); }
      finally {open.disabled = !!row.unavailable;}
    });
    open.classList.add('shelf-open');
    open.disabled = !!row.unavailable;
    const remove = action('删除','remove',row.id,() => {
      const cancel = action('取消','cancel',row.id,() => {buttons.replaceChildren(open,remove);remove.focus();});
      const confirm = action('确认删除','confirm',row.id,async () => {
        confirm.disabled = cancel.disabled = true;
        try {
          await deletePracticeCard(row.id);
          onDelete(row.id);
          if (visit === ticket) await refresh();
        } catch (error) {
          if (visit === ticket) status(error.message);
          confirm.disabled = cancel.disabled = false;
        }
      });
      buttons.replaceChildren(confirm,cancel);
      cancel.focus();
    });
    buttons.append(open,remove);
    el.append(caption,buttons);
    return el;
  }
  async function refresh() {
    const ticket = ++visit;
    id('practiceList').replaceChildren();
    id('libraryCount').textContent = '';
    status('正在打开本机练习库…');
    try {
      const rows = await listPracticeCards();
      if (ticket !== visit) return;
      status('');
      id('libraryCount').textContent = rows.length + ' 张';
      if (rows.length) id('practiceList').replaceChildren(...rows.map(row => item(row,ticket)));
      else {
        const empty = node('div','','shelf-empty');
        empty.append(node('strong','你的第一张听力卡会出现在这里'),node('span','生成后点「存入我的练习」，下次就能接着听。','small'));
        id('practiceList').append(empty);
      }
    } catch (error) {if (ticket === visit) status(error.message);}
  }
  return {refresh,leave() { visit++; }};
}
