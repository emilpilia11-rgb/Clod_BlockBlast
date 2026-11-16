// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: th-large;
/*
 * Подсказчик Block Blast для iPhone (приложение Scriptable).
 * Запуск: быстрая команда «Снимок экрана → Run Script (этот скрипт) → Быстрый просмотр»,
 * повешенная на двойное касание задней панели. Подробности: README.md, раздел iPhone.
 *
 * Файл собран из ios/template.js скриптом ios/build.js — правьте исходники, а не его.
 */
const FM = FileManager.local();
const CFG_PATH = FM.joinPath(FM.documentsDirectory(), 'blockblast-calib.json');

async function say(title, message) {
  const a = new Alert();
  a.title = title; a.message = message; a.addAction('OK');
  await a.present();
}
function loadCalib() {
  if (!FM.fileExists(CFG_PATH)) return null;
  try { return JSON.parse(FM.readString(CFG_PATH)); } catch (e) { return null; }
}
function saveCalib(c) { FM.writeString(CFG_PATH, JSON.stringify(c)); }

async function main() {
  const images = (args.images || []).filter(Boolean);

  // Run inside the Scriptable app: import settings copied from the hint page.
  if (config.runsInApp && !images.length) {
    let clip = '';
    try { clip = Pasteboard.paste() || ''; } catch (e) {}
    let c = null;
    try { c = JSON.parse(clip); } catch (e) {}
    if (c && c.grid && c.tray) {
      saveCalib(c);
      await say('Настройки сохранены', 'Теперь в игре дважды коснитесь задней панели iPhone, чтобы увидеть подсказку.');
      return;
    }
    if (!loadCalib()) {
      await say('Нужны настройки рамок', 'Откройте страницу подсказчика, загрузите один скриншот игры, подгоните рамки и нажмите «Копировать настройки». Затем снова запустите этот скрипт.');
      return;
    }
    // Test run from the app: use the latest screenshot from Photos.
    const shot = await Photos.latestScreenshot();
    if (!shot) { await say('Нет скриншота', 'Для проверки сделайте один скриншот игры.'); return; }
    const out = await analyse(shot, loadCalib());
    if (out) await QuickLook.present(out, true);
    return;
  }

  const calib = loadCalib();
  if (!calib) {
    await say('Нужны настройки рамок', 'Откройте скрипт BlockBlast в приложении Scriptable и следуйте подсказке.');
    return;
  }
  if (!images.length) {
    await say('Нет снимка экрана', 'В быстрой команде первым действием должен быть «Снимок экрана», а его результат передайте в поле Images.');
    return;
  }
  const out = await analyse(images[0], calib);
  if (out) Script.setShortcutOutput(out);
}

async function analyse(image, calib) {
  const b64 = Data.fromJPEG(image).toBase64String();
  const wv = new WebView();
  await wv.loadHTML(HTML);
  const js = `BBOverlay.run('data:image/jpeg;base64,${b64}', ${JSON.stringify(calib)})` +
    `.then(function (r) { completion(r); }, function (e) { completion({ error: String(e) }); });`;
  const res = await wv.evaluateJavaScript(js, true);
  if (!res || res.error) { await say('Ошибка', String(res && res.error)); return null; }
  if (res.learnedRatio && !calib.trayCellRatio) { calib.trayCellRatio = res.learnedRatio; saveCalib(calib); }
  return Image.fromData(Data.fromBase64String(res.img.split(',')[1]));
}

const HTML = __HTML__;

await main();
Script.complete();
