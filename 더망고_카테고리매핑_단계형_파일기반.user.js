// ==UserScript==
// @name         더망고 카테고리매핑 단계형 파일기반(수집→Claude매핑→적용)
// @namespace    solddeul.tmg
// @version      2.0
// @description  단계형 카테고리매핑을 "규칙 자동선택"이 아니라 "파일 기반 결정론"으로 처리. ① 수집(Export): 마켓별 신발 카테고리 전체(카탈로그: 경로+코드) + 리프(매핑대상)를 엑셀로 내려받음. ② 매핑: Claude가 그 엑셀을 받아 규칙대로 각 리프×마켓에 카탈로그 경로를 채움. ③ 적용(Apply): 매핑 엑셀을 불러오면 카탈로그로 경로→코드를 해석해 리프마다 설정페이지에서 주입·고시·저장(fetch-POST)·되읽기 검증. 규칙이 매크로에서 빠져 Claude 판단으로 이동 → 신상품마다 정규식 손볼 필요 없음.
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_category_new.php*
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_category_set.php*
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function(){
'use strict';

var _alerts=[];
var _nativeConfirm=(window.confirm&&window.confirm.bind(window))||function(){return true;};
try{ window.alert=function(m){ _alerts.push(String(m)); }; }catch(e){}
try{ window.confirm=function(){ return true; }; }catch(e){}

var LS='tmg_catmap_file_v1';   // {mode:'export'|'apply', running, idx, ok, fail, queue, catalog, log, exportPending}
var _busy=false;

var MARKETS=['AUC20','GMK20','11ST','SMART','COUP','LTON','LFMALL','MUSTIT','SHOPEE','QOO10JP','PLAYAUTO'];
var MLABEL={AUC20:'옥션',GMK20:'G마켓','11ST':'11번가',SMART:'스마트스토어',COUP:'쿠팡',LTON:'롯데ON',LFMALL:'LF몰',MUSTIT:'머스트잇',SHOPEE:'쇼피',QOO10JP:'큐텐JP',PLAYAUTO:'플레이오토'};
var LABEL2M={}; MARKETS.forEach(function(m){ LABEL2M[MLABEL[m]]=m; });
var USE_MARKET_DEFAULT='["AUC20","GMK20","11ST","SMART","COUP","LTON","LFMALL","MUSTIT","SHOPEE","QOO10JP","SHOPIFY","CAFE24","GODO","IMWEB","PLAYAUTO"]';
var ENGLISH_MARKETS={SHOPEE:1, MUSTIT:1, QOO10JP:1};

// 카탈로그 스윕 키워드(마켓 무관 union; 안 맞는 건 빈 결과)
var SWEEP_KR=['남성화','여성화','신발','슈즈','운동화','스니커즈','부츠','워커','샌들','슬리퍼','구두','로퍼','힐','펌프스','플랫','모카신','아쿠아','골프화','등산화','트레킹','워킹화','러닝화','농구화','테니스화','캔버스','슬립온','뮬','장화','부티'];
var SWEEP_EN=['shoes','boots','sneakers','sandals','loafers','heels','flats','slippers','oxford','pumps','mule'];

// 카탈로그 정제(비-신발/금지 카테고리 제외)
var FORBIDDEN=/(어린이|유아|아동|키즈|주니어|도서|서적|e쿠폰|모바일|렌탈|배달음식|출산|육아|임산부|위생용품|의료기기|의약품|Baby|Kids|Toddler|Children)/i;
var PET=/(반려|애완|강아지|고양이|반려동물|\bPets?\b)/i;
var BEAUTY=/(화장품|미용|헤어|파마|스킨케어|메이크업)/;
// 신발 리프 허용목록(신발 어휘) + 금지목록(신발장/가방/모자/벨트/끈/탈취제 등)
var FOOT_LEAF=/화$|슈즈|신발|부츠|부티|샌들|슬리퍼|슬립온|로퍼|힐|펌프스|플랫|워커|더비|구두|뮬|블로퍼|모카신|옥스[퍼포]드|스니커|아쿠아|장화|크록스|덧신|니하이|shoe|boot|sneaker|sandal|loafer|heel|pump|flat|mule|oxford|derby|slipper|clog/i;
var JUNK_CAT=/신발장|정리함|수납|주머니|골프백|가방|백팩|에코백|크로스백|숄더백|토트백|파우치|캐리어|지갑|벨트|모자|캡모자|비니|장갑|스카프|머플러|넥워머|목걸이|팔찌|우산|양산|양말|삭스|신발끈|운동화끈|깔창|인솔|커버|클리너|탈취|방향|제습|건조|세탁|걸이|보관|관리용품|의류|트레이닝복|바지|팬츠|치마|원피스|재킷|코트|점퍼|니트|스웨터|가디건|풀오버|블라우스/;
function leafSeg(t){ return (String(t).split('>').pop()||'').trim(); }
function isFootwearCat(t){
  if(!t || t.indexOf('>')<0) return false;
  if(FORBIDDEN.test(t)||PET.test(t)||BEAUTY.test(t)) return false;
  var sg=String(t).split('>').map(function(x){return x.trim();});
  var leaf=sg[sg.length-1], last2=sg.slice(-2).join(' ');
  if(JUNK_CAT.test(leaf)) return false;      // 신발장/가방/벨트/끈/탈취제 등 제외
  if(!FOOT_LEAF.test(last2)) return false;    // 리프(±상위)에 신발 어휘 필수
  return true;
}

function gs(){ try{ return JSON.parse(localStorage.getItem(LS))||null; }catch(e){ return null; } }
function ss(s){ localStorage.setItem(LS, JSON.stringify(s)); }
function clr(){ localStorage.removeItem(LS); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function q(s){ return document.querySelector(s); }
function DIR(){ return location.pathname.replace(/[^/]+$/,''); }
function shortOf(full){ var s=String(full||''); while(s.length>3 && s.slice(-3)==='000') s=s.slice(0,-3); return s; }
function normName(n){ if(/^MEN$/i.test(n)||/남성/.test(n)) return '남성'; if(/^WOMEN$/i.test(n)||/여성/.test(n)) return '여성'; return n; }
function genderOf(name){ return name.indexOf('여성')>=0?'여성':(name.indexOf('남성')>=0?'남성':'공용'); }

// =========================================================================
// 트리/리프 열거 (기존 단계형 매크로 검증 로직 재사용)
// =========================================================================
function useMarketParam(){ var e=document.getElementById('use_market'); var v=e?(e.value||e.textContent||''):''; return (v&&v.indexOf('[')>=0)?v:USE_MARKET_DEFAULT; }
async function catGetChildren(short){
  var g=short.length/3;
  var body='mode=category_get&category_depth='+(g+1)+'&category_id='+encodeURIComponent(short)+'&themango=';
  var html=await fetch(DIR()+'admin_category_get_load.php',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body}).then(function(r){return r.text();});
  var doc=new DOMParser().parseFromString(html,'text/html');
  return Array.prototype.slice.call(doc.querySelectorAll('li')).map(function(li){
    var sp=li.querySelector('[id]'); if(!sp) return null;
    return { full:sp.id, name:(sp.textContent||'').replace(/\s+/g,' ').trim() };
  }).filter(Boolean);
}
async function enumerateLeaves(siteShort){
  var leaves=[]; var seen={}; var t0=Date.now();
  async function dfs(node, pathNames){
    if(Date.now()-t0>180000) return;
    var kids; try{ kids=await catGetChildren(shortOf(node.full)); }catch(e){ kids=[]; }
    if(!kids.length){ if(!seen[node.full]){ seen[node.full]=1; leaves.push({ id:node.full, name:pathNames.join(' ') }); } return; }
    for(var i=0;i<kids.length;i++){ await dfs(kids[i], pathNames.concat(normName(kids[i].name))); }
  }
  var roots=await catGetChildren(siteShort);
  for(var i=0;i<roots.length;i++){ await dfs(roots[i], [normName(roots[i].name)]); }
  return leaves;
}
async function leafInfo(leafFull){
  try{
    var body='mode=show_category&category_id='+encodeURIComponent(shortOf(leafFull))+'&use_market='+encodeURIComponent(useMarketParam())+'&themango=&pg=1&list_num=10';
    var html=await fetch(DIR()+'admin_category_get_load.php',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body}).then(function(r){return r.text();});
    var m=html.match(/categorySet\('(\d+)','([^']*)','([^']*)'/);
    if(m && /^\d+$/.test(m[3])) return { mapped:true, psUid:m[3] };
  }catch(e){}
  return { mapped:false, psUid:'new' };
}
function listSites(){
  var out=[];
  Array.prototype.slice.call(document.querySelectorAll('#setCateCd1 li')).forEach(function(li){
    var sp=li.querySelector('span[id]')||li.querySelector('[id]');
    var full=sp?sp.id:''; var name=(li.textContent||'').replace(/\s+/g,'').trim();
    if(!full || /^0+$/.test(full)) return;
    if(/themango|더망고|THEMANGO|MANGO/i.test(name)) return;
    out.push({name:name, full:full, short:shortOf(full)});
  });
  return out;
}

// =========================================================================
// 카탈로그 스윕 (set 페이지의 search_category 사용)
// =========================================================================
function optsOf(m){ var s=document.getElementById('openmarket_category_search_list_'+m); if(!s) return []; return Array.prototype.slice.call(s.options).map(function(o){ return {t:(o.text||'').trim(), v:o.value}; }).filter(function(o){ return o.t.indexOf('>')>=0; }); }
async function searchWait(m,kw){
  var inp=document.getElementById('openmarket_category_search_text_'+m); if(!inp) return [];
  inp.value=kw;
  try{ search_category(m,'openmarket_category_search_list_'+m,''); }catch(e){ return []; }
  var t0=Date.now(), prev='';
  while(Date.now()-t0<7000){ await sleep(400); var o=optsOf(m); var sig=o.map(function(x){return x.t;}).join('|'); if(o.length && !/검색중/.test(sig) && sig!==prev) return o; prev=sig; }
  return optsOf(m);
}
async function sweepMarket(m, onProg){
  var kws=SWEEP_KR.concat(ENGLISH_MARKETS[m]?SWEEP_EN:[]);
  var seen={}, cat=[];
  for(var i=0;i<kws.length;i++){
    if(onProg) onProg(i+1, kws.length);
    var r=await searchWait(m, kws[i]);
    r.forEach(function(o){ if(!seen[o.v] && isFootwearCat(o.t)){ seen[o.v]=1; cat.push({path:o.t, code:o.v}); } });
  }
  cat.sort(function(a,b){ return a.path<b.path?-1:1; });
  return cat;
}

// =========================================================================
// 저장/고시 (기존 매크로 검증 로직 재사용)
// =========================================================================
var NOTIFY_EXEMPT={CAFE24:1,MUSTIT:1,HAKYUNG:1,REEBONZ:1,BALAAN:1,TRENBE:1,SHOPEE:1,QOO10JP:1,SHOPIFY:1};
function needsNotify(m){ return !NOTIFY_EXEMPT[m]; }
function hasCategory(m){ var sel=document.getElementById('openmarket_category_search_list_'+m); return !!(sel && sel.value && sel.value!=='no_category'); }
function groupSet(m){ var g=document.getElementById('notify_group_no_'+m); return !!(g && g.value); }
function marketsNeedingGroup(){ return MARKETS.filter(function(m){ return needsNotify(m) && hasCategory(m); }); }
async function waitNotifyGroups(timeout){
  var t0=Date.now();
  while(Date.now()-t0<(timeout||9000)){ var pend=marketsNeedingGroup().filter(function(m){ return !groupSet(m); }); if(!pend.length) return true; await sleep(600); }
  return false;
}
function shoeGroupPrefs(name){
  if(/신발|슈즈|구두|부츠|샌들|스니커즈|운동화|로퍼|힐|슬리퍼|워커|플랫/.test(name||'')) return ['구두/신발','신발','구두','패션잡화','기타 재화'];
  return ['패션잡화','잡화','기타 재화'];
}
function ensureNotifyGroups(name){
  var prefs=shoeGroupPrefs(name); var setM=[];
  marketsNeedingGroup().forEach(function(m){
    var g=document.getElementById('notify_group_no_'+m); if(!g || g.value) return;
    var idx=-1;
    for(var p=0;p<prefs.length && idx<0;p++){ for(var i=0;i<g.options.length;i++){ if((g.options[i].text||'').trim()===prefs[p]){ idx=i; break; } } }
    if(idx<0){ for(var j=0;j<g.options.length;j++){ if(/구두|신발|잡화|기타\s*재화/.test(g.options[j].text||'')){ idx=j; break; } } }
    if(idx<0){ for(var k=0;k<g.options.length;k++){ if(g.options[k].value){ idx=k; break; } } }
    if(idx>=0){ g.selectedIndex=idx; g.dispatchEvent(new Event('change',{bubbles:true})); setM.push(m); }
  });
  return setM;
}
function applyNotifyRefer(markets){
  (markets||[]).forEach(function(m){
    var master=document.getElementById(m+'_input_notify'); if(!master) return;
    if(!master.checked){ master.checked=true; }
    try{ if(typeof chk_refer==='function'){ chk_refer('all', master, m+'_input_notify', '상품상세페이지 참조'); } else { master.dispatchEvent(new Event('click',{bubbles:true})); } }catch(e){}
  });
}
function injectCode(m, code, text){
  var sel=document.getElementById('openmarket_category_search_list_'+m); if(!sel) return false;
  var o=document.createElement('option'); o.value=code; o.text=text; sel.appendChild(o); sel.value=code;
  sel.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
}
function clearMarket(m){   // 저장검증 실패 마켓을 no_category로 비워 form_check 통과(그 마켓만 미매핑, 리프 통째 스킵 방지)
  var sel=document.getElementById('openmarket_category_search_list_'+m); if(!sel) return;
  var opt=Array.prototype.slice.call(sel.options).filter(function(o){return o.value==='no_category'||o.value==='';})[0];
  if(opt){ sel.value=opt.value; } else { var o=document.createElement('option'); o.value='no_category'; o.text='선택안함'; sel.appendChild(o); sel.value='no_category'; }
  try{ sel.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){}
}
function serializeForm(form){ var fd=new FormData(form); var p=new URLSearchParams(); fd.forEach(function(v,k){ if(typeof v==='string') p.append(k,v); }); return p; }

// =========================================================================
// Export: 카탈로그 + 매핑 템플릿 → 엑셀 다운로드
// =========================================================================
function stampNow(){ var d=new Date(), p=function(n){return String(n).padStart(2,'0');}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes()); }
async function runExport(){
  // 리프 목록은 tree에서 열거해 넘겨받음. 여기(set 페이지)에선 검색으로 카탈로그만 수집.
  var pending=gs(); var siteName=(pending&&pending.siteName)||'ABCmart';
  var leaves=(pending&&pending.leaves)||[];
  if(!leaves.length){ setStat('리프 목록이 비어있습니다. 트리 페이지에서 다시 시작하세요.'); return; }
  setStat('리프 '+leaves.length+'개. 마켓 카탈로그 수집 중...');
  var catalog={};
  for(var mi=0; mi<MARKETS.length; mi++){
    var m=MARKETS[mi];
    catalog[m]=await sweepMarket(m, function(a,b){ setStat('['+MLABEL[m]+'] 카탈로그 '+a+'/'+b+' (누적 '+(catalog[m]?catalog[m].length:0)+')'); });
    setStat('['+MLABEL[m]+'] 완료: '+catalog[m].length+'건 ('+(mi+1)+'/'+MARKETS.length+' 마켓)');
  }
  // --- 워크북 작성 ---
  var wb=XLSX.utils.book_new();
  // 카탈로그 시트
  var catAoa=[['마켓','카테고리경로','코드']];
  MARKETS.forEach(function(m){ (catalog[m]||[]).forEach(function(c){ catAoa.push([MLABEL[m], c.path, String(c.code)]); }); });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(catAoa), '카탈로그');
  // 매핑 시트(리프 행 + 빈 마켓 열 = Claude가 채움)
  var mapHead=['리프ID','경로명','성별'].concat(MARKETS.map(function(m){return MLABEL[m];}));
  var mapAoa=[mapHead];
  leaves.forEach(function(l){ mapAoa.push([l.id, l.name, genderOf(l.name)].concat(MARKETS.map(function(){return '';}))); });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mapAoa), '매핑');
  var fname='카테고리매핑_'+siteName.replace(/[^\w가-힣.]/g,'')+'_'+stampNow()+'.xlsx';
  XLSX.writeFile(wb, fname);
  var total=MARKETS.reduce(function(s,m){return s+(catalog[m]?catalog[m].length:0);},0);
  setStat('엑셀 내보냄: '+fname+' — 카탈로그 '+total+'건 · 리프 '+leaves.length+'개. 이 파일을 Claude에게 주고 매핑 시트를 채워 오세요.');
  clr();
}

