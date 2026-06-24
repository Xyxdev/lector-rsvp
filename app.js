const state = {
  chapters: [],       // [{title, words:[...]}]
  flatIndex: [],      // [{chapterIdx, wordIdx}]
  pos: 0,
  playing: false,
  timer: null,
  basePPM: 320,
  adaptive: true,
  adaptMult: 1.0,
  pauseStreak: 0,
  skipStreak: 0,
  bookTitle: '',
  bookKey: '',
  resumePos: null,
};

const STORAGE_PREFIX = 'rsvp-progress:';

function bookKeyFor(file){
  return file.name + '|' + file.size;
}

function saveProgress(){
  if (!state.bookKey) return;
  try {
    const data = {
      pos: state.pos,
      total: totalWords(),
      basePPM: state.basePPM,
      bookTitle: state.bookTitle,
      updatedAt: Date.now()
    };
    localStorage.setItem(STORAGE_PREFIX + state.bookKey, JSON.stringify(data));
  } catch (e){ /* almacenamiento no disponible, se ignora */ }
}

function loadProgress(key){
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (e){ return null; }
}

function clearProgress(key){
  try { localStorage.removeItem(STORAGE_PREFIX + key); } catch (e){}
}

const els = {};
function cacheEls(){
  ['uploadScreen','readerScreen','fileInput','dropZone','bookTitle','chapterSelect',
   'stage','wordLeft','wordPivot','wordRight','progressFill','progressLabel',
   'playBtn','prevBtn','nextBtn','ppmSlider','ppmValue','adaptiveToggle','liveRate',
   'errorBanner','loadingBanner','resumeBanner','resumeText','resumeBtn','restartBtn',
   'savedBadge'].forEach(id => els[id] = document.getElementById(id));
}

