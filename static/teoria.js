/* ===== Teoria musical de guitarra =====
   Carregado só quando se abre /teoria. Som sintetizado no browser (Karplus-Strong: corda dedilhada),
   sem ficheiros de áudio. Os acordes são gerados a partir de formas testadas e verificados nota a nota. */
(function(){
const tx=o=>typeof o==='string'?o:(o[L]||o.pt);

/* ---------- notas ---------- */
const SH=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FL=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const SOL=['Dó','Dó#','Ré','Ré#','Mi','Fá','Fá#','Sol','Sol#','Lá','Lá#','Si'];
const SOLB=['Dó','Réb','Ré','Mib','Mi','Fá','Solb','Sol','Láb','Lá','Sib','Si'];
const pc=n=>((n%12)+12)%12;
// tonalidades que se escrevem com bemóis
const FLAT_ROOTS=new Set([5,10,3,8,1]);  // F Bb Eb Ab Db
const nn=(n,flat)=>(flat?FL:SH)[pc(n)];
// grafia correta: cada grau usa a letra certa (Cm = C Eb G, não C D# G)
const LET='CDEFGAB',LPC=[0,2,4,5,7,9,11],DEG={0:0,1:1,2:1,3:2,4:2,5:3,6:4,7:4,8:5,9:5,10:6,11:6};
function spell(r,iv,flat,deg){
  const rn=nn(r,flat),li=LET.indexOf(rn[0]),d=deg??DEG[pc(iv)],L2=(li+d)%7,t=pc(r+iv),diff=((t-LPC[L2])%12+18)%12-6;
  return diff===0?LET[L2]:diff===1?LET[L2]+'#':diff===-1?LET[L2]+'b':nn(t,flat)}
const both=n=>SH[pc(n)]===FL[pc(n)]?SH[pc(n)]:SH[pc(n)]+' / '+FL[pc(n)];
const TUNING=[40,45,50,55,59,64];  // E2 A2 D3 G3 B3 E4 (MIDI)
const STR_NAMES=['E','A','D','G','B','e'];
const freq=m=>440*Math.pow(2,(m-69)/12);

/* ---------- som: gravações reais de guitarra acústica (tonejs-instruments, N. Brosowsky, CC BY 3.0),
   uma por meio-tom de D2 a D5 (MIDI 38–74) em /s/guitar/; notas mais agudas são afinadas a partir da mais próxima. ----------
   Se um sample ainda não carregou, usa uma corda sintetizada (Karplus-Strong) para não ficar em silêncio. */
const SMIN=38,SMAX=74,samples={},loading={};
function loadSample(m){
  if(samples[m]||loading[m])return loading[m];
  return loading[m]=fetch('/s/guitar/'+m+'.mp3').then(r=>r.arrayBuffer()).then(b=>new Promise((ok,ko)=>ac().decodeAudioData(b,ok,ko)))
    .then(buf=>samples[m]=buf).catch(()=>{delete loading[m]})}
function preload(){for(let m=SMIN;m<=SMAX;m++)loadSample(m)}
let ctx=null,out=null;const bufs={};
function ac(){
  if(!ctx){ctx=new(window.AudioContext||window.webkitAudioContext)();out=ctx.createGain();out.gain.value=.55;
    const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=5200;
    const comp=ctx.createDynamicsCompressor();out.connect(lp);lp.connect(comp);comp.connect(ctx.destination)}
  if(ctx.state==='suspended')ctx.resume();return ctx}
function pluck(m){
  if(bufs[m])return bufs[m];
  const c=ac(),sr=c.sampleRate,f=freq(m),secs=3.2,len=Math.floor(sr*secs),N=Math.max(2,Math.round(sr/f));
  const b=c.createBuffer(1,len,sr),d=b.getChannelData(0),ring=new Float32Array(N);
  for(let i=0;i<N;i++)ring[i]=Math.random()*2-1;
  for(let k=0;k<2;k++)for(let i=1;i<N;i++)ring[i]=.5*(ring[i]+ring[i-1]);  // ataque mais macio (som de nylon/aço suave)
  const T60=m<52?4.2:m<64?3.2:2.4,rho=Math.pow(.001,1/(f*T60));
  let idx=0,peak=0;
  for(let i=0;i<len;i++){const nx=(idx+1)%N,v=ring[idx];d[i]=v;ring[idx]=rho*.5*(v+ring[nx]);idx=nx;if(Math.abs(v)>peak)peak=Math.abs(v)}
  const fade=Math.floor(sr*.25);for(let i=0;i<fade;i++)d[len-1-i]*=i/fade;
  const g=.6/(peak||1);for(let i=0;i<len;i++)d[i]*=g;
  return bufs[m]=b}
function voice(m){  // [buffer, playbackRate]: o sample mais próximo, afinado se for preciso
  const k=Math.min(SMAX,Math.max(SMIN,m));
  if(samples[k])return[samples[k],Math.pow(2,(m-k)/12),true];
  loadSample(k);return[pluck(m),1,false]}
async function play(midis,{gap=0,at=0,vol=1}={}){  // gap = segundos entre notas (rasgado/arpejo)
  const c=ac();
  await Promise.race([Promise.all(midis.map(m=>loadSample(Math.min(SMAX,Math.max(SMIN,m))))),new Promise(r=>setTimeout(r,700))]);
  const t0=c.currentTime+.03+at;
  midis.forEach((m,i)=>{const[buf,rate,real]=voice(m),s=c.createBufferSource(),g=c.createGain(),t=t0+i*gap;
    s.buffer=buf;s.playbackRate.value=rate;
    const v=vol*(midis.length>3?.5:.85)*(real?1.4:1)*(gap&&gap<.1?(.85+Math.random()*.3):1);
    g.gain.setValueAtTime(v,t);if(!real||gap>.2)g.gain.setTargetAtTime(0,t+(gap>.2?1.4:2.6),.4);  // deixa soar e apaga suavemente
    s.connect(g);g.connect(out);s.start(t);s.stop(t+5)})}
const strum=midis=>play(midis,{gap:.032});
const arp=midis=>play(midis,{gap:.28});

/* ---------- acordes ---------- */
const TYPES=[
 {k:'',     f:[0,4,7],   n:{pt:'maior',en:'major'}},
 {k:'m',    f:[0,3,7],   n:{pt:'menor',en:'minor'}},
 {k:'7',    f:[0,4,7,10],n:{pt:'sétima (dominante)',en:'dominant seventh'}},
 {k:'maj7', f:[0,4,7,11],n:{pt:'sétima maior',en:'major seventh'}},
 {k:'m7',   f:[0,3,7,10],n:{pt:'menor com sétima',en:'minor seventh'}},
 {k:'6',    f:[0,4,7,9], n:{pt:'sexta',en:'sixth'}},
 {k:'m6',   f:[0,3,7,9], n:{pt:'menor com sexta',en:'minor sixth'}},
 {k:'sus2', f:[0,2,7],   n:{pt:'suspenso de 2.ª',en:'suspended 2nd'}},
 {k:'sus4', f:[0,5,7],   n:{pt:'suspenso de 4.ª',en:'suspended 4th'}},
 {k:'7sus4',f:[0,5,7,10],n:{pt:'sétima suspensa',en:'seventh sus4'}},
 {k:'add9', f:[0,4,7,2], n:{pt:'com nona adicionada',en:'added ninth'}},
 {k:'madd9',f:[0,3,7,2], n:{pt:'menor com nona adicionada',en:'minor added ninth'}},
 {k:'9',    f:[0,4,7,10,2],n:{pt:'nona (dominante)',en:'dominant ninth'}},
 {k:'dim',  f:[0,3,6],   n:{pt:'diminuto',en:'diminished'}},
 {k:'dim7', f:[0,3,6,9], n:{pt:'diminuto com sétima',en:'diminished seventh'}},
 {k:'m7b5', f:[0,3,6,10],n:{pt:'meio-diminuto',en:'half-diminished'}},
 {k:'aug',  f:[0,4,8],   n:{pt:'aumentado',en:'augmented'}},
 {k:'5',    f:[0,7],     n:{pt:'power chord (quinta)',en:'power chord (fifth)'}}];
const X=null;
// formas móveis: deslocamento de cada corda (E A D G B e) a partir da casa da tónica
const SHAPES={  // [corda da tónica, formas]
 E:{'':[0,2,2,1,0,0],m:[0,2,2,0,0,0],'7':[0,2,0,1,0,0],maj7:[0,X,1,1,0,X],m7:[0,2,0,0,0,0],'6':[0,2,2,1,2,0],m6:[0,2,2,0,2,0],
    sus2:[0,2,4,4,X,X],sus4:[0,2,2,2,0,0],'7sus4':[0,2,0,2,0,0],add9:[0,2,2,1,0,2],madd9:[0,2,4,0,0,2],'9':[0,2,0,1,0,2],
    dim:[0,1,2,0,X,X],dim7:[0,1,2,0,2,0],m7b5:[0,1,2,0,3,0],aug:[0,3,2,1,1,0],'5':[0,2,2,X,X,X]},
 A:{'':[X,0,2,2,2,0],m:[X,0,2,2,1,0],'7':[X,0,2,0,2,0],maj7:[X,0,2,1,2,0],m7:[X,0,2,0,1,0],'6':[X,0,2,2,2,2],m6:[X,0,2,2,1,2],
    sus2:[X,0,2,2,0,0],sus4:[X,0,2,2,3,0],'7sus4':[X,0,2,0,3,0],add9:[X,0,2,4,2,0],madd9:[X,0,2,4,1,0],'9':[X,0,2,4,2,3],
    dim:[X,0,1,2,1,X],dim7:[X,0,1,2,1,2],m7b5:[X,0,1,0,1,X],aug:[X,0,3,2,2,1],'5':[X,0,2,2,X,X]},
 D:{'':[X,X,0,2,3,2],m:[X,X,0,2,3,1],'7':[X,X,0,2,1,2],maj7:[X,X,0,2,2,2],m7:[X,X,0,2,1,1],sus2:[X,X,0,2,3,0],sus4:[X,X,0,2,3,3],
    '6':[X,X,0,2,0,2],m6:[X,X,0,2,0,1],dim:[X,X,0,1,3,1],aug:[X,X,0,3,3,2],'5':[X,X,0,2,3,X]}};
const ROOT_STR={E:0,A:1,D:2};
// acordes abertos clássicos (posições absolutas)
const OPEN={'C':[X,3,2,0,1,0],'C7':[X,3,2,3,1,0],'Cmaj7':[X,3,2,0,0,0],'Cadd9':[X,3,2,0,3,0],'Csus2':[X,3,0,0,1,X],'Csus4':[X,3,3,0,1,1],
 'G':[3,2,0,0,0,3],'G7':[3,2,0,0,0,1],'Gmaj7':[3,2,0,0,0,2],'G6':[3,2,0,0,0,0],'Gadd9':[3,0,0,2,0,3],'Gsus4':[3,3,0,0,1,3],
 'F':[1,3,3,2,1,1],'Fmaj7':[X,X,3,2,1,0],'Dm':[X,X,0,2,3,1],'Am7':[X,0,2,0,1,0],'Em7':[0,2,0,0,0,0],'B7':[X,2,1,2,0,2],'E7':[0,2,0,1,0,0],'A7':[X,0,2,0,2,0]};
const chordName=(r,k,flat)=>nn(r,flat)+k;
function check(frets,r,f){  // as notas tocadas são exatamente as do acorde e a mais grave é a tónica?
  const ms=frets.map((x,s)=>x==null?null:TUNING[s]+x).filter(x=>x!=null);if(ms.length<2)return false;
  const want=new Set(f.map(i=>pc(r+i))),got=new Set(ms.map(pc));
  if(pc(Math.min(...ms))!==pc(r))return false;
  return got.size===want.size&&[...got].every(x=>want.has(x))}
function voicings(r,t){
  const out=[],seen=new Set(),add=(frets,open)=>{const key=frets.join();if(seen.has(key)||frets.some(x=>x!=null&&(x<0||x>17)))return;
    if(!check(frets,r,t.f))return;seen.add(key);out.push({frets,open})};
  for(const nm of [SH[r]+t.k,FL[r]+t.k])if(OPEN[nm])add(OPEN[nm],true);
  const cands=[];
  for(const s in SHAPES){const sh=SHAPES[s][t.k];if(!sh)continue;
    let base=pc(r-TUNING[ROOT_STR[s]]);
    for(const b of [base,base+12])if(b<=12)cands.push(sh.map(o=>o==null?null:o+b))}
  cands.sort((a,b)=>Math.max(...a.filter(x=>x!=null))-Math.max(...b.filter(x=>x!=null)));
  cands.forEach(c=>add(c,false));
  return out.slice(0,4)}
const midisOf=frets=>frets.map((x,s)=>x==null?null:TUNING[s]+x).filter(x=>x!=null);

/* ---------- diagrama de acorde (SVG) ---------- */
function diagram(frets){
  const used=frets.filter(x=>x!=null&&x>0),hi=used.length?Math.max(...used):0,lo=used.length?Math.min(...used):0;
  const base=hi<=4?1:lo,rows=Math.max(4,hi-base+1);
  const W=118,sx=16,sw=17,top=24,fh=22,H=top+rows*fh+14;
  let g=`<svg class="chd" viewBox="0 0 ${W} ${H}" role="img" aria-label="${frets.map(x=>x==null?'x':x).join(' ')}">`;
  g+=base===1?`<rect x="${sx-1}" y="${top-4}" width="${sw*5+2}" height="4" fill="currentColor"/>`:`<text x="${sx+sw*5+6}" y="${top+fh*.68}" class="bf">${base}</text>`;
  for(let i=0;i<=rows;i++)g+=`<line x1="${sx}" x2="${sx+sw*5}" y1="${top+i*fh}" y2="${top+i*fh}" class="fr"/>`;
  for(let s=0;s<6;s++)g+=`<line x1="${sx+s*sw}" x2="${sx+s*sw}" y1="${top}" y2="${top+rows*fh}" class="st"/>`;
  // pestana: a casa mais baixa repetida em cordas seguidas a partir da tónica
  if(base>1||lo>0){const idx=frets.map((x,s)=>x===lo?s:-1).filter(s=>s>=0);
    if(idx.length>=2){const a=idx[0],b=idx[idx.length-1];if(frets.slice(a,b+1).every(x=>x==null||x>=lo))
      g+=`<rect x="${sx+a*sw-6}" y="${top+(lo-base)*fh+fh/2-6}" width="${(b-a)*sw+12}" height="12" rx="6" class="dot"/>`}}
  frets.forEach((x,s)=>{const cx=sx+s*sw;
    if(x==null)g+=`<text x="${cx}" y="${top-9}" class="mk">×</text>`;
    else if(x===0)g+=`<circle cx="${cx}" cy="${top-13}" r="4" class="op"/>`;
    else g+=`<circle cx="${cx}" cy="${top+(x-base)*fh+fh/2}" r="6.2" class="dot"/>`});
  return g+'</svg>'}

/* ---------- escalas e intervalos ---------- */
const INTERVALS=[
 [0,{pt:'Uníssono',en:'Unison'},'P1'],[1,{pt:'2.ª menor (meio-tom)',en:'Minor 2nd (half step)'},'m2'],[2,{pt:'2.ª maior (tom)',en:'Major 2nd (whole step)'},'M2'],
 [3,{pt:'3.ª menor',en:'Minor 3rd'},'m3'],[4,{pt:'3.ª maior',en:'Major 3rd'},'M3'],[5,{pt:'4.ª perfeita',en:'Perfect 4th'},'P4'],
 [6,{pt:'4.ª aumentada / 5.ª diminuta (trítono)',en:'Tritone (aug 4th / dim 5th)'},'TT'],[7,{pt:'5.ª perfeita',en:'Perfect 5th'},'P5'],
 [8,{pt:'6.ª menor',en:'Minor 6th'},'m6'],[9,{pt:'6.ª maior',en:'Major 6th'},'M6'],[10,{pt:'7.ª menor',en:'Minor 7th'},'m7'],
 [11,{pt:'7.ª maior',en:'Major 7th'},'M7'],[12,{pt:'Oitava',en:'Octave'},'P8']];
const SCALES=[
 {k:'maior',f:[0,2,4,5,7,9,11],n:{pt:'Maior (jónio)',en:'Major (Ionian)'},d:{pt:'A escala base da música ocidental: alegre, estável.',en:'The backbone of Western music: bright and stable.'}},
 {k:'menor',f:[0,2,3,5,7,8,10],n:{pt:'Menor natural (eólio)',en:'Natural minor (Aeolian)'},d:{pt:'Mais sombria e melancólica.',en:'Darker and more melancholic.'}},
 {k:'pentam',f:[0,3,5,7,10],n:{pt:'Pentatónica menor',en:'Minor pentatonic'},d:{pt:'5 notas — a escala de solo mais usada no rock e blues.',en:'5 notes — the go-to soloing scale in rock and blues.'}},
 {k:'pentaM',f:[0,2,4,7,9],n:{pt:'Pentatónica maior',en:'Major pentatonic'},d:{pt:'Doce e aberta; country, pop, soul.',en:'Sweet and open; country, pop, soul.'}},
 {k:'blues',f:[0,3,5,6,7,10],n:{pt:'Blues',en:'Blues'},d:{pt:'Pentatónica menor + a "blue note" (5.ª diminuta).',en:'Minor pentatonic + the "blue note" (flat 5th).'}},
 {k:'harm',f:[0,2,3,5,7,8,11],n:{pt:'Menor harmónica',en:'Harmonic minor'},d:{pt:'Menor com 7.ª maior: som clássico/oriental.',en:'Minor with a major 7th: classical / exotic sound.'}},
 {k:'mel',f:[0,2,3,5,7,9,11],n:{pt:'Menor melódica',en:'Melodic minor'},d:{pt:'Menor com 6.ª e 7.ª maiores; muito usada no jazz.',en:'Minor with major 6th and 7th; a jazz staple.'}},
 {k:'dor',f:[0,2,3,5,7,9,10],n:{pt:'Dórico',en:'Dorian'},d:{pt:'Menor com 6.ª maior: funk, jazz, Santana.',en:'Minor with a major 6th: funk, jazz, Santana.'}},
 {k:'fri',f:[0,1,3,5,7,8,10],n:{pt:'Frígio',en:'Phrygian'},d:{pt:'Menor com 2.ª menor: flamenco, metal.',en:'Minor with a flat 2nd: flamenco, metal.'}},
 {k:'lid',f:[0,2,4,6,7,9,11],n:{pt:'Lídio',en:'Lydian'},d:{pt:'Maior com 4.ª aumentada: sonhador, cinematográfico.',en:'Major with a sharp 4th: dreamy, cinematic.'}},
 {k:'mix',f:[0,2,4,5,7,9,10],n:{pt:'Mixolídio',en:'Mixolydian'},d:{pt:'Maior com 7.ª menor: rock clássico, blues.',en:'Major with a flat 7th: classic rock, blues.'}},
 {k:'loc',f:[0,1,3,5,6,8,10],n:{pt:'Lócrio',en:'Locrian'},d:{pt:'O modo mais instável (5.ª diminuta).',en:'The most unstable mode (flat 5th).'}},
 {k:'crom',f:[0,1,2,3,4,5,6,7,8,9,10,11],n:{pt:'Cromática',en:'Chromatic'},d:{pt:'Todas as 12 notas.',en:'All 12 notes.'}}];
const stepName=d=>d===1?(L==='en'?'H':'S'):d===2?'T':d===3?'T½':String(d);

/* ---------- braço interativo ---------- */
function fretboard({mark=null,root=null,frets=15,flat=false,id='fb'}={}){
  let h=`<div class="fbwrap"><div class="gfb" id="${id}" style="--n:${frets+1}">`;
  for(let s=5;s>=0;s--){
    h+=`<span class="sl mono">${STR_NAMES[s]}</span>`;
    for(let f=0;f<=frets;f++){const m=TUNING[s]+f,p=pc(m),on=!mark||mark.has(p);
      h+=`<button class="fc${f===0?' nut':''}${mark&&on?' on':''}${root!=null&&p===root?' rt':''}${!mark&&SH[p].length===1?' nat':''}" data-m="${m}" title="${both(m)}"><i>${on?nn(m,flat):''}</i></button>`}}
  h+=`<span class="sl"></span>`;for(let f=0;f<=frets;f++)h+=`<span class="fn mono">${[3,5,7,9,12,15].includes(f)?f:''}</span>`;
  return h+'</div></div>'}

/* ---------- campo harmónico ---------- */
const MAJ_DEG=[[0,'',  'I'],[2,'m','ii'],[4,'m','iii'],[5,'','IV'],[7,'','V'],[9,'m','vi'],[11,'dim','vii°']];
const MIN_DEG=[[0,'m','i'],[2,'dim','ii°'],[3,'','III'],[5,'m','iv'],[7,'m','v'],[8,'','VI'],[10,'','VII']];
const PROGS=[
 {n:'I – V – vi – IV',d:{pt:'A progressão do pop (Let It Be, Someone Like You…)',en:'The pop progression (Let It Be, Someone Like You…)'},s:[0,4,5,3],min:false},
 {n:'I – vi – IV – V',d:{pt:'Anos 50 / doo-wop (Stand By Me)',en:'50s / doo-wop (Stand By Me)'},s:[0,5,3,4],min:false},
 {n:'ii – V – I',d:{pt:'A cadência do jazz',en:'The jazz cadence'},s:[1,4,0],min:false,sev:true},
 {n:'I – IV – V',d:{pt:'Rock and roll, folk, country',en:'Rock and roll, folk, country'},s:[0,3,4,0],min:false},
 {n:'vi – IV – I – V',d:{pt:'Versão "menor" da do pop',en:'The "minor" take on the pop progression'},s:[5,3,0,4],min:false},
 {n:'i – VII – VI – VII',d:{pt:'Rock épico / andaluz',en:'Epic rock'},s:[0,6,5,6],min:true},
 {n:'i – iv – v',d:{pt:'Menor clássica',en:'Classic minor'},s:[0,3,4,0],min:true},
 {n:'Blues 12 compassos',en_n:'12-bar blues',d:{pt:'I7 ×4 · IV7 ×2 · I7 ×2 · V7 · IV7 · I7 · V7',en:'I7 ×4 · IV7 ×2 · I7 ×2 · V7 · IV7 · I7 · V7'},blues:true}];
function chordMidis(r,k){const t=TYPES.find(x=>x.k===k),v=voicings(pc(r),t)[0];return v?midisOf(v.frets):t.f.map(i=>48+pc(r)+i)}
let seqTimer=[];
function playSeq(chords,beat=1.15){seqTimer.forEach(clearTimeout);seqTimer=[];
  chords.forEach(([r,k],i)=>{seqTimer.push(setTimeout(()=>{strum(chordMidis(r,k));
    document.querySelectorAll('.seq i').forEach((el,j)=>el.classList.toggle('on',j===i))},i*beat*1000))});
  seqTimer.push(setTimeout(()=>document.querySelectorAll('.seq i').forEach(el=>el.classList.remove('on')),chords.length*beat*1000))}

/* ---------- estado e textos ---------- */
const S={root:0,type:'all',sRoot:9,scale:'pentam',key:0,minor:false};
const TOPICS=[
 ['notas',{pt:'Notas & braço',en:'Notes & fretboard'}],
 ['acordes',{pt:'Acordes',en:'Chords'}],
 ['intervalos',{pt:'Intervalos',en:'Intervals'}],
 ['escalas',{pt:'Escalas & modos',en:'Scales & modes'}],
 ['campo',{pt:'Campo harmónico',en:'Harmonic field'}],
 ['progressoes',{pt:'Progressões',en:'Progressions'}],
 ['quintas',{pt:'Círculo de quintas',en:'Circle of fifths'}],
 ['ritmo',{pt:'Ritmo & compasso',en:'Rhythm & time'}],
 ['generos',{pt:'Géneros musicais',en:'Music genres'}],
 ['instrumentos',{pt:'Instrumentos',en:'Instruments'}]];
const PLAY='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const pbtn=(attr,label='')=>`<button class="pl" ${attr} aria-label="play">${PLAY}${label?`<span>${label}</span>`:''}</button>`;
const rootPicker=(cur,act,flatAware)=>`<div class="roots">${SH.map((_,i)=>`<button class="${i===cur?'on':''}" data-act="${act}" data-v="${i}">${both(i)}</button>`).join('')}</div>`;
const P=(pt,en)=>`<p>${L==='en'?en:pt}</p>`;

const SECTIONS={
 notas(){
  return `<h2 class="disp">${tx(TOPICS[0][1])}</h2>`
   +P('A música ocidental usa <b>12 notas</b>. Sete são "naturais" (C D E F G A B — Dó Ré Mi Fá Sol Lá Si) e as outras cinco ficam entre elas, com dois nomes: <b>sustenido (#)</b> sobe meio-tom, <b>bemol (b)</b> desce meio-tom. Entre E–F e B–C não há nota no meio.',
      'Western music uses <b>12 notes</b>. Seven are "natural" (C D E F G A B) and the other five sit between them, each with two names: a <b>sharp (#)</b> raises by a half step, a <b>flat (b)</b> lowers by a half step. There is no note between E–F or B–C.')
   +P('Na guitarra, cada casa é <b>meio-tom</b>. Na casa 12 as notas repetem-se uma oitava acima.','On the guitar each fret is a <b>half step</b>. At the 12th fret the notes repeat one octave higher.')
   +`<h3 class="mono">${L==='en'?'The 12 notes':'As 12 notas'}</h3><div class="notes12">`
   +SH.map((_,i)=>`<button class="n12${SH[i].length>1?' acc':''}" data-midi="${60+i}"><b>${both(i)}</b><small>${SOL[i]===SOLB[i]?SOL[i]:SOL[i]+' / '+SOLB[i]}</small></button>`).join('')+`</div>`
   +`<h3 class="mono">${L==='en'?'Standard tuning — open strings':'Afinação padrão — cordas soltas'}</h3>`
   +P('Da corda mais grossa (6.ª) para a mais fina (1.ª): <b>E A D G B E</b> — Mi Lá Ré Sol Si Mi. Toca cada uma para afinar de ouvido.','From the thickest (6th) to the thinnest (1st) string: <b>E A D G B E</b>. Play each one to tune by ear.')
   +`<div class="tune">${TUNING.map((m,s)=>pbtn(`data-midi="${m}"`,`${6-s}.ª · ${SH[pc(m)]}`)).join('')}${pbtn(`data-strum="${TUNING.join(',')}"`,L==='en'?'all':'todas')}</div>`
   +`<h3 class="mono">${L==='en'?'Every note on the fretboard — tap to hear':'Todas as notas do braço — toca para ouvir'}</h3>`
   +fretboard({})
   +P('<small>As notas naturais estão destacadas. Dica: aprende primeiro as notas das cordas E e A — são as que dão nome aos acordes com pestana.</small>','<small>Natural notes are highlighted. Tip: learn the notes on the E and A strings first — they name your barre chords.</small>')},

 acordes(){
  const r=S.root,flat=FLAT_ROOTS.has(r),types=S.type==='all'?TYPES:TYPES.filter(t=>t.k===S.type);
  let h=`<h2 class="disp">${tx(TOPICS[1][1])}</h2>`
   +P('Escolhe a <b>tónica</b> e vês todos os tipos de acorde, com o desenho no braço e as notas. Carrega em ▶ para ouvir rasgado, ou em "arpejo" para ouvir nota a nota. Muitos acordes têm várias posições.',
      'Pick a <b>root</b> to see every chord type, with its fretboard shape and notes. Press ▶ to hear it strummed, or "arpeggio" to hear it note by note. Many chords have several positions.')
   +P('<small>Como ler o diagrama: as linhas verticais são as cordas (a 6.ª, mais grave, à esquerda); ○ = corda solta; × = não tocar; o número ao lado é a casa onde começa; a barra comprida é uma pestana.</small>',
      '<small>How to read it: vertical lines are strings (low 6th on the left); ○ = open string; × = don\'t play; the side number is the starting fret; a long bar is a barre.</small>')
   +rootPicker(r,'root')
   +`<div class="types"><button class="${S.type==='all'?'on':''}" data-act="type" data-v="all">${L==='en'?'all':'todos'}</button>${TYPES.map(t=>`<button class="${S.type===t.k?'on':''}" data-act="type" data-v="${t.k}">${t.k||(L==='en'?'major':'maior')}</button>`).join('')}</div>`
   +`<div class="chords">`;
  for(const t of types){const vs=voicings(r,t),notes=t.f.map(i=>spell(r,i,flat,t.k==='aug'&&i===8?4:undefined));
    h+=`<div class="chord"><div class="ch-h"><b class="disp">${chordName(r,t.k,flat)}</b><small>${tx(t.n)}</small></div>`
     +`<div class="vs">${vs.map((v,j)=>`<div class="v${j?'':' on'}" data-f="${v.frets.map(x=>x==null?'x':x).join(',')}">${diagram(v.frets)}</div>`).join('')}</div>`
     +`<div class="ch-n mono">${notes.join(' · ')}</div>`
     +`<div class="ch-a">${pbtn('data-chord')}<button class="ar mono" data-arp>${L==='en'?'arpeggio':'arpejo'}</button>${vs.length>1?`<button class="nx mono" data-next>${L==='en'?'position':'posição'} <span>1</span>/${vs.length}</button>`:''}</div></div>`}
  return h+'</div>'},

 intervalos(){
  return `<h2 class="disp">${tx(TOPICS[2][1])}</h2>`
   +P('Um <b>intervalo</b> é a distância entre duas notas, medida em meios-tons (casas). É com intervalos que se constroem escalas e acordes: um acorde maior, por exemplo, é tónica + 3.ª maior + 5.ª perfeita.',
      'An <b>interval</b> is the distance between two notes, measured in half steps (frets). Scales and chords are built from intervals: a major chord, for example, is root + major 3rd + perfect 5th.')
   +P('<small>Exemplos a partir de C (Dó). ▶ toca as duas notas seguidas e depois juntas.</small>','<small>Examples from C. ▶ plays the two notes one after another, then together.</small>')
   +`<table class="tbl"><thead><tr><th>${L==='en'?'Semitones':'Meios-tons'}</th><th>${L==='en'?'Interval':'Intervalo'}</th><th></th><th>${L==='en'?'Example':'Exemplo'}</th><th></th></tr></thead><tbody>`
   +INTERVALS.map(([s,n,ab])=>`<tr><td class="mono">${s}</td><td>${tx(n)}</td><td class="mono">${ab}</td><td>C → ${SH[pc(s)]}</td><td>${pbtn(`data-int="${s}"`)}</td></tr>`).join('')+'</tbody></table>'
   +P('<small>Na guitarra: a 5.ª perfeita fica sempre na corda de baixo, 2 casas à frente (é o "power chord"); a oitava fica duas cordas abaixo e duas casas à frente.</small>',
      '<small>On guitar: the perfect 5th is always on the next string down, 2 frets up (the "power chord"); the octave is two strings down and two frets up.</small>')},

 escalas(){
  const sc=SCALES.find(x=>x.k===S.scale),r=S.sRoot,flat=FLAT_ROOTS.has(r),ns=sc.f.map((i,j)=>spell(r,i,flat,sc.f.length===7?j:undefined));
  const steps=sc.f.map((x,i)=>(sc.f[i+1]??12)-x).map(stepName).join(' – ');
  return `<h2 class="disp">${tx(TOPICS[3][1])}</h2>`
   +P('Uma <b>escala</b> é um conjunto de notas, por ordem, a partir de uma tónica. O que a define é o padrão de distâncias (T = tom, S = meio-tom). Os <b>modos</b> são a escala maior a começar noutra nota.',
      'A <b>scale</b> is an ordered set of notes from a root. What defines it is its pattern of steps (W = whole, H = half). <b>Modes</b> are the major scale started on a different note.')
   +rootPicker(r,'sroot')
   +`<div class="types">${SCALES.map(s=>`<button class="${s.k===S.scale?'on':''}" data-act="scale" data-v="${s.k}">${tx(s.n)}</button>`).join('')}</div>`
   +`<div class="scbox"><div><b class="disp">${nn(r,flat)} ${tx(sc.n)}</b><p><small>${tx(sc.d)}</small></p>`
   +`<p class="mono">${ns.join(' · ')}</p><p class="mono dim">${(L==='en'?steps.replace(/T/g,'W'):steps)}</p></div>`
   +`<div class="ch-a">${pbtn(`data-scale="${sc.f.map(i=>(r<4?52:40)+r+i).concat([(r<4?52:40)+r+12]).join(',')}"`,L==='en'?'up':'subir')}${pbtn(`data-scale="${sc.f.map(i=>(r<4?52:40)+r+i).concat([(r<4?52:40)+r+12]).reverse().join(',')}"`,L==='en'?'down':'descer')}</div></div>`
   +fretboard({mark:new Set(sc.f.map(i=>pc(r+i))),root:r,flat})
   +P('<small>A tónica está a cheio. Toca qualquer casa para a ouvir.</small>','<small>The root is filled in. Tap any fret to hear it.</small>')},

 campo(){
  const r=S.key,mi=S.minor,deg=mi?MIN_DEG:MAJ_DEG,flat=FLAT_ROOTS.has(mi?pc(r+3):r);
  return `<h2 class="disp">${tx(TOPICS[4][1])}</h2>`
   +P('O <b>campo harmónico</b> são os acordes que nascem de cada nota da escala, empilhando terceiras. Numa tonalidade maior o padrão é sempre o mesmo: <b>maior – menor – menor – maior – maior – menor – diminuto</b>. É por isso que certos acordes "soam bem juntos".',
      'The <b>harmonic field</b> is the set of chords built on each note of the scale by stacking thirds. In a major key the pattern is always: <b>major – minor – minor – major – major – minor – diminished</b>. That is why certain chords "sound right together".')
   +rootPicker(r,'key')
   +`<div class="types"><button class="${!mi?'on':''}" data-act="minor" data-v="0">${L==='en'?'major key':'tom maior'}</button><button class="${mi?'on':''}" data-act="minor" data-v="1">${L==='en'?'minor key':'tom menor'}</button></div>`
   +`<div class="field">${deg.map(([d,k,rn])=>`<button class="fd" data-ch="${pc(r+d)}|${k}"><span class="mono">${rn}</span><b class="disp">${chordName(pc(r+d),k,flat)}</b></button>`).join('')}</div>`
   +`<div class="ch-a">${pbtn(`data-seq="${deg.map(([d,k])=>pc(r+d)+'|'+k).join(';')}"`,L==='en'?'play all':'tocar todos')}</div>`
   +P('<small>Graus em numeração romana: maiúsculas = maior, minúsculas = menor, ° = diminuto. A tonalidade menor relativa de uma maior começa no 6.º grau (C maior ↔ A menor).</small>',
      '<small>Roman numerals: upper case = major, lower case = minor, ° = diminished. The relative minor of a major key starts on the 6th degree (C major ↔ A minor).</small>')},

 progressoes(){
  const r=S.key,flat=FLAT_ROOTS.has(r);
  const mk=p=>p.blues?[0,0,0,0,5,5,0,0,7,5,0,7].map(d=>[pc(r+d),'7']):p.s.map(i=>{const [d,k]=(p.min?MIN_DEG:MAJ_DEG)[i];return[pc(r+d),p.sev?(k==='m'?'m7':k==='dim'?'m7b5':i===0?'maj7':'7'):k]});
  return `<h2 class="disp">${tx(TOPICS[5][1])}</h2>`
   +P('As mesmas progressões aparecem em milhares de canções. Escolhe a tonalidade e carrega em ▶: os acordes acendem à medida que tocam.',
      'The same progressions show up in thousands of songs. Pick a key and press ▶: each chord lights up as it plays.')
   +rootPicker(r,'key')
   +`<div class="progs">${PROGS.map(p=>{const cs=mk(p);return `<div class="prog"><div><b>${p.blues&&L==='en'?p.en_n:p.n}</b><small>${tx(p.d)}</small></div>`
     +`<div class="seq mono">${cs.map(([cr,k])=>`<i>${chordName(cr,k,flat||(p.min&&FLAT_ROOTS.has(pc(r+3))))}</i>`).join('')}</div>${pbtn(`data-seq="${cs.map(c=>c.join('|')).join(';')}"`)}</div>`}).join('')}</div>`},

 quintas(){
  const R=150,c=170,maj=[],keys=[0,7,2,9,4,11,6,1,8,3,10,5];
  let g=`<svg class="cof" viewBox="0 0 340 340">`
   +`<circle cx="${c}" cy="${c}" r="${R+12}" class="ring"/><circle cx="${c}" cy="${c}" r="${R-38}" class="ring"/><circle cx="${c}" cy="${c}" r="${R-90}" class="ring"/>`;
  keys.forEach((k,i)=>{const a=(i/12)*Math.PI*2-Math.PI/2,x=c+Math.cos(a)*(R-14),y=c+Math.sin(a)*(R-14),x2=c+Math.cos(a)*(R-64),y2=c+Math.sin(a)*(R-64);
    const flat=i>=6&&i!==6,mn=pc(k+9);
    g+=`<g class="cofk" data-ch="${k}|"><circle cx="${x}" cy="${y}" r="21"/><text x="${x}" y="${y+6}">${i===6?'F#':nn(k,flat)}</text></g>`
     +`<g class="cofk mi" data-ch="${mn}|m"><circle cx="${x2}" cy="${y2}" r="17"/><text x="${x2}" y="${y2+5}">${(i===6?'D#':nn(mn,flat))}m</text></g>`});
  g+=`<text x="${c}" y="${c+5}" class="cofc">${L==='en'?'fifths':'quintas'}</text></svg>`;
  return `<h2 class="disp">${tx(TOPICS[6][1])}</h2>`
   +P('Andando no sentido do relógio, cada tonalidade fica uma <b>5.ª acima</b> da anterior e ganha um sustenido; no sentido contrário, uma 4.ª acima e ganha um bemol. Por dentro estão as <b>relativas menores</b>. Tonalidades vizinhas partilham quase todas as notas — por isso os acordes vizinhos no círculo combinam tão bem.',
      'Going clockwise, each key is a <b>5th above</b> the previous and adds a sharp; anticlockwise, a 4th above and adds a flat. Inside are the <b>relative minors</b>. Neighbouring keys share almost all their notes — which is why neighbouring chords on the circle sound so good together.')
   +`<div class="cofwrap">${g}</div>`+P('<small>Toca em qualquer acorde do círculo para o ouvir.</small>','<small>Tap any chord on the circle to hear it.</small>')},

 ritmo(){
  return `<h2 class="disp">${tx(TOPICS[7][1])}</h2>`
   +P('O <b>compasso</b> diz quantos tempos tem cada "medida". O mais comum é o <b>4/4</b> (conta-se 1-2-3-4); a valsa é <b>3/4</b>; o <b>6/8</b> tem um balanço a dois tempos, cada um dividido em três.',
      'The <b>time signature</b> says how many beats each bar has. The most common is <b>4/4</b> (count 1-2-3-4); a waltz is <b>3/4</b>; <b>6/8</b> swings in two beats, each split in three.')
   +`<div class="rhy">${[['4/4',[1,0,0,0],'↓ ↓ ↑ ↑ ↓ ↑'],['3/4',[1,0,0],'↓ ↓ ↑ ↓ ↑'],['6/8',[1,0,0,.6,0,0],'↓ ↑ ↓ ↓ ↑ ↓']].map(([n,acc,pat])=>
     `<div class="prog"><div><b class="disp">${n}</b><small class="mono">${L==='en'?'strum':'rasgado'}: ${pat}</small></div>${pbtn(`data-metro="${acc.join(',')}" data-sig="${n}"`,L==='en'?'count':'contar')}</div>`).join('')}</div>`
   +`<h3 class="mono">${L==='en'?'Note values':'Figuras rítmicas'}</h3><table class="tbl"><tbody>`
   +[[{pt:'Semibreve',en:'Whole note'},'4'],[{pt:'Mínima',en:'Half note'},'2'],[{pt:'Semínima',en:'Quarter note'},'1'],[{pt:'Colcheia',en:'Eighth note'},'½'],[{pt:'Semicolcheia',en:'Sixteenth note'},'¼']]
     .map(([n,v])=>`<tr><td>${tx(n)}</td><td class="mono">${v} ${L==='en'?'beat(s)':'tempo(s)'}</td></tr>`).join('')+'</tbody></table>'
   +P('<small>Dica: toca sempre com metrónomo, devagar. A mão do rasgado nunca pára (sobe e desce); só escolhes quando toca nas cordas.</small>',
      '<small>Tip: always practise slowly with a metronome. Your strumming hand never stops moving (down and up); you only choose when it hits the strings.</small>')},

 generos(){
  const G=[  // [nome, origem, ritmo, harmonia & escala, instrumentos típicos, na guitarra]
   ['Blues',{pt:'EUA (Delta do Mississippi), fim do séc. XIX',en:'USA (Mississippi Delta), late 19th c.'},{pt:'4/4 com swing (shuffle), 12/8',en:'4/4 swung (shuffle), 12/8'},{pt:'12 compassos I7–IV7–V7; pentatónica menor + blue note',en:'12-bar I7–IV7–V7; minor pentatonic + blue note'},{pt:'guitarra, voz, harmónica, baixo, bateria, piano',en:'guitar, vocals, harmonica, bass, drums, piano'},{pt:'acordes de 7.ª, bends, slide; shuffle nas cordas Mi/Lá',en:'7th chords, bends, slide; shuffle riffs on E/A'}],
   ['Jazz',{pt:'Nova Orleães, anos 1910',en:'New Orleans, 1910s'},{pt:'4/4 com swing; improvisação',en:'4/4 swing; improvisation'},{pt:'ii–V–I, acordes 7/9/13, modos e escalas alteradas',en:'ii–V–I, 7/9/13 chords, modes and altered scales'},{pt:'saxofone, trompete, contrabaixo, piano, bateria (vassouras), guitarra',en:'sax, trumpet, double bass, piano, drums (brushes), guitar'},{pt:'acordes maj7/m7 sem cordas soltas, acompanhamento (comping)',en:'closed maj7/m7 voicings, comping'}],
   ['Soul / R&B',{pt:'EUA, anos 1950–60 (gospel + blues)',en:'USA, 1950s–60s (gospel + blues)'},{pt:'4/4, groove no 2 e 4',en:'4/4, groove on 2 and 4'},{pt:'m7, maj7, 9; pentatónica; voz muito ornamentada',en:'m7, maj7, 9 chords; pentatonic; ornamented vocals'},{pt:'voz, órgão/piano, baixo, bateria, metais, guitarra rítmica',en:'vocals, organ/piano, bass, drums, horns, rhythm guitar'},{pt:'acordes pequenos nas cordas agudas, double stops',en:'small chords on the top strings, double stops'}],
   ['Rock',{pt:'EUA / Reino Unido, anos 1950–60',en:'USA / UK, 1950s–60s'},{pt:'4/4, caixa no 2 e 4',en:'4/4, snare on 2 and 4'},{pt:'I–IV–V, power chords (5), pentatónica',en:'I–IV–V, power chords (5), pentatonic'},{pt:'guitarra elétrica, baixo, bateria, voz',en:'electric guitar, bass, drums, vocals'},{pt:'power chords com palm mute, riffs, distorção',en:'palm-muted power chords, riffs, distortion'}],
   ['Pop',{pt:'Global, desde os anos 1950',en:'Global, since the 1950s'},{pt:'4/4, refrão forte, 90–130 BPM',en:'4/4, strong chorus, 90–130 BPM'},{pt:'I–V–vi–IV, escala maior',en:'I–V–vi–IV, major scale'},{pt:'voz, teclados/sintetizadores, bateria eletrónica, guitarra, baixo',en:'vocals, keys/synths, drum machines, guitar, bass'},{pt:'acordes abertos, capotraste, rasgado simples',en:'open chords, capo, simple strumming'}],
   ['Funk',{pt:'EUA, anos 1960 (James Brown)',en:'USA, 1960s (James Brown)'},{pt:'4/4 em semicolcheias, acento no "1"',en:'4/4 sixteenth-note groove, accent on the "one"'},{pt:'1 ou 2 acordes (m7, 9), dórico',en:'one or two chords (m7, 9), Dorian'},{pt:'baixo (slap), bateria, guitarra rítmica, metais, teclas',en:'bass (slap), drums, rhythm guitar, horns, keys'},{pt:'"chicken scratch": rasgado abafado, acordes de 9.ª',en:'"chicken scratch": muted strums, 9th chords'}],
   ['Reggae',{pt:'Jamaica, fim dos anos 1960',en:'Jamaica, late 1960s'},{pt:'4/4 lento, acento no contratempo (skank)',en:'slow 4/4, offbeat accent (skank)'},{pt:'I–IV–V, tons menores, poucos acordes',en:'I–IV–V, minor keys, few chords'},{pt:'baixo em destaque, bateria (one drop), guitarra, órgão',en:'prominent bass, drums (one drop), guitar, organ'},{pt:'acordes curtos e abafados no 2 e 4',en:'short muted chords on 2 and 4'}],
   ['Bossa nova',{pt:'Brasil, fim dos anos 1950',en:'Brazil, late 1950s'},{pt:'2/4 ou 4/4, samba suave e sincopado',en:'2/4 or 4/4, soft syncopated samba'},{pt:'acordes de jazz (maj7, m7, 7(9)), ii–V',en:'jazz chords (maj7, m7, 7(9)), ii–V'},{pt:'violão, voz, piano, contrabaixo, percussão leve',en:'nylon guitar, vocals, piano, double bass, light percussion'},{pt:'polegar no baixo + acordes sincopados',en:'thumb on the bass + syncopated chords'}],
   ['Fado',{pt:'Portugal (Lisboa), séc. XIX',en:'Portugal (Lisbon), 19th c.'},{pt:'2/4 ou 4/4, rubato',en:'2/4 or 4/4, rubato'},{pt:'menor/maior alternados, I–V7, harmonia simples',en:'minor/major alternation, I–V7, simple harmony'},{pt:'guitarra portuguesa, viola, viola baixo, voz',en:'Portuguese guitar, classical guitar, bass guitar, vocals'},{pt:'viola: baixo alternado + acorde; melodia na guitarra portuguesa',en:'guitar: alternating bass + chord; melody on the Portuguese guitar'}],
   ['Flamenco',{pt:'Andaluzia (Espanha)',en:'Andalusia (Spain)'},{pt:'ciclos de 12 tempos (compás), palmas',en:'12-beat cycles (compás), handclaps'},{pt:'cadência andaluza (Am–G–F–E), modo frígio',en:'Andalusian cadence (Am–G–F–E), Phrygian mode'},{pt:'guitarra flamenca, voz (cante), palmas, cajón',en:'flamenco guitar, vocals (cante), handclaps, cajón'},{pt:'rasgueado, picado, acorde de Mi frígio',en:'rasgueado, picado, E Phrygian chord'}],
   ['Country / Folk',{pt:'EUA rural / tradições populares',en:'Rural USA / folk traditions'},{pt:'4/4 ou 3/4, baixo alternado',en:'4/4 or 3/4, alternating bass'},{pt:'I–IV–V, escala maior',en:'I–IV–V, major scale'},{pt:'guitarra acústica, banjo, violino, contrabaixo, harmónica',en:'acoustic guitar, banjo, fiddle, double bass, harmonica'},{pt:'acordes abertos, fingerpicking, Travis picking',en:'open chords, fingerpicking, Travis picking'}],
   ['Metal',{pt:'Reino Unido, fim dos anos 1960',en:'UK, late 1960s'},{pt:'4/4 rápido, bombo duplo',en:'fast 4/4, double kick'},{pt:'power chords, eólio, frígio, afinações graves',en:'power chords, Aeolian, Phrygian, low tunings'},{pt:'guitarras distorcidas, baixo, bateria, voz',en:'distorted guitars, bass, drums, vocals'},{pt:'palm mute, palhetada alternada, Drop D',en:'palm mute, alternate picking, Drop D'}],
   ['Hip-hop',{pt:'Nova Iorque, anos 1970',en:'New York, 1970s'},{pt:'4/4, 80–100 BPM, batida em loop',en:'4/4, 80–100 BPM, looped beat'},{pt:'samples, loops de 2–4 acordes (muitas vezes menores)',en:'samples, 2–4 chord loops (often minor)'},{pt:'voz (rap), caixa de ritmos, sampler, baixo sintetizado',en:'vocals (rap), drum machine, sampler, synth bass'},{pt:'loops curtos de acordes m7/maj7',en:'short loops of m7/maj7 chords'}],
   ['Eletrónica',{pt:'Europa / EUA, anos 1970–80',en:'Europe / USA, 1970s–80s'},{pt:'4/4 "four on the floor", 120–140 BPM',en:'4/4 "four on the floor", 120–140 BPM'},{pt:'poucos acordes repetidos, tons menores',en:'few repeated chords, minor keys'},{pt:'sintetizadores, caixas de ritmos, computador',en:'synths, drum machines, computer'},{pt:'arpejos e efeitos (delay, reverb)',en:'arpeggios and effects (delay, reverb)'}],
   ['Clássica',{pt:'Europa, séc. XVII–XIX (Barroco, Clássico, Romântico)',en:'Europe, 17th–19th c. (Baroque, Classical, Romantic)'},{pt:'variado, sem bateria',en:'varied, no drum kit'},{pt:'harmonia funcional, modulações, contraponto',en:'functional harmony, modulation, counterpoint'},{pt:'orquestra (cordas, madeiras, metais, percussão), piano',en:'orchestra (strings, woodwinds, brass, percussion), piano'},{pt:'guitarra clássica (nylon), leitura de pauta',en:'classical (nylon) guitar, reading notation'}]];
  const h=L==='en'?['Genre','Origin','Rhythm','Harmony & scale','Typical instruments','On guitar']:['Género','Origem','Ritmo','Harmonia & escala','Instrumentos típicos','Na guitarra'];
  return `<h2 class="disp">${tx(TOPICS[8][1])}</h2>`
   +P('Cada género tem uma "receita": um ritmo, uma forma de usar os acordes e um conjunto de instrumentos. Muitos descendem uns dos outros — o <b>blues</b> deu origem ao jazz, ao rock e ao soul; o soul ao funk; o funk ao hip-hop.',
      'Each genre has a "recipe": a rhythm, a way of using chords and a set of instruments. Many descend from one another — <b>blues</b> gave rise to jazz, rock and soul; soul to funk; funk to hip-hop.')
   +`<div style="overflow-x:auto"><table class="tbl"><thead><tr>${h.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>`
   +G.map(([n,...r])=>`<tr><td><b>${n}</b></td>${r.map(x=>`<td>${tx(x)}</td>`).join('')}</tr>`).join('')+'</tbody></table></div>'
   +P('<small>Árvore simples: Blues → Jazz · Blues → Rock → Metal · Gospel + Blues → Soul/R&B → Funk → Hip-hop · Funk/Disco → Eletrónica.</small>',
      '<small>Simple family tree: Blues → Jazz · Blues → Rock → Metal · Gospel + Blues → Soul/R&B → Funk → Hip-hop · Funk/Disco → Electronic.</small>')},

 instrumentos(){
  const F=[  // [família, como produz som, instrumentos, papel, onde se ouve]
   [{pt:'Cordas dedilhadas',en:'Plucked strings'},{pt:'cordas beliscadas com os dedos ou palheta',en:'strings plucked with fingers or a pick'},{pt:'guitarra (acústica, clássica, elétrica), baixo, guitarra portuguesa, cavaquinho, ukulele, banjo, bandolim, harpa',en:'guitar (acoustic, classical, electric), bass, Portuguese guitar, cavaquinho, ukulele, banjo, mandolin, harp'},{pt:'harmonia, ritmo e melodia; o baixo segura a base com a bateria',en:'harmony, rhythm and melody; the bass locks the groove with the drums'},{pt:'rock, pop, blues, folk, fado, bossa nova, flamenco, metal',en:'rock, pop, blues, folk, fado, bossa nova, flamenco, metal'}],
   [{pt:'Cordas friccionadas',en:'Bowed strings'},{pt:'arco a friccionar as cordas',en:'a bow rubbing the strings'},{pt:'violino, viola d’arco, violoncelo, contrabaixo',en:'violin, viola, cello, double bass'},{pt:'melodia e fundo harmónico; contrabaixo no grave',en:'melody and harmonic pads; double bass at the bottom'},{pt:'clássica, bandas sonoras, country (fiddle), jazz (contrabaixo)',en:'classical, film scores, country (fiddle), jazz (double bass)'}],
   [{pt:'Madeiras (sopro)',en:'Woodwinds'},{pt:'ar a vibrar numa palheta ou numa aresta',en:'air vibrating on a reed or an edge'},{pt:'flauta, clarinete, oboé, fagote, saxofone',en:'flute, clarinet, oboe, bassoon, saxophone'},{pt:'melodia, solos e contracantos',en:'melody, solos and countermelodies'},{pt:'clássica, jazz (saxofone), soul, funk',en:'classical, jazz (sax), soul, funk'}],
   [{pt:'Metais (sopro)',en:'Brass'},{pt:'lábios a vibrar num bocal',en:'lips buzzing into a mouthpiece'},{pt:'trompete, trombone, trompa, tuba',en:'trumpet, trombone, French horn, tuba'},{pt:'frases curtas e fortes, fanfarras, baixo (tuba)',en:'short punchy phrases, fanfares, bass (tuba)'},{pt:'jazz, soul, funk, ska, clássica, filarmónicas',en:'jazz, soul, funk, ska, classical, brass bands'}],
   [{pt:'Teclas',en:'Keyboards'},{pt:'martelos em cordas (piano), ar em tubos (órgão) ou eletrónica',en:'hammers on strings (piano), air in pipes (organ) or electronics'},{pt:'piano, órgão (Hammond), Rhodes, sintetizador, acordeão',en:'piano, organ (Hammond), Rhodes, synthesizer, accordion'},{pt:'harmonia e melodia ao mesmo tempo; baixo na mão esquerda',en:'harmony and melody at once; bass in the left hand'},{pt:'quase todos: clássica, jazz, soul, pop, eletrónica',en:'almost all: classical, jazz, soul, pop, electronic'}],
   [{pt:'Percussão',en:'Percussion'},{pt:'bater, abanar ou raspar',en:'hitting, shaking or scraping'},{pt:'bateria (bombo, caixa, pratos), cajón, congas, pandeireta, tímpanos, xilofone',en:'drum kit (kick, snare, cymbals), cajón, congas, tambourine, timpani, xylophone'},{pt:'tempo e groove; acentos e dinâmica',en:'time and groove; accents and dynamics'},{pt:'todos — com mais peso no rock, funk, reggae, hip-hop, latino',en:'all — most prominent in rock, funk, reggae, hip-hop, Latin'}],
   [{pt:'Voz',en:'Voice'},{pt:'cordas vocais',en:'vocal cords'},{pt:'soprano, contralto, tenor, barítono, baixo; coro',en:'soprano, alto, tenor, baritone, bass; choir'},{pt:'melodia principal e letra; os coros fazem harmonia',en:'lead melody and lyrics; backing vocals add harmony'},{pt:'todos (rap no hip-hop, cante no flamenco, fadista no fado)',en:'all (rap in hip-hop, cante in flamenco, the fadista in fado)'}],
   [{pt:'Eletrónicos',en:'Electronic'},{pt:'osciladores e samples',en:'oscillators and samples'},{pt:'sintetizador, caixa de ritmos (808, 909), sampler, computador (DAW)',en:'synthesizer, drum machine (808, 909), sampler, computer (DAW)'},{pt:'batidas, baixos sintetizados, texturas',en:'beats, synth bass, textures'},{pt:'eletrónica, hip-hop, pop',en:'electronic, hip-hop, pop'}]];
  const h=L==='en'?['Family','How it makes sound','Instruments','Role','Where you hear it']:['Família','Como produz som','Instrumentos','Papel','Onde se ouve'];
  const lay=[[{pt:'Grave (baixo)',en:'Low (bass)'},{pt:'baixo, contrabaixo, tuba, bombo, mão esquerda do piano',en:'bass, double bass, tuba, kick drum, piano left hand'}],
   [{pt:'Médio (harmonia)',en:'Mid (harmony)'},{pt:'guitarra rítmica, piano, órgão, violas d’arco, trompas',en:'rhythm guitar, piano, organ, violas, French horns'}],
   [{pt:'Agudo (melodia)',en:'High (melody)'},{pt:'voz, guitarra solo, violino, flauta, trompete, saxofone',en:'vocals, lead guitar, violin, flute, trumpet, saxophone'}],
   [{pt:'Ritmo (tempo)',en:'Rhythm (time)'},{pt:'bateria, percussão, rasgado da guitarra',en:'drums, percussion, guitar strumming'}]];
  return `<h2 class="disp">${tx(TOPICS[9][1])}</h2>`
   +P('Os instrumentos agrupam-se em <b>famílias</b> pela forma como produzem som. Numa banda ou orquestra cada um ocupa um <b>lugar</b>: uns seguram o grave e o ritmo, outros a harmonia, outros a melodia.',
      'Instruments are grouped into <b>families</b> by how they make sound. In a band or orchestra each one has a <b>place</b>: some hold the low end and the rhythm, others the harmony, others the melody.')
   +`<div style="overflow-x:auto"><table class="tbl"><thead><tr>${h.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>`
   +F.map(r=>`<tr><td><b>${tx(r[0])}</b></td>${r.slice(1).map(x=>`<td>${tx(x)}</td>`).join('')}</tr>`).join('')+'</tbody></table></div>'
   +`<h3 class="mono">${L==='en'?'Where each one sits in the music':'Onde cada um se enquadra na música'}</h3><table class="tbl"><tbody>`
   +lay.map(([a,b])=>`<tr><td><b>${tx(a)}</b></td><td>${tx(b)}</td></tr>`).join('')+'</tbody></table>'
   +P('<small>A guitarra pode ocupar vários lugares: ritmo (rasgado), harmonia (acordes), melodia (solos) e até o baixo (dedilhado com o polegar).</small>',
      '<small>The guitar can take several places: rhythm (strumming), harmony (chords), melody (solos) and even the bass (thumb fingerpicking).</small>')}
};

/* ---------- metrónomo simples ---------- */
function click(t,acc){const c=ac(),o=c.createOscillator(),g=c.createGain();o.frequency.value=acc>=1?1500:acc>0?1150:900;
  g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(acc>=1?.5:.3,t+.002);g.gain.exponentialRampToValueAtTime(.0001,t+.06);o.connect(g);g.connect(out);o.start(t);o.stop(t+.08)}
function metro(acc,bars=2,bpm=96){const c=ac(),sp=60/bpm*(acc.length===6?.5:1),t0=c.currentTime+.05;
  for(let b=0;b<bars;b++)acc.forEach((a,i)=>click(t0+(b*acc.length+i)*sp,a))}

/* ---------- página ---------- */
const CSS=`
.th{display:grid;grid-template-columns:210px minmax(0,1fr);gap:56px;align-items:start}
.th-side{position:sticky;top:24px;display:flex;flex-direction:column;border-top:3px double var(--line);border-bottom:3px double var(--line);padding:10px 0}
.th-side a{text-decoration:none;color:var(--dim);padding:9px 4px 9px 18px;position:relative;font-size:12.5px;transition:color .25s}
.th-side a::before{content:"";position:absolute;left:4px;top:50%;width:5px;height:5px;margin-top:-3px;border:1px solid var(--line);transform:rotate(45deg);transition:.25s}
.th-side a::after{display:none}.th-side a:hover,.th-side a.on{color:var(--ink)}.th-side a.on::before{background:var(--gold);border-color:var(--gold)}
.th-main{min-width:0}
.th-credit{margin-top:60px;font-size:13px;color:var(--dim);text-align:center}.th-credit a{color:var(--gold)}
.th-main h2{font-size:clamp(30px,3.4vw,44px);font-style:italic;margin-bottom:18px}
.th-main h3{color:var(--gold);margin:38px 0 14px}
.th-main>p{max-width:44em;margin-bottom:14px;font-size:19px}.th-main p small{font-size:15.5px;color:var(--dim)}
.th-main b{font-weight:500}
.pl{display:inline-flex;align-items:center;gap:8px;background:none;border:1px solid var(--gold);color:var(--gold);border-radius:999px;padding:5px 12px 5px 8px;cursor:pointer;font:500 12px/1.3 var(--sans);letter-spacing:.14em;text-transform:uppercase;transition:background .2s,color .2s}
.pl:not(:has(span)){padding:6px}.pl svg{width:16px;height:16px}.pl:hover,.pl.hit{background:var(--gold);color:#f3ead8}
.roots,.types{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0 8px}
.roots button,.types button{background:none;border:1px solid var(--line);color:var(--ink);padding:6px 11px;cursor:pointer;font:500 15px/1.2 var(--serif);transition:.2s}
.types button{font-size:14px;padding:5px 10px;color:var(--dim)}
.roots button:hover,.types button:hover{border-color:var(--gold)}.roots button.on,.types button.on{background:var(--ink);border-color:var(--ink);color:#f3ead8}
.chords{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:18px;margin-top:22px}
.chord{background:linear-gradient(180deg,#f3ead8,#ece1c9);border:1px solid var(--line);padding:14px 12px 12px;display:flex;flex-direction:column;align-items:center;box-shadow:0 3px 10px rgba(60,40,15,.1)}
.ch-h{text-align:center;line-height:1.15}.ch-h b{font-size:28px;font-style:italic;display:block}.ch-h small{color:var(--dim);font-size:13.5px}
.vs{margin:8px 0 2px}.vs .v{display:none}.vs .v.on{display:block}
.chd{width:118px;color:var(--ink)}.chd .fr{stroke:var(--line);stroke-width:1.2}.chd .st{stroke:#8a7a62;stroke-width:1}
.chd .dot{fill:var(--ink)}.chd .op{fill:none;stroke:var(--ink);stroke-width:1.3}.chd .mk{font:15px var(--serif);text-anchor:middle;fill:var(--dim)}.chd .bf{font:italic 13px var(--serif);fill:var(--dim)}
.ch-n{color:var(--gold);font-size:12.5px;letter-spacing:.1em;text-transform:none;margin:4px 0 10px;text-align:center}
.ch-a{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:center}
.ch-a .ar,.ch-a .nx{background:none;border:0;border-bottom:1px solid var(--line);color:var(--dim);cursor:pointer;padding:2px 0;font-size:11px}
.ch-a .ar:hover,.ch-a .nx:hover{color:var(--ink);border-color:var(--gold)}
.notes12{display:grid;grid-template-columns:repeat(auto-fill,minmax(98px,1fr));gap:8px}
.n12{background:#f3ead8;border:1px solid var(--line);padding:10px 6px;cursor:pointer;color:var(--ink);font:inherit;display:flex;flex-direction:column;align-items:center;transition:.2s}
.n12.acc{background:#2b2119;color:#efe6d3;border-color:#2b2119}.n12.acc small{color:#bfae8e}
.n12 b{font-family:var(--disp);font-size:22px;font-weight:500;line-height:1.1}.n12 small{font-size:13px;color:var(--dim)}
.n12:hover,.n12.hit{transform:translateY(-2px);box-shadow:0 6px 14px rgba(60,40,15,.2)}
.tune{display:flex;flex-wrap:wrap;gap:8px}
.fbwrap{overflow-x:auto;margin:10px 0 6px;padding-bottom:6px}
.gfb{display:grid;grid-template-columns:22px 40px repeat(calc(var(--n) - 1),minmax(40px,1fr));min-width:720px;background:linear-gradient(180deg,#5a3d24,#4a3220);border:1px solid #2b2119;box-shadow:0 8px 20px rgba(60,40,15,.3)}
.gfb .sl{background:var(--bg);color:var(--dim);display:grid;place-items:center;font-size:11px;letter-spacing:0}
.gfb .fn{background:var(--bg);text-align:center;font-size:11px;color:var(--dim);letter-spacing:0;padding-top:4px}
.fc{position:relative;height:30px;border:0;border-right:2px solid #b9a07a;background:none;cursor:pointer;padding:0}
.fc.nut{border-right:6px solid #efe6d3}
.fc::before{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:#d8c9a8;opacity:.85}
.fc i{position:relative;z-index:1;display:inline-grid;place-items:center;min-width:24px;height:22px;padding:0 3px;border-radius:11px;font:500 11px/1 var(--sans);font-style:normal;color:transparent;transition:.15s}
.fc.nat i{color:#efe6d3}.fc:not(.nat) i{color:rgba(239,230,211,.4)}
.gfb:has(.on) .fc i{color:transparent}
.fc.on i{background:#efe6d3;color:#2b2119!important}.fc.rt i{background:#8b6a2f;color:#f3ead8!important}
.fc:hover i,.fc.hit i{background:#f3ead8;color:#2b2119!important;transform:scale(1.12)}
.tbl{border-collapse:collapse;width:100%;max-width:720px;margin:12px 0 18px;font-size:17px}
.tbl th{font:500 11.5px var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--gold);text-align:left;padding:8px 10px;border-bottom:1px solid var(--gold)}
.tbl td{padding:7px 10px;border-bottom:1px solid var(--line)}
.scbox{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;margin:18px 0 6px;padding:16px 20px;border:1px solid var(--line);background:#f1e8d5}
.scbox b{font-size:28px;font-style:italic}.scbox p{margin:2px 0}.scbox .mono{color:var(--gold);letter-spacing:.12em;text-transform:none}.scbox .dim{color:var(--dim)}
.field{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;margin:18px 0 14px}
.fd{background:#f3ead8;border:1px solid var(--line);padding:12px 4px;cursor:pointer;color:var(--ink);display:flex;flex-direction:column;align-items:center;gap:2px;transition:.2s}
.fd span{color:var(--gold);font-size:12px;letter-spacing:.1em;text-transform:none}.fd b{font-size:24px;font-style:italic;font-weight:500}
.fd:hover,.fd.hit{border-color:var(--gold);transform:translateY(-2px)}
.progs,.rhy{display:flex;flex-direction:column;gap:10px;margin-top:16px}
.prog{display:flex;align-items:center;gap:16px 24px;justify-content:space-between;flex-wrap:wrap;padding:14px 18px;border:1px solid var(--line);background:#f1e8d5}
.prog>div:first-child{min-width:200px;flex:1}.prog b{display:block;font-size:20px;font-weight:500}.prog small{color:var(--dim);font-size:15px}
.seq{display:flex;flex-wrap:wrap;gap:6px}.seq i{font-style:normal;padding:4px 9px;border:1px solid var(--line);font-size:12px;letter-spacing:.06em;text-transform:none;transition:.15s}
.seq i.on{background:var(--gold);color:#f3ead8;border-color:var(--gold)}
.cofwrap{display:grid;place-items:center;margin:10px 0}
.cof{width:min(460px,100%)}.cof .ring{fill:none;stroke:var(--line)}
.cofk{cursor:pointer}.cofk circle{fill:#f3ead8;stroke:var(--gold);transition:.2s}.cofk text{font:italic 500 17px var(--disp);text-anchor:middle;fill:var(--ink);pointer-events:none}
.cofk.mi circle{fill:#e4d8bd;stroke:var(--line)}.cofk.mi text{font-size:13px}
.cofk:hover circle,.cofk.hit circle{fill:var(--gold)}.cofk:hover text,.cofk.hit text{fill:#f3ead8}
.cofc{font:500 11px var(--sans);letter-spacing:.3em;text-transform:uppercase;text-anchor:middle;fill:var(--gold)}
@media(max-width:900px){
 .th{grid-template-columns:1fr;gap:18px}
 .th-side{position:static;flex-direction:row;overflow-x:auto;gap:4px 14px;padding:8px 0;-webkit-overflow-scrolling:touch}
 .th-side a{white-space:nowrap;padding:6px 2px 6px 14px}
 .field{grid-template-columns:repeat(4,minmax(0,1fr))}
 .chords{grid-template-columns:repeat(auto-fill,minmax(146px,1fr));gap:12px}
}`;
let styled=false;
function render(topic){
  preload();
  if(!styled){const st=document.createElement('style');st.textContent=CSS;document.head.appendChild(st);styled=true}
  if(!SECTIONS[topic])topic='notas';
  const title=L==='en'?'Guitar theory':'Teoria de guitarra';
  m.innerHTML=`<div class="sec-head"><h1 class="disp">${L==='en'?'Theory':'Teoria'}</h1><span class="rule"></span></div>`
   +`<div class="th"><div class="th-side mono">${TOPICS.map(([k,n])=>`<a href="/teoria/${k}" class="${k===topic?'on':''}">${tx(n)}</a>`).join('')}</div>`
   +`<section class="th-main" data-topic="${topic}">${SECTIONS[topic]()}</section></div>`
   +`<p class="th-credit">${L==='en'?'Sounds':'Sons'}: ${L==='en'?'recorded acoustic guitar':'guitarra acústica gravada'} — <a href="https://github.com/nbrosowsky/tonejs-instruments" target="_blank" rel="noopener">tonejs-instruments</a> (Nicholaus Brosowsky), <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noopener">CC BY 3.0</a>.</p>`;
  document.title=tx(TOPICS.find(t=>t[0]===topic)[1])+' — '+title}
function rerender(){const sec=m.querySelector('.th-main');if(sec)sec.innerHTML=SECTIONS[sec.dataset.topic]()}
const hit=el=>{el.classList.add('hit');setTimeout(()=>el.classList.remove('hit'),260)};

m.addEventListener('click',e=>{
  const b=e.target.closest('button,[data-ch]');if(!b||!m.querySelector('.th'))return;
  const d=b.dataset;
  if(d.act){const v=d.v;
    if(d.act==='root')S.root=+v;else if(d.act==='type')S.type=v;else if(d.act==='sroot')S.sRoot=+v;else if(d.act==='scale')S.scale=v;
    else if(d.act==='key')S.key=+v;else if(d.act==='minor')S.minor=v==='1';
    rerender();return}
  if(d.m){play([+d.m]);hit(b);return}
  if(d.midi){play([+d.midi]);hit(b);return}
  if(d.strum){strum(d.strum.split(',').map(Number));hit(b);return}
  const card=b.closest('.chord');
  const cur=()=>card.querySelector('.v.on').dataset.f.split(',').map(x=>x==='x'?null:+x);
  if(card&&'chord' in d){strum(midisOf(cur()));hit(b);return}
  if(card&&'arp' in d){arp(midisOf(cur()));return}
  if(card&&'next' in d){const vs=[...card.querySelectorAll('.v')],i=vs.findIndex(v=>v.classList.contains('on')),n=(i+1)%vs.length;
    vs[i].classList.remove('on');vs[n].classList.add('on');b.querySelector('span').textContent=n+1;strum(midisOf(cur()));return}
  if(d.int){const a=60,s=+d.int;play([a,a+s],{gap:.55});setTimeout(()=>play([a,a+s]),1300);hit(b);return}
  if(d.scale){play(d.scale.split(',').map(Number),{gap:.3});return}
  if(d.ch){const[r,k]=d.ch.split('|');strum(chordMidis(+r,k));hit(b.closest('.cofk')||b);return}
  if(d.seq){const cs=d.seq.split(';').map(x=>{const[r,k]=x.split('|');return[+r,k]});
    const box=b.closest('.prog');document.querySelectorAll('.seq').forEach(s=>s.classList.remove('seq-cur'));
    // acende os acordes da progressão certa
    document.querySelectorAll('.seq i').forEach(i=>i.classList.remove('on'));
    if(box){const items=box.querySelectorAll('.seq i');seqTimer.forEach(clearTimeout);seqTimer=[];
      cs.forEach(([r,k],i)=>seqTimer.push(setTimeout(()=>{strum(chordMidis(r,k));items.forEach((el,j)=>el.classList.toggle('on',j===i))},i*(cs.length>8?800:1150))));
      seqTimer.push(setTimeout(()=>items.forEach(el=>el.classList.remove('on')),cs.length*(cs.length>8?800:1150)))}
    else{const fds=[...m.querySelectorAll('.fd')];seqTimer.forEach(clearTimeout);seqTimer=[];
      cs.forEach(([r,k],i)=>seqTimer.push(setTimeout(()=>{strum(chordMidis(r,k));hit(fds[i])},i*900)))}
    return}
  if(d.metro){metro(d.metro.split(',').map(Number));hit(b);return}
});

window.theoryPage=render;
window._theory={voicings,TYPES,check,TUNING,samples};  // usado nos testes
})();