// =========================================================================
// Apply: 매핑 엑셀 로드 → 카탈로그로 경로→코드 해석 → 리프별 주입·저장
// =========================================================================
function parseMappingWorkbook(wb){
  function sheet(nm){ var s=wb.Sheets[nm]; return s?XLSX.utils.sheet_to_json(s,{header:1,defval:''}):null; }
  var catRows=sheet('카탈로그'); var mapRows=sheet('매핑');
  if(!catRows||!mapRows) throw new Error('시트(카탈로그/매핑)를 찾지 못했습니다.');
  // 카탈로그: {marketCode: {path: code}}
  var catalog={}; MARKETS.forEach(function(m){ catalog[m]={}; });
  for(var i=1;i<catRows.length;i++){ var r=catRows[i]; var mc=LABEL2M[String(r[0]).trim()]; if(!mc) continue; var path=String(r[1]).trim(); var code=String(r[2]).trim(); if(path&&code) catalog[mc][path]=code; }
  // 매핑: 헤더로 마켓 열 인덱스 찾기
  var head=mapRows[0].map(function(x){return String(x).trim();});
  var idIdx=head.indexOf('리프ID'), nameIdx=head.indexOf('경로명');
  var mCol={}; MARKETS.forEach(function(m){ mCol[m]=head.indexOf(MLABEL[m]); });
  var queue=[];
  for(var j=1;j<mapRows.length;j++){
    var row=mapRows[j]; var id=String(row[idIdx]||'').trim(); if(!/^\d{18}$/.test(id)) continue;
    var map={}; MARKETS.forEach(function(m){ var ci=mCol[m]; var val=ci>=0?String(row[ci]||'').trim():''; if(val) map[m]=val; });
    if(Object.keys(map).length) queue.push({ id:id, name:String(row[nameIdx]||'').trim(), map:map });  // 매핑이 지정된 리프만 처리(빈 리프 건너뜀)
  }
  return { catalog:catalog, queue:queue };
}
function setUrl(item){ return DIR()+'admin_category_set.php?category_id='+item.id+'&ps_uid='+(item.psUid||'new')+'&tm='; }

