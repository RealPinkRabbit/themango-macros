// ==UserScript==
// @name         더망고 카테고리매핑 자동 파일기반(수집→Claude매핑→적용)
// @namespace    solddeul.tmg
// @version      1.0
// @description  검색필터형(독일자라 등) 오픈마켓 카테고리 매핑을 "규칙 자동선택"이 아니라 "파일 기반 결정론"으로 처리. ① 수집(Export): 마켓별 의류·잡화 카테고리 전체(카탈로그: 경로+코드) + 대상 필터 목록을 엑셀로 내려받음. ② 매핑: Claude가 그 엑셀을 받아 규칙대로 각 필터×마켓에 카탈로그 경로를 채움. ③ 적용(Apply): 매핑 엑셀을 불러오면 카탈로그로 경로→코드를 해석해 필터마다 설정페이지(ps_ftid)에서 주입·고시·저장(fetch-POST). 규칙이 매크로에서 빠져 Claude 판단으로 이동 → 신상품마다 정규식 손볼 필요 없음.
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_group.php*
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_category_set.php*
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function(){
'use strict';

// ---- 네이티브 대화상자 무력화(저장검증/고시가 alert로 렌더러 멈추는 것 방지) ----
var _alerts=[];
var _nativeConfirm=(window.confirm&&window.confirm.bind(window))||function(){return true;};
try{ window.alert=function(m){ _alerts.push(String(m)); }; }catch(e){}
try{ window.confirm=function(){ return true; }; }catch(e){}

var LS='tmg_catmap_auto_file_v1';   // {mode:'export'|'apply', running, idx, ok, fail, queue, catalog, log, targetLabel}
var MARKETS=['AUC20','GMK20','11ST','SMART','COUP','LTON','LFMALL','MUSTIT','SHOPEE','QOO10JP','PLAYAUTO'];
var MLABEL={AUC20:'옥션',GMK20:'G마켓','11ST':'11번가',SMART:'스마트스토어',COUP:'쿠팡',LTON:'롯데ON',LFMALL:'LF몰',MUSTIT:'머스트잇',SHOPEE:'쇼피',QOO10JP:'큐텐JP',PLAYAUTO:'플레이오토'};
var LABEL2M={}; MARKETS.forEach(function(m){ LABEL2M[MLABEL[m]]=m; });
var ENGLISH_MARKETS={SHOPEE:1, MUSTIT:1, QOO10JP:1};

// 카탈로그 스윕 키워드(마켓 무관 union; 안 맞는 건 빈 결과 → 의류·잡화 범위를 폭넓게 커버)
var SWEEP_KR=['티셔츠','셔츠','블라우스','니트','맨투맨','후드','폴로','카디건','탑',
'원피스','점프수트','스커트',
'바지','청바지','반바지','슬랙스','레깅스',
'자켓','코트','점퍼','패딩','아우터',
'가방','백팩','클러치',
'신발','스니커즈','부츠','샌들','슬리퍼','구두','로퍼','힐',
'모자','벨트','양말','선글라스','스카프','주얼리','장갑','넥타이','액세서리',
'수영복','비키니','언더웨어','속옷','의류','패션잡화'];
var SWEEP_EN=['t-shirt','shirt','blouse','knit','sweater','hoodie','polo','dress','skirt','pants','jeans','shorts','jacket','coat','bag','shoes','sneakers','boots','sandals','hat','belt','socks','sunglasses','scarf','jewelry','swimwear','accessories','clothing'];

// 카탈로그 정제(금지/반려/미용/비-패션 도메인 제외 → 의류·패션 맥락만 유지)
var FORBIDDEN=/(어린이|유아|아동|키즈|주니어|도서|서적|e쿠폰|모바일|렌탈|렌터카|배달음식|출산|육아|임산부|임부|위생용품|의료기기|의약품|Baby|Kids|Toddler|Infant|Children|Maternity)/i;
var PET=/(반려|애완|강아지|고양이|반려동물|\bPets?\b)/i;
var BEAUTY=/(화장품|미용|헤어|파마|스킨케어|메이크업|향수|네일)/;
var NONFASHION=/(식품|생필품|가전|디지털|컴퓨터|노트북|휴대폰|가구|주방|생활용품|자동차|공구|문구|완구|장난감|악기|건강식품|상품권|음반|사료|꽃배달|인테리어|캠핑|낚시|자전거)/;
var FASHION_CTX=/패션|의류|여성복|남성복|잡화|가방|신발|슈즈|언더웨어|이너웨어|속옷|란제리|수영|비치|스포츠|주얼리|액세서리|악세|여성|남성|fashion|apparel|clothing|women|men|\bbag|\bshoe|accessor|jewel|swim/i;
function isApparelCat(t){
  if(!t || t.indexOf('>')<0) return false;
  if(FORBIDDEN.test(t)||PET.test(t)||BEAUTY.test(t)||NONFASHION.test(t)) return false;
  return FASHION_CTX.test(t);   // 스윕 키워드가 의류라 결과는 의류 위주 → 맥락 게이트로 노이즈만 차단
}

function gs(){ try{ return JSON.parse(localStorage.getItem(LS))||null; }catch(e){ return null; } }
function ss(s){ localStorage.setItem(LS, JSON.stringify(s)); }
function clr(){ localStorage.removeItem(LS); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function q(s){ return document.querySelector(s); }
function DIR(){ return location.pathname.replace(/[^/]+$/,''); }
function stampNow(){ var d=new Date(), p=function(n){return String(n).padStart(2,'0');}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes()); }

// 필터이름 → 성별/상품유형(매핑 시트 힌트 + 고시 상품군 선택용)
function classify(name){
  var g = name.indexOf('여성')>=0 ? '여성' : (name.indexOf('남성')>=0 ? '남성' : '공용');
  var n=name, base;
  if(/가방/.test(n)) base='가방';
  else if(/신발|스니커즈|운동화/.test(n)) base='신발';
  else if(/수영복|비치웨어|비키니/.test(n)) base='수영복';
  else if(/청바지|데님/.test(n)) base='청바지';
  else if(/반바지|버뮤다|스코츠/.test(n)) base='반바지';
  else if(/스커트/.test(n)) base='스커트';
  else if(/원피스/.test(n)) base='원피스';
  else if(/점프수트/.test(n)) base='점프수트';
  else if(/블레이저|자켓|재킷/.test(n)) base='자켓';
  else if(/코트/.test(n)) base='코트';
  else if(/니트|스웨터|가디건|카디건/.test(n)) base='니트';
  else if(/맨투맨|스웨트셔츠|후드/.test(n)) base='맨투맨';
  else if(/폴로/.test(n)) base='카라티셔츠';
  else if(/티셔츠/.test(n)) base='티셔츠';
  else if(/블라우스/.test(n)) base='블라우스';
  else if(/오버셔츠|셔츠/.test(n)) base='셔츠';
  else if(/모자|캡/.test(n)) base='모자';
  else if(/벨트/.test(n)) base='벨트';
  else if(/양말/.test(n)) base='양말';
  else if(/선글라스|아이웨어/.test(n)) base='선글라스';
  else if(/넥타이/.test(n)) base='넥타이';
  else if(/스카프|반다나|머플러/.test(n)) base='스카프';
  else if(/주얼리|목걸이|귀걸이|반지|팔찌/.test(n)) base='주얼리';
  else if(/액세서리|악세/.test(n)) base='패션소품';
  else if(/바지|슬랙스|린넨|조거|치노|팬츠/.test(n)) base='슬랙스';
  else if(/탑/.test(n)) base=(g==='여성')?'블라우스':'티셔츠';
  else base='의류';
  return { gender:g, base:base };
}

// =========================================================================
// 대상 필터 목록 (admin_group.php)
// =========================================================================
async function buildQueue(targetLabel, onlyUnmapped){
  async function getPage(pg){
    var p=new URLSearchParams();
    p.set('ps_duse','1'); p.set('ft_group','all'); p.set('sch_field','title');
    p.set('ft_sort','modify_des'); p.set('ft_num','100'); p.set('pg',String(pg));
    var h=await fetch(DIR()+'admin_group.php?'+p.toString(),{credentials:'same-origin'}).then(function(r){return r.text();});
    var doc=new DOMParser().parseFromString(h,'text/html');
    var rows=[];
    Array.prototype.slice.call(doc.querySelectorAll('a,button')).forEach(function(b){
      var oc=(b.getAttribute&&b.getAttribute('onclick'))||'';
      var mm=oc.match(/market_mapping_new\((['"])(\d+)\1\)/);
      if(!mm) return;
      var txt=(b.textContent||'').trim();
      var tr=b.closest('tr'); var ni=tr?tr.querySelector('input[type=text]'):null;
      rows.push({id:mm[2], name:ni?ni.value.trim():'', status:txt});
    });
    return rows;
  }
  var all=[], seen={};
  for(var pg=1; pg<=12; pg++){ var r=await getPage(pg); if(!r.length) break; r.forEach(function(x){ if(!seen[x.id]){ seen[x.id]=1; all.push(x); } }); if(r.length<100) break; }
  return all.filter(function(x){
    if(targetLabel && x.name.indexOf(targetLabel)<0) return false;   // 대상 사업자/사이트 라벨(예: 독일자라)
    if(onlyUnmapped && /설정수정/.test(x.status)) return false;        // 설정수정=이미 매핑됨 → 제외
    return true;
  }).map(function(x){ return {id:x.id, name:x.name, status:/설정수정/.test(x.status)?'완료':'미매핑'}; });
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
    r.forEach(function(o){ if(!seen[o.v] && isApparelCat(o.t)){ seen[o.v]=1; cat.push({path:o.t, code:o.v}); } });
  }
  cat.sort(function(a,b){ return a.path<b.path?-1:1; });
  return cat;
}

// =========================================================================
// 저장/고시 (기존 검증 로직 재사용)
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
function groupPrefsFor(base){
  if(/가방|벨트|모자|선글라스|스카프|주얼리|양말|패션소품|넥타이/.test(base||'')) return ['패션잡화','잡화','패션잡화 (모자/벨트/액세서리)','기타 재화'];
  if(/신발|스니커즈|구두|부츠|샌들|슬리퍼|로퍼|힐/.test(base||'')) return ['구두/신발','신발','구두','기타 재화'];
  return ['의류','패션의류','기타 재화'];
}
function ensureNotifyGroups(base){
  var prefs=groupPrefsFor(base); var setM=[];
  marketsNeedingGroup().forEach(function(m){
    var g=document.getElementById('notify_group_no_'+m); if(!g || g.value) return;
    var idx=-1;
    for(var p=0;p<prefs.length && idx<0;p++){ for(var i=0;i<g.options.length;i++){ if((g.options[i].text||'').trim()===prefs[p]){ idx=i; break; } } }
    if(idx<0){ for(var j=0;j<g.options.length;j++){ if(/의류|잡화|기타\s*재화/.test(g.options[j].text||'')){ idx=j; break; } } }
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
function clearMarket(m){   // 저장검증 실패 마켓을 no_category로 비워 form_check 통과(그 마켓만 미매핑, 필터 통째 스킵 방지)
  var sel=document.getElementById('openmarket_category_search_list_'+m); if(!sel) return;
  var opt=Array.prototype.slice.call(sel.options).filter(function(o){return o.value==='no_category'||o.value==='';})[0];
  if(opt){ sel.value=opt.value; } else { var o=document.createElement('option'); o.value='no_category'; o.text='선택안함'; sel.appendChild(o); sel.value='no_category'; }
  try{ sel.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){}
}
function serializeForm(form){ var fd=new FormData(form); var p=new URLSearchParams(); fd.forEach(function(v,k){ if(typeof v==='string') p.append(k,v); }); return p; }

// =========================================================================
// Export: 카탈로그 + 매핑 템플릿 → 엑셀 다운로드
// =========================================================================
async function runExport(){
  var pending=gs(); var targetLabel=(pending&&pending.targetLabel)||'독일자라';
  var queue=(pending&&pending.queue)||[];
  if(!queue.length){ setStat('대상 필터 목록이 비어있습니다. 목록 페이지에서 다시 시작하세요.'); return; }
  // 설정페이지의 마켓 검색 요소/함수가 준비될 때까지 대기(로드 직후엔 없을 수 있음)
  setStat('설정페이지 로딩 대기...');
  var tw=Date.now();
  while(Date.now()-tw<15000){ if(typeof search_category==='function' && document.getElementById('openmarket_category_search_text_AUC20')) break; await sleep(400); }
  setStat('대상 필터 '+queue.length+'개. 마켓 카탈로그 수집 중...');
  var catalog={};
  for(var mi=0; mi<MARKETS.length; mi++){
    var m=MARKETS[mi];
    catalog[m]=await sweepMarket(m, (function(mm){ return function(a,b){ setStat('['+MLABEL[mm]+'] 카탈로그 '+a+'/'+b+' (누적 '+(catalog[mm]?catalog[mm].length:0)+')'); }; })(m));
    setStat('['+MLABEL[m]+'] 완료: '+catalog[m].length+'건 ('+(mi+1)+'/'+MARKETS.length+' 마켓)');
  }
  // --- 워크북 작성 ---
  var wb=XLSX.utils.book_new();
  // 카탈로그 시트
  var catAoa=[['마켓','카테고리경로','코드']];
  MARKETS.forEach(function(m){ (catalog[m]||[]).forEach(function(c){ catAoa.push([MLABEL[m], c.path, String(c.code)]); }); });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(catAoa), '카탈로그');
  // 매핑 시트(필터 행 + 빈 마켓 열 = Claude가 채움)
  var mapHead=['필터ID','필터명','성별','유형','상태'].concat(MARKETS.map(function(m){return MLABEL[m];}));
  var mapAoa=[mapHead];
  queue.forEach(function(f){ var c=classify(f.name); mapAoa.push([f.id, f.name, c.gender, c.base, f.status||''].concat(MARKETS.map(function(){return '';}))); });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mapAoa), '매핑');
  var fname='카테고리매핑_'+String(targetLabel).replace(/[^\w가-힣.]/g,'')+'_'+stampNow()+'.xlsx';
  XLSX.writeFile(wb, fname);
  var total=MARKETS.reduce(function(s,m){return s+(catalog[m]?catalog[m].length:0);},0);
  setStat('엑셀 내보냄: '+fname+' — 카탈로그 '+total+'건 · 필터 '+queue.length+'개. 이 파일을 Claude에게 주고 매핑 시트를 채워 오세요.');
  clr();
}

// =========================================================================
// Apply: 매핑 엑셀 로드 → 카탈로그로 경로→코드 해석 → 필터별 주입·저장
// =========================================================================
function parseMappingWorkbook(wb){
  function sheet(nm){ var s=wb.Sheets[nm]; return s?XLSX.utils.sheet_to_json(s,{header:1,defval:''}):null; }
  var catRows=sheet('카탈로그'); var mapRows=sheet('매핑');
  if(!catRows||!mapRows) throw new Error('시트(카탈로그/매핑)를 찾지 못했습니다.');
  // 카탈로그: {marketCode: {path: code}}
  var catalog={}; MARKETS.forEach(function(m){ catalog[m]={}; });
  for(var i=1;i<catRows.length;i++){ var r=catRows[i]; var mc=LABEL2M[String(r[0]).trim()]; if(!mc) continue; var path=String(r[1]).trim(); var code=String(r[2]).trim(); if(path&&code) catalog[mc][path]=code; }
  // 매핑: 헤더로 열 인덱스 찾기
  var head=mapRows[0].map(function(x){return String(x).trim();});
  var idIdx=head.indexOf('필터ID'), nameIdx=head.indexOf('필터명'), baseIdx=head.indexOf('유형');
  var mCol={}; MARKETS.forEach(function(m){ mCol[m]=head.indexOf(MLABEL[m]); });
  var queue=[];
  for(var j=1;j<mapRows.length;j++){
    var row=mapRows[j]; var id=String(row[idIdx]||'').trim(); if(!/^\d+$/.test(id)) continue;
    var map={}; MARKETS.forEach(function(m){ var ci=mCol[m]; var val=ci>=0?String(row[ci]||'').trim():''; if(val) map[m]=val; });
    if(Object.keys(map).length) queue.push({ id:id, name:String(row[nameIdx]||'').trim(), base:baseIdx>=0?String(row[baseIdx]||'').trim():'', map:map });  // 매핑이 지정된 필터만 처리(빈 필터 건너뜀)
  }
  return { catalog:catalog, queue:queue };
}
function setUrl(item){ return DIR()+'admin_category_set.php?tm=F&ps_ftid='+item.id; }

async function applyFilter(state){
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
  var base=item.base||classify(item.name).base;
  await waitNotifyGroups(9000);
  ensureNotifyGroups(base);
  var referTargets=[]; ['11ST','LTON'].forEach(function(m){ if(!NOTIFY_EXEMPT[m] && hasCategory(m)) referTargets.push(m); });
  if(referTargets.length){ await sleep(1200); applyNotifyRefer(referTargets); await sleep(400); }

  var rec={id:item.id, name:item.name, applied:applied, missing:missing};
  var form=document.market_category || document.querySelector('form[name=market_category]');
  var fc=''; try{ fc=(typeof form_check==='function')?form_check():''; }catch(e){ fc=''; }
  if(fc){ ensureNotifyGroups(base); await sleep(1200); applyNotifyRefer(marketsNeedingGroup()); await sleep(500); try{ fc=(typeof form_check==='function')?form_check():''; }catch(e){ fc=''; } }
  if(fc){   // 재시도 후에도 실패 → 문제 마켓을 하나씩 드롭하고 나머지 저장(필터 통째 스킵 방지)
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
  var m=location.search.match(/ps_ftid=(\d+)/); var curId=m?m[1]:null;
  if(state.idx>=state.queue.length){ finishApply(state); return; }
  var want=state.queue[state.idx];
  if(curId!==String(want.id)){ location.href=setUrl(want); return; }
  panelMini(state);
  await sleep(1200);
  if(!gs()||!gs().running){ stopApply(state,'정지되었습니다.'); return; }
  await applyFilter(state);
  var latest=gs(); if(latest && latest.running===false){ state.idx++; stopApply(state,'정지 — 성공 '+state.ok+'·실패 '+state.fail); return; }
  state.idx++; ss(state); panelMini(state);
  if(state.idx>=state.queue.length){ finishApply(state); return; }
  await sleep(300); location.href=setUrl(state.queue[state.idx]);
}
function stopApply(state,msg){ state.running=false; ss(state); setStat(msg||'정지'); try{ console.log('[TMG 자동파일적용] 로그',JSON.stringify(state.log)); }catch(e){} if(location.pathname.indexOf('admin_category_set.php')>=0){ setTimeout(function(){ location.href=DIR()+'admin_group.php'; },1200); } }
function finishApply(state){ state.running=false; ss(state); setStat('적용 완료 — 총 '+state.queue.length+' | 성공 '+state.ok+' · 실패 '+state.fail+'. 목록 페이지에서 "실제 저장값 되읽기 검증"으로 확인하세요.'); try{ console.log('[TMG 자동파일적용] 로그',JSON.stringify(state.log)); }catch(e){} if(location.pathname.indexOf('admin_category_set.php')>=0){ setTimeout(function(){ location.href=DIR()+'admin_group.php'; },1500); } }

// =========================================================================
// 되읽기 검증 (필터형은 ps_ftid로 서버 스코핑돼 되읽기 신뢰 가능)
// =========================================================================
async function scanFilterActual(id){
  var url=DIR()+'admin_category_set.php?tm=F&ps_ftid='+id;
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
async function runReadback(targetLabel){
  setStat('['+targetLabel+'] 되읽기 — 대상 필터 수집...');
  var queue; try{ queue=await buildQueue(targetLabel, false); }catch(e){ setStat('대상 수집 실패: '+e.message); return; }
  if(!queue.length){ setStat('대상('+targetLabel+') 필터가 없습니다.'); return; }
  var INVALID=/변경해\s*주세요/; var flags=[]; var cols=['필터ID','필터명','성별'].concat(MARKETS.map(function(m){return MLABEL[m];}));
  var csv='﻿'+cols.map(csvq).join(',')+'\n';
  for(var i=0;i<queue.length;i++){
    setStat('실제 저장값 읽는 중 '+(i+1)+'/'+queue.length+' — '+queue[i].name);
    var ch; try{ ch=await scanFilterActual(queue[i].id); }catch(e){ ch={}; }
    var gk=classify(queue[i].name).gender;
    var row=[queue[i].id, queue[i].name, gk].concat(MARKETS.map(function(m){ return ch[MLABEL[m]]||''; }));
    csv+=row.map(csvq).join(',')+'\n';
    MARKETS.forEach(function(m){ var v=ch[MLABEL[m]]||''; if(!v) flags.push([queue[i].name,MLABEL[m],'미매핑']); else if(INVALID.test(v)) flags.push([queue[i].name,MLABEL[m],'사이트무효']); });
    if(i%10===9) await sleep(80);
  }
  var stamp=stampNow(); var tag=String(targetLabel).replace(/[^\w가-힣.]/g,'');
  download('적용검증_실제저장값_'+tag+'_'+stamp+'.csv', csv);
  var rep='적용 검증 리포트 · '+targetLabel+' · 필터 '+queue.length+' · '+stamp+'\n\n미매핑/무효 이상: '+flags.length+'건\n\n'+flags.map(function(f){return '- '+f[0]+' | '+f[1]+': '+f[2];}).join('\n');
  download('적용검증_이상_'+tag+'_'+stamp+'.txt', rep);
  setStat('되읽기 검증 완료 — 필터 '+queue.length+' · 이상 '+flags.length+'건 (파일 2개)');
}

// =========================================================================
// UI
// =========================================================================
function setStat(m){ var s=q('#tmgStat'); if(s) s.textContent=m; var s2=q('#tmgStat2'); if(s2) s2.textContent=m; }
function panelList(){
  if(q('#tmgAfPanel')) return;
  var p=document.createElement('div'); p.id='tmgAfPanel';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #6f42c1;border-radius:8px;padding:10px 12px;width:330px;font:12px/1.6 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold;margin-bottom:6px">카테고리매핑 자동 · 파일기반 v1</div>'
   +'<div style="margin-bottom:6px">대상 라벨: <input id="tmgTarget" type="text" value="독일자라" style="width:110px"> <label style="font-size:11px"><input type="checkbox" id="tmgUnmapped"> 미매핑만</label></div>'
   +'<div style="margin-bottom:6px;border-top:1px solid #eee;padding-top:6px"><b>① 수집(Export)</b><br><button id="tmgExport">카탈로그+대상 엑셀 내보내기</button><br><span style="color:#888;font-size:11px">마켓 검색이 필요해 설정페이지로 이동해 수집(수 분 소요).</span></div>'
   +'<div style="margin-bottom:6px;border-top:1px solid #eee;padding-top:6px"><b>③ 적용(Apply)</b><br><input type="file" id="tmgFile" accept=".xlsx"><br><button id="tmgApply">매핑파일대로 적용 시작</button> <button id="tmgStop" style="color:#d9534f">정지</button></div>'
   +'<div style="border-top:1px solid #eee;padding-top:6px"><button id="tmgEval">실제 저장값 되읽기 검증</button></div>'
   +'<div id="tmgStat" style="margin-top:8px;color:#333;min-height:32px">대기중</div>'
   +'<div style="margin-top:6px;color:#888;font-size:11px">순서: ①엑셀 내보내기 → Claude가 매핑 시트 채움 → ③그 엑셀 불러와 적용 → 되읽기 검증. 진행 중 페이지 이동/팝업은 건드리지 마세요.</div>';
  document.body.appendChild(p);
  q('#tmgExport').onclick=async function(){
    var target=(q('#tmgTarget').value||'').trim()||'독일자라';
    var onlyU=q('#tmgUnmapped').checked;
    setStat('['+target+'] 대상 필터 수집 중...');
    var queue; try{ queue=await buildQueue(target, onlyU); }catch(e){ setStat('대상 수집 실패: '+e.message); return; }
    if(!queue.length){ setStat('대상('+target+') 필터가 없습니다.'); return; }
    var first=queue[0];
    ss({mode:'export', targetLabel:target, queue:queue});
    setStat('필터 '+queue.length+'개. 설정페이지로 이동해 카탈로그 수집을 시작합니다...');
    location.href=DIR()+'admin_category_set.php?tm=F&ps_ftid='+first.id;
  };
  q('#tmgApply').onclick=function(){
    var f=q('#tmgFile').files[0]; if(!f){ setStat('먼저 매핑 엑셀(.xlsx)을 선택하세요.'); return; }
    var rd=new FileReader();
    rd.onload=async function(e){
      try{
        var wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'});
        var pr=parseMappingWorkbook(wb);
        if(!pr.queue.length){ setStat('매핑 시트에서 마켓 칸이 채워진 필터 행을 못 찾았습니다.'); return; }
        if(!_nativeConfirm('매핑 적용을 시작합니다.\n필터 '+pr.queue.length+'개 · 카탈로그 로드됨.\n설정페이지를 순차 이동하며 저장합니다. 시작할까요?')){ setStat('취소됨'); return; }
        ss({mode:'apply', running:true, idx:0, ok:0, fail:0, queue:pr.queue, catalog:pr.catalog, log:[]});
        setStat('적용 시작 — 필터 '+pr.queue.length+'개');
        location.href=setUrl(pr.queue[0]);
      }catch(err){ setStat('엑셀 파싱 실패: '+(err&&err.message||err)); }
    };
    rd.readAsArrayBuffer(f);
  };
  q('#tmgStop').onclick=function(){ var s=gs(); if(s){ s.running=false; ss(s); } setStat('정지 요청됨.'); };
  q('#tmgEval').onclick=function(){ var target=(q('#tmgTarget').value||'').trim()||'독일자라'; runReadback(target); };
}
function panelSetExport(){
  if(q('#tmgSetPanel')) return;
  var p=document.createElement('div'); p.id='tmgSetPanel';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #6f42c1;border-radius:8px;padding:10px 12px;width:330px;font:12px/1.5 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
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
  if(location.pathname.indexOf('admin_group.php')>=0){ panelList(); return; }
  if(location.pathname.indexOf('admin_category_set.php')>=0){
    var st=gs();
    if(st && st.mode==='export'){ panelSetExport(); setTimeout(runExport, 800); return; }
    if(st && st.mode==='apply' && st.running){ panelMini(st); runApplyPage(); return; }
  }
}
if(document.readyState==='complete') boot(); else window.addEventListener('load', boot);
})();