function resolvePath(base, rel){
  if (rel.startsWith('/')) return rel.slice(1);
  const baseParts = base.split('/').filter(Boolean);
  baseParts.pop();
  const relParts = rel.split('/');
  for (const part of relParts){
    if (part === '.' ) continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}

async function parseEpub(file){
  const zip = await JSZip.loadAsync(file);
  const containerXml = await zip.file('META-INF/container.xml').async('text');
  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const rootfile = containerDoc.querySelector('rootfile');
  const opfPath = rootfile.getAttribute('full-path');
  const opfText = await zip.file(opfPath).async('text');
  const opfDoc = new DOMParser().parseFromString(opfText, 'application/xml');

  const titleEl = opfDoc.querySelector('metadata title, title');
  const bookTitle = titleEl ? titleEl.textContent.trim() : file.name.replace(/\.epub$/i,'');

  const manifest = {};
  opfDoc.querySelectorAll('manifest > item').forEach(item => {
    manifest[item.getAttribute('id')] = {
      href: item.getAttribute('href'),
      type: item.getAttribute('media-type') || ''
    };
  });

  const spineIds = Array.from(opfDoc.querySelectorAll('spine > itemref')).map(n => n.getAttribute('idref'));

  const chapters = [];
  let chNum = 0;
  for (const id of spineIds){
    const man = manifest[id];
    if (!man) continue;
    if (!/html|xml/i.test(man.type) && !/\.x?html?$/i.test(man.href)) continue;
    const fullPath = resolvePath(opfPath, man.href);
    const zf = zip.file(fullPath);
    if (!zf) continue;
    const html = await zf.async('text');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style').forEach(n => n.remove());
    const text = doc.body ? doc.body.textContent : doc.documentElement.textContent;
    const words = text.split(/\s+/).map(w => w.trim()).filter(Boolean);
    if (words.length === 0) continue;
    chNum++;
    let chTitle = '';
    const h = doc.querySelector('h1, h2, h3, title');
    chTitle = h ? h.textContent.trim().slice(0,60) : `Capítulo ${chNum}`;
    if (!chTitle) chTitle = `Capítulo ${chNum}`;
    chapters.push({ title: chTitle, words });
  }
  return { bookTitle, chapters };
}

function buildFlatIndex(){
  state.flatIndex = [];
  state.chapters.forEach((ch, ci) => {
    ch.words.forEach((_, wi) => state.flatIndex.push({ chapterIdx: ci, wordIdx: wi }));
  });
}

function totalWords(){ return state.flatIndex.length; }

function currentWord(){
  if (state.pos < 0 || state.pos >= state.flatIndex.length) return null;
  const { chapterIdx, wordIdx } = state.flatIndex[state.pos];
  return state.chapters[chapterIdx].words[wordIdx];
}

function splitPivot(word){
  const clean = word.replace(/^[^\wÀ-ÿ]+|[^\wÀ-ÿ]+$/g, '') || word;
  const len = clean.length;
  let pivotIdx;
  if (len <= 1) pivotIdx = 0;
  else if (len <= 5) pivotIdx = 1;
  else if (len <= 9) pivotIdx = Math.floor(len * 0.35);
  else pivotIdx = Math.floor(len * 0.4);
  const leadTrim = word.length - clean.length ? word.match(/^[^\wÀ-ÿ]*/)[0] : '';
  const left = leadTrim + clean.slice(0, pivotIdx);
  const pivot = clean.slice(pivotIdx, pivotIdx + 1) || ' ';
  const right = clean.slice(pivotIdx + 1) + word.slice(leadTrim.length + clean.length);
  return { left, pivot, right };
}

function delayForWord(word, mult){
  const baseDelay = 60000 / state.basePPM;
  const len = word.replace(/[^\wÀ-ÿ]/g,'').length;
  const lengthFactor = 1 + Math.max(0, len - 6) * 0.05;
  let punctFactor = 1;
  if (/[.!?…]$/.test(word)) punctFactor = 2.0;
  else if (/[,;:]$/.test(word)) punctFactor = 1.4;
  return baseDelay * lengthFactor * punctFactor * mult;
}

function updateProgress(){
  const tot = totalWords();
  const pct = tot ? (state.pos / tot) * 100 : 0;
  els.progressFill.style.width = pct + '%';
  els.progressLabel.textContent = `${state.pos} / ${tot}`;
}

function renderWord(){
  const w = currentWord();
  if (!w){ els.wordLeft.textContent=''; els.wordPivot.textContent=''; els.wordRight.textContent=''; return; }
  const { left, pivot, right } = splitPivot(w);
  els.wordLeft.textContent = left;
  els.wordPivot.textContent = pivot;
  els.wordRight.textContent = right;
  updateProgress();
}

function effectivePPM(){
  return Math.round(state.basePPM / state.adaptMult);
}

function updateLiveRate(){
  els.liveRate.textContent = effectivePPM();
}

function adaptOnPause(){
  if (!state.adaptive) return;
  state.pauseStreak++;
  state.skipStreak = 0;
  if (state.pauseStreak >= 2){
    state.adaptMult = Math.min(1.6, state.adaptMult * 1.12);
    state.pauseStreak = 0;
  }
}

function adaptOnFlow(){
  if (!state.adaptive) return;
  state.skipStreak++;
  state.pauseStreak = 0;
  if (state.skipStreak >= 40){
    state.adaptMult = Math.max(0.7, state.adaptMult * 0.95);
    state.skipStreak = 0;
  }
}

function tick(){
  if (!state.playing) return;
  const w = currentWord();
  if (!w){ pause(); return; }
  renderWord();
  updateLiveRate();
  adaptOnFlow();
  if (state.pos % 20 === 0) saveProgress();
  const delay = delayForWord(w, state.adaptMult);
  state.timer = setTimeout(() => {
    state.pos++;
    if (state.pos >= totalWords()){ pause(); state.pos = totalWords()-1; renderWord(); saveProgress(); return; }
    tick();
  }, delay);
}

function play(){
  if (totalWords() === 0) return;
  state.playing = true;
  els.playBtn.textContent = '⏸';
  els.playBtn.setAttribute('aria-label','Pausar');
  tick();
}

function pause(){
  state.playing = false;
  clearTimeout(state.timer);
  els.playBtn.textContent = '▶';
  els.playBtn.setAttribute('aria-label','Reproducir');
  adaptOnPause();
  saveProgress();
  flashSaved();
}

function togglePlay(){ state.playing ? pause() : play(); }

function stepBack(n=10){
  pause();
  state.pos = Math.max(0, state.pos - n);
  renderWord();
  saveProgress();
}
function stepFwd(n=10){
  pause();
  state.pos = Math.min(totalWords()-1, state.pos + n);
  renderWord();
  saveProgress();
}

function jumpToChapter(ci){
  pause();
  const idx = state.flatIndex.findIndex(f => f.chapterIdx === ci);
  if (idx >= 0) state.pos = idx;
  renderWord();
  saveProgress();
}

function populateChapterSelect(){
  els.chapterSelect.innerHTML = '';
  state.chapters.forEach((ch, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${i+1}. ${ch.title}`;
    els.chapterSelect.appendChild(opt);
  });
}

async function handleFile(file){
  if (!file) return;
  if (!/\.epub$/i.test(file.name)){
    showError('Ese archivo no parece ser un .epub');
    return;
  }
  showLoading(true);
  showError('');
  try {
    const { bookTitle, chapters } = await parseEpub(file);
    if (chapters.length === 0) throw new Error('No se encontró texto legible en el EPUB.');
    state.chapters = chapters;
    state.bookTitle = bookTitle;
    state.bookKey = bookKeyFor(file);
    state.pos = 0;
    state.adaptMult = 1.0;
    buildFlatIndex();
    populateChapterSelect();
    els.bookTitle.textContent = bookTitle;
    els.uploadScreen.classList.add('hidden');
    els.readerScreen.classList.remove('hidden');

    const saved = loadProgress(state.bookKey);
    if (saved && saved.total === totalWords() && saved.pos > 0 && saved.pos < totalWords() - 1){
      state.resumePos = saved.pos;
      if (saved.basePPM){
        state.basePPM = saved.basePPM;
        els.ppmSlider.value = saved.basePPM;
        els.ppmValue.textContent = saved.basePPM;
      }
      const pct = Math.round((saved.pos / saved.total) * 100);
      els.resumeText.textContent = `Quedaste en la palabra ${saved.pos} de ${saved.total} (${pct}%)`;
      els.resumeBanner.classList.remove('hidden');
      state.pos = 0;
      renderWord();
    } else {
      els.resumeBanner.classList.add('hidden');
      renderWord();
    }
    updateLiveRate();
  } catch (err){
    console.error(err);
    showError('No se pudo leer el EPUB. Verifica que el archivo no esté dañado.');
  } finally {
    showLoading(false);
  }
}

function showError(msg){
  els.errorBanner.textContent = msg;
  els.errorBanner.classList.toggle('hidden', !msg);
}
function showLoading(on){
  els.loadingBanner.classList.toggle('hidden', !on);
}

let savedFlashTimer = null;
function flashSaved(){
  if (!els.savedBadge) return;
  els.savedBadge.classList.remove('hidden');
  clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(() => els.savedBadge.classList.add('hidden'), 1400);
}

function initEvents(){
  els.fileInput.addEventListener('change', e => handleFile(e.target.files[0]));
  els.dropZone.addEventListener('click', () => els.fileInput.click());
  els.dropZone.addEventListener('dragover', e => { e.preventDefault(); els.dropZone.classList.add('drag'); });
  els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('drag'));
  els.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    els.dropZone.classList.remove('drag');
    handleFile(e.dataTransfer.files[0]);
  });
  els.playBtn.addEventListener('click', togglePlay);
  els.prevBtn.addEventListener('click', () => stepBack(10));
  els.nextBtn.addEventListener('click', () => stepFwd(10));
  els.stage.addEventListener('click', togglePlay);
  els.chapterSelect.addEventListener('change', e => jumpToChapter(parseInt(e.target.value,10)));
  els.ppmSlider.addEventListener('input', e => {
    state.basePPM = parseInt(e.target.value, 10);
    els.ppmValue.textContent = state.basePPM;
    updateLiveRate();
  });
  els.adaptiveToggle.addEventListener('change', e => { state.adaptive = e.target.checked; });
  els.resumeBtn.addEventListener('click', () => {
    if (state.resumePos != null){
      state.pos = state.resumePos;
      renderWord();
    }
    els.resumeBanner.classList.add('hidden');
  });
  els.restartBtn.addEventListener('click', () => {
    state.pos = 0;
    clearProgress(state.bookKey);
    renderWord();
    els.resumeBanner.classList.add('hidden');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgress();
  });
  window.addEventListener('beforeunload', saveProgress);
  document.addEventListener('keydown', e => {
    if (e.code === 'Space'){ e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowLeft'){ stepBack(10); }
    if (e.code === 'ArrowRight'){ stepFwd(10); }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  cacheEls();
  initEvents();
});