async function applyLeaf(state){
  var item=state.queue[state.idx];
  setStat('['+(state.idx+1)+'/'+state.queue.length+'] '+item.name+' — 코드 주입...');
  var applied=0, missing=[];
  MARKETS.forEach(function(m){
    var path=item.map[m]; if(!path) return;
    var code=(state.catalog[m]||{})[path];
    if(!code){ missing.push(MLABEL[m]+':'+path); return; }
    if(injectCode(m, code, path)) applied++;
  });
  // 고시 상품군/참조
  await waitNotifyGroups(9000);
  ensureNotifyGroups(item.name);
  var referTargets=[]; [].concat(['11ST','LTON']).forEach(function(m){ if(!NOTIFY_EXEMPT[m] && hasCategory(m)) referTargets.push(m); });
  if(referTargets.length){ await sleep(1200); applyNotifyRefer(referTargets); await sleep(400); }

  var rec={id:item.id, name:item.name, applied:applied, missing:missing};
  var form=document.market_category || document.querySelector('form[name=market_category]');
  var fc=''; try{ fc=(typeof form_check==='function')?form_check():''; }catch(e){ fc=''; }
  if(fc){ ensureNotifyGroups(item.name); await sleep(1200); applyNotifyRefer(marketsNeedingGroup()); await sleep(500); try{ fc=(typeof form_check==='function')?form_check():''; }catch(e){ fc=''; } }
  if(fc){   // 재시도 후에도 실패 → 문제 마켓을 하나씩 드롭하고 나머지 저장(리프 통째 스킵 방지)
    var guard=0;
    while(fc && guard++<12){
      var offM=null; for(var gi=0; gi<MARKETS.length; gi++){ if(fc.indexOf(MLABEL[MARKETS[gi]])>=0){ offM=MARKETS[gi]; break; } }
      if(!offM) break;
      clearMarket(offM); (rec.dropped=rec.dropped||[]).push(MLABEL[offM]);
      await sleep(150); try{ fc=(typeof form_check==='function')?form_check():''; }catch(e){ fc=''; }
    }
    if(fc){ rec.saved=false; rec.err='검증실패(드롭후에도): '+fc; state.log.push(rec); state.fail++; setStat('저장검증 실패: '+fc); return false; }
  }
  try{
    var body=serializeForm(form);
    var action=new URL(form.getAttribute('action')||'admin_category_ok.php', location.href).href;
    var resp=await fetch(action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:body.toString()});
    rec.saved=(resp.status===200); if(!rec.saved) rec.err='HTTP '+resp.status;
    state.log.push(rec); if(rec.saved) state.ok++; else state.fail++;
    return rec.saved;
  }catch(e){ rec.saved=false; rec.err=String(e); state.log.push(rec); state.fail++; return false; }
}

async function runApplyPage(){
  var state=gs(); if(!state || state.mode!=='apply' || !state.running) return;
  var m=location.search.match(/category_id=(\d+)/); var curId=m?m[1]:null;
  if(state.idx>=state.queue.length){ finishApply(state); return; }
  var want=state.queue[state.idx];
  // ps_uid 확보(미매핑=new, 기존=고유). 리프별 신규생성/편집.
  if(want.psUid===undefined){ var inf=await leafInfo(want.id); want.psUid=inf.psUid; ss(state); }
  if(curId!==String(want.id)){ location.href=setUrl(want); return; }
  panelMini(state);
  await sleep(1200);
  if(!gs()||!gs().running){ stopApply(state,'정지되었습니다.'); return; }
  await applyLeaf(state);
  var latest=gs(); if(latest && latest.running===false){ state.idx++; stopApply(state,'정지 — 성공 '+state.ok+'·실패 '+state.fail); return; }
  state.idx++; ss(state); panelMini(state);
  if(state.idx>=state.queue.length){ finishApply(state); return; }
  var nxt=state.queue[state.idx]; var inf2=await leafInfo(nxt.id); nxt.psUid=inf2.psUid; ss(state);
  await sleep(300); location.href=setUrl(nxt);
}
function stopApply(state,msg){ state.running=false; ss(state); setStat(msg||'정지'); try{ console.log('[TMG 파일적용] 로그',JSON.stringify(state.log)); }catch(e){} if(location.pathname.indexOf('admin_category_set.php')>=0){ setTimeout(function(){ location.href=DIR()+'admin_category_new.php'; },1200); } }
function finishApply(state){ state.running=false; ss(state); setStat('적용 완료 — 총 '+state.queue.length+' | 성공 '+state.ok+' · 실패 '+state.fail+'. 트리 페이지에서 "실제 저장값 평가"로 검증하세요.'); try{ console.log('[TMG 파일적용] 로그',JSON.stringify(state.log)); }catch(e){} if(location.pathname.indexOf('admin_category_set.php')>=0){ setTimeout(function(){ location.href=DIR()+'admin_category_new.php'; },1500); } }

// =========================================================================
// 되읽기 검증 (기존 로직 재사용)
// =========================================================================
async function scanLeafActual(id, psUid){
  var url=DIR()+'admin_category_set.php?category_id='+id+'&ps_uid='+(psUid||'new')+'&tm=';
  var html=await fetch(url,{credentials:'same-origin'}).then(function(r){return r.text();});
  var doc=new DOMParser().parseFromString(html,'text/html');
  var chosen={};
  MARKETS.forEach(function(m){
    var sel=doc.getElementById('openmarket_category_search_list_'+m);
    var txt=(sel&&sel.options.length)?((sel.options[sel.selectedIndex]||sel.options[0]).text||'').trim():'';
    if(!/변경해\s*주세요/.test(txt) && txt.indexOf('>')<0) txt='';
    chosen[MLABEL[m]]=txt;
  });
  return chosen;
}
function csvq(s){ s=(s==null?'':String(s)); return '"'+s.replace(/"/g,'""')+'"'; }
function download(name,text){ var b=new Blob([text],{type:'text/plain;charset=utf-8'}); var u=URL.createObjectURL(b); var a=document.createElement('a'); a.href=u; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){URL.revokeObjectURL(u);},1000); }
async function runReadback(){
  var sites=listSites(); var sv=(q('#tmgSite')&&q('#tmgSite').value)||''; var site=sites.filter(function(s){return s.short===sv;})[0]||sites[0];
  if(!site){ setStat('사이트 없음'); return; }
  setStat('['+site.name+'] 되읽기 — 리프 열거...');
  var leaves; try{ leaves=await enumerateLeaves(site.short); }catch(e){ setStat('탐색 실패: '+e.message); return; }
  for(var bi=0;bi<leaves.length;bi+=8){ var batch=leaves.slice(bi,bi+8); var infos=await Promise.all(batch.map(function(l){return leafInfo(l.id);})); infos.forEach(function(inf,j){ batch[j].psUid=inf.psUid; }); setStat('매핑상태 확인 '+Math.min(bi+8,leaves.length)+'/'+leaves.length); }
  var INVALID=/변경해\s*주세요/; var flags=[]; var cols=['리프ID','경로명','성별'].concat(MARKETS.map(function(m){return MLABEL[m];}));
  var csv='﻿'+cols.map(csvq).join(',')+'\n';
  for(var i=0;i<leaves.length;i++){
    setStat('실제 저장값 읽는 중 '+(i+1)+'/'+leaves.length+' — '+leaves[i].name);
    var ch; try{ ch=await scanLeafActual(leaves[i].id, leaves[i].psUid); }catch(e){ ch={}; }
    var row=[leaves[i].id, leaves[i].name, genderOf(leaves[i].name)].concat(MARKETS.map(function(m){ return ch[MLABEL[m]]||''; }));
    csv+=row.map(csvq).join(',')+'\n';
    MARKETS.forEach(function(m){ var v=ch[MLABEL[m]]||''; if(!v) flags.push([leaves[i].name,MLABEL[m],'미매핑']); else if(INVALID.test(v)) flags.push([leaves[i].name,MLABEL[m],'사이트무효']); else if(!isFootwearCat(v)) flags.push([leaves[i].name,MLABEL[m],'비-신발오분류:'+v]); });
    if(i%10===9) await sleep(80);
  }
  var stamp=stampNow(); var tag=site.name.replace(/[^\w가-힣.]/g,'');
  download('적용검증_실제저장값_'+tag+'_'+stamp+'.csv', csv);
  var rep='적용 검증 리포트 · '+site.name+' · 리프 '+leaves.length+' · '+stamp+'\n\n미매핑/무효/비-신발 이상: '+flags.length+'건\n\n'+flags.map(function(f){return '- '+f[0]+' | '+f[1]+': '+f[2];}).join('\n');
  download('적용검증_이상_'+tag+'_'+stamp+'.txt', rep);
  setStat('되읽기 검증 완료 — 리프 '+leaves.length+' · 이상 '+flags.length+'건 (파일 2개)');
}

// =========================================================================
// UI
// =========================================================================
function setStat(m){ var s=q('#tmgStat'); if(s) s.textContent=m; var s2=q('#tmgStat2'); if(s2) s2.textContent=m; }
function panelTree(){
  if(q('#tmgFilePanel')) return;
  var sites=listSites(); var opts=sites.map(function(s){return '<option value="'+s.short+'">'+s.name+'</option>';}).join('');
  var p=document.createElement('div'); p.id='tmgFilePanel';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #6f42c1;border-radius:8px;padding:10px 12px;width:320px;font:12px/1.6 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold;margin-bottom:6px">카테고리매핑 · 파일기반 v2</div>'
   +'<div style="margin-bottom:4px">사이트: <select id="tmgSite">'+opts+'</select></div>'
   +'<div style="margin-bottom:6px;border-top:1px solid #eee;padding-top:6px"><b>① 수집(Export)</b><br><button id="tmgExport">카탈로그+대상 엑셀 내보내기</button><br><span style="color:#888;font-size:11px">마켓 검색이 필요해 설정페이지로 이동해 수집합니다.</span></div>'
   +'<div style="margin-bottom:6px;border-top:1px solid #eee;padding-top:6px"><b>③ 적용(Apply)</b><br><input type="file" id="tmgFile" accept=".xlsx"><br><button id="tmgApply">매핑파일대로 적용 시작</button> <button id="tmgStop" style="color:#d9534f">정지</button></div>'
   +'<div style="border-top:1px solid #eee;padding-top:6px"><button id="tmgEval">실제 저장값 되읽기 검증</button></div>'
   +'<div id="tmgStat" style="margin-top:8px;color:#333;min-height:32px">대기중</div>'
   +'<div style="margin-top:6px;color:#888;font-size:11px">순서: ①엑셀 내보내기 → Claude가 매핑 시트 채움 → ③그 엑셀 불러와 적용 → 되읽기 검증.</div>';
  document.body.appendChild(p);
  q('#tmgExport').onclick=async function(){ var s=q('#tmgSite'); var sites=listSites(); var site=sites.filter(function(x){return x.short===s.value;})[0]||sites[0]; if(!site){ setStat('사이트 없음'); return; } setStat('['+site.name+'] 리프 열거 중...'); var leaves; try{ leaves=await enumerateLeaves(site.short); }catch(e){ setStat('리프 열거 실패: '+e.message); return; } if(!leaves.length){ setStat('리프 없음'); return; } var first=leaves[0]; var inf=await leafInfo(first.id); ss({mode:'export', siteShort:site.short, siteName:site.name, leaves:leaves}); setStat('설정페이지로 이동해 카탈로그 수집을 시작합니다...'); location.href=DIR()+'admin_category_set.php?category_id='+first.id+'&ps_uid='+inf.psUid+'&tm='; };
  q('#tmgApply').onclick=function(){ var f=q('#tmgFile').files[0]; if(!f){ setStat('먼저 매핑 엑셀(.xlsx)을 선택하세요.'); return; } var rd=new FileReader(); rd.onload=async function(e){ try{ var wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'}); var pr=parseMappingWorkbook(wb); if(!pr.queue.length){ setStat('매핑 시트에서 유효한 리프 행을 못 찾았습니다.'); return; } if(!_nativeConfirm('매핑 적용을 시작합니다.\n리프 '+pr.queue.length+'개 · 카탈로그 로드됨.\n설정페이지를 순차 이동하며 저장합니다. 시작할까요?')){ setStat('취소됨'); return; } setStat('첫 리프 상태 확인 중...'); var inf0=await leafInfo(pr.queue[0].id); pr.queue[0].psUid=inf0.psUid; ss({mode:'apply', running:true, idx:0, ok:0, fail:0, queue:pr.queue, catalog:pr.catalog, log:[]}); setStat('적용 시작 — 리프 '+pr.queue.length+'개'); location.href=setUrl(pr.queue[0]); }catch(err){ setStat('엑셀 파싱 실패: '+(err&&err.message||err)); } }; rd.readAsArrayBuffer(f); };
  q('#tmgStop').onclick=function(){ var s=gs(); if(s){ s.running=false; ss(s); } setStat('정지 요청됨.'); };
  q('#tmgEval').onclick=function(){ runReadback(); };
}
function panelSetExport(){
  if(q('#tmgSetPanel')) return;
  var p=document.createElement('div'); p.id='tmgSetPanel';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #6f42c1;border-radius:8px;padding:10px 12px;width:320px;font:12px/1.5 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold">카탈로그 수집(Export) 진행중</div><div id="tmgStat" style="margin-top:6px;color:#333;min-height:40px"></div>';
  document.body.appendChild(p);
}
function panelMini(state){
  if(q('#tmgMini')) return;
  var p=document.createElement('div'); p.id='tmgMini';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #6f42c1;border-radius:8px;padding:8px 10px;width:300px;font:12px/1.5 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold">매핑 적용 진행중</div><div id="tmgStat2" style="margin-top:6px;color:#333;min-height:32px"></div><button id="tmgStop2" style="color:#d9534f;margin-top:6px">정지</button>';
  document.body.appendChild(p);
  q('#tmgStop2').onclick=function(){ var s=gs(); if(s){ s.running=false; ss(s); } setStat('정지 요청됨 — 현재 항목 후 멈춤.'); };
}

function boot(){
  if(location.pathname.indexOf('admin_category_new.php')>=0){ panelTree(); return; }
  if(location.pathname.indexOf('admin_category_set.php')>=0){
    var st=gs();
    if(st && st.mode==='export'){ panelSetExport(); setTimeout(runExport, 800); return; }
    if(st && st.mode==='apply' && st.running){ panelMini(st); runApplyPage(); return; }
  }
}
if(document.readyState==='complete') boot(); else window.addEventListener('load', boot);
})();
