// ==UserScript==
// @name         더망고 카테고리매핑 자동(필터 순차 + 규칙기반 검수)
// @namespace    solddeul.tmg
// @version      1.3
// @description  검색필터 세부설정의 (오픈)마켓 카테고리 매핑을 자동화. 각 필터: 설정열기(admin_category_set.php)→AI자동매핑→11개 마켓을 규칙(금지어/브랜드 회피·성별 일치·11번가 해외+고시=의류)으로 재선택→fetch-POST 저장→다음. Zara(독일자라) 미매핑 필터만 대상. localStorage로 새로고침을 넘어 진행. 테스트(저장 안 함) 모드 지원. 팝업창은 건드리지 않음.
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_group.php*
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_category_set.php*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function(){
'use strict';

// ---- 네이티브 대화상자 무력화(자동매핑/저장검증이 alert로 렌더러를 멈추는 것 방지) ----
var _alerts=[];
try{ window.alert=function(m){ _alerts.push(String(m)); }; }catch(e){}
try{ window.confirm=function(){ return true; }; }catch(e){}

var LS='tmg_catmap_v1';           // {running, dry, idx, ok, fail, skip, max, queue:[{id,name}], log:[]}
var _stopStart=false;             // 목록페이지 대상수집(buildQueue) 중 정지 요청 플래그(같은 페이지 내 유효)
var MARKETS=['AUC20','GMK20','11ST','SMART','COUP','LTON','LFMALL','MUSTIT','SHOPEE','QOO10JP','PLAYAUTO'];
var MLABEL={AUC20:'옥션',GMK20:'G마켓','11ST':'11번가',SMART:'스마트스토어',COUP:'쿠팡',LTON:'롯데ON',LFMALL:'LF몰',MUSTIT:'머스트잇',SHOPEE:'쇼피',QOO10JP:'큐텐JP',PLAYAUTO:'플레이오토'};
var FORBIDDEN=/(어린이|유아|아동|도서|서적|e쿠폰|모바일|렌탈|렌터카|배달음식|출산|육아|임산부|임부|위생용품|의료기기|의약품|Baby|Kids|Toddler|Infant|Children|Maternity)/i; // [E] 공통 금지어(모바일 전체 + 영어 키즈/임부)
var PET=/(반려|애완|강아지|고양이|반려동물|\bPets?\b)/i; // [B] 반려동물 카테고리 금지(전 마켓, 영어 Pet 포함)
var INVALID_MARK=/(카테고리를\s*변경|변경해주세요)/;    // [A] 사이트가 무효로 표시한 카테고리
var ELEVEN_FORBIDDEN=/(디자이너|biz)/i;                 // [D] 11번가 디자이너/biz 금지

function gs(){ try{ return JSON.parse(localStorage.getItem(LS))||null; }catch(e){ return null; } }
function ss(s){ localStorage.setItem(LS, JSON.stringify(s)); }
function clr(){ localStorage.removeItem(LS); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function q(s){ return document.querySelector(s); }
function DIR(){ return location.pathname.replace(/[^/]+$/,''); }

// =========================================================================
// 분류 & 키워드 (상품유형 → 검색 키워드). 필터이름에서 성별/의류대분류 추출.
// =========================================================================
function classify(name){
  var g = name.indexOf('여성')>=0 ? 'W' : (name.indexOf('남성')>=0 ? 'M' : 'U');
  var gk = g==='W' ? '여성' : (g==='M' ? '남성' : '');
  var n = name;
  var base;
  if(/가방/.test(n)) base='가방';
  else if(/애슬레틱/.test(n)){ base = /신발/.test(n)?'스니커즈' : (/트레이닝/.test(n)?'트레이닝' : (/양말|타이츠/.test(n)?'양말':'트레이닝')); }
  else if(/신발|스니커즈/.test(n)) base='스니커즈';
  else if(/수영복|비치웨어/.test(n)){ base = /가방/.test(n)?'가방':'수영복'; }
  else if(/청바지|데님/.test(n)) base='청바지';
  else if(/반바지|버뮤다|스코츠/.test(n)) base='반바지';
  else if(/스커트/.test(n)) base='스커트';
  else if(/원피스/.test(n)) base='원피스';
  else if(/점프수트/.test(n)) base='점프수트';
  else if(/보디수트/.test(n)) base='보디수트';
  else if(/코디세트/.test(n)) base='세트';
  else if(/블레이저|자켓|재킷/.test(n)) base='자켓';
  else if(/코트아우터|코트/.test(n)) base='코트';
  else if(/니트/.test(n)) base='니트';
  else if(/스웨트셔츠|맨투맨/.test(n)) base='맨투맨';
  else if(/폴로/.test(n)) base='카라티셔츠';
  else if(/티셔츠/.test(n)) base='티셔츠';
  else if(/탑/.test(n)) base = g==='W'?'블라우스':'티셔츠';
  else if(/오버셔츠/.test(n)) base='셔츠';
  else if(/수트/.test(n)){ base = /액세서리/.test(n)?'넥타이':'셔츠'; }
  else if(/셔츠/.test(n)) base='셔츠';
  else if(/액세서리/.test(n)){
    base = /모자/.test(n)?'모자' : /벨트/.test(n)?'벨트' : /양말/.test(n)?'양말' : /선글라스/.test(n)?'선글라스'
         : /넥타이/.test(n)?'넥타이' : /반다나|스카프/.test(n)?'스카프' : /주얼리/.test(n)?'주얼리' : '패션소품';
  }
  else if(/바지|린넨|슬랙스|조거|치노|팬츠/.test(n)) base='슬랙스';
  else base='의류';
  return { gender:g, keyword:(gk?gk+' ':'')+base, base:base };
}

// =========================================================================
// [H] 유형(가먼트 계열) — 상충 카테고리 회피 + 올바른 계열 가점
// =========================================================================
var FAM={
  TOP:/티셔츠|셔츠|블라우스|니트|맨투맨|스웨트|후드|폴로|나시|카디건|상의|탑|t-?shirt|tee|shirt|blouse|knit|sweater|hoodie|polo/i,
  OUTER:/코트|자켓|재킷|점퍼|패딩|블레이저|아우터|야상|바람막이|coat|jacket|blazer|outerwear|parka|padding/i,
  BOTTOM:/바지|팬츠|반바지|청바지|슬랙스|데님|레깅스|조거|치노|숏팬츠|핫팬츠|하의|pants|trouser|jeans|denim|leggings|shorts|slacks|jogger|chino|bottoms/i,
  SKIRT:/스커트|치마|skirt/i,
  DRESS:/원피스|드레스|점프수트|점프슈트|jumpsuit|dress|romper|bodysuit/i,
  SHOES:/신발|스니커즈|운동화|구두|부츠|샌들|슬리퍼|로퍼|힐|슈즈|shoes?|boots?|sneaker|loafer|sandal|slipper|heel|flip ?flop/i,
  BAG:/가방|백팩|클러치|토트|숄더|크로스백|핸드백|파우치|bag|backpack|tote|clutch|handbag|luggage/i,
  ACC:/모자|캡|비니|벨트|양말|선글라스|아이웨어|넥타이|타이|스카프|머플러|목도리|장갑|주얼리|액세서리|악세|패션소품|잡화|acc|hat|\bcap\b|beanie|belt|socks|sunglass|necktie|bow ?tie|scarf|jewelry|accessor/i,
  SWIM:/수영|비치|스윔|비키니|래시가드|보드숏|swim|bikini|beach/i
};
// base → 기대 계열(명확한 것만; 보디수트/세트/의류 등 모호한 것은 제외해 강제 재검색 방지)
var BASE_FAM={'가방':'BAG','스니커즈':'SHOES','양말':'ACC','수영복':'SWIM','청바지':'BOTTOM','반바지':'BOTTOM','스커트':'SKIRT','원피스':'DRESS','점프수트':'DRESS','자켓':'OUTER','코트':'OUTER','니트':'TOP','맨투맨':'TOP','카라티셔츠':'TOP','티셔츠':'TOP','블라우스':'TOP','셔츠':'TOP','넥타이':'ACC','슬랙스':'BOTTOM','모자':'ACC','벨트':'ACC','선글라스':'ACC','스카프':'ACC','주얼리':'ACC','패션소품':'ACC'};
// base → 동의어/연관어(부분일치 가점용)
var BASE_SYN={
 '반바지':/반바지|숏팬츠|핫팬츠|버뮤다|하프팬츠|치마바지|보드숏|shorts/i,
 '슬랙스':/슬랙스|슬랙|팬츠|바지|치노|조거|린넨|와이드|pants|trouser|slacks|chino|jogger/i,
 '청바지':/청바지|데님|진|jean|denim/i,
 '스커트':/스커트|치마|skirt/i,
 '원피스':/원피스|드레스|dress/i,
 '점프수트':/점프수트|점프슈트|jumpsuit|올인원|롬퍼|romper/i,
 '자켓':/자켓|재킷|블레이저|jacket|blazer/i,
 '코트':/코트|coat/i,
 '니트':/니트|스웨터|가디건|카디건|knit|sweater|cardigan/i,
 '맨투맨':/맨투맨|스웨트|후드|기모|sweatshirt|hoodie/i,
 '카라티셔츠':/폴로|카라|피케|polo/i,
 '티셔츠':/티셔츠|t-?shirt|tee/i,
 '블라우스':/블라우스|셔츠|탑|blouse|shirt/i,
 '셔츠':/셔츠|블라우스|shirt|blouse/i,
 '가방':/가방|백팩|토트|숄더|크로스|클러치|핸드백|파우치|bag|backpack|tote|handbag/i,
 '스니커즈':/스니커즈|운동화|신발|슈즈|스니커|sneaker|shoes/i,
 '넥타이':/넥타이|necktie|bow ?tie|cravat/i,
 '벨트':/벨트|belt/i,
 '모자':/모자|캡|비니|햇|hat|\bcap\b|beanie/i,
 '선글라스':/선글라스|아이웨어|sunglass|eyewear/i,
 '스카프':/스카프|머플러|목도리|반다나|scarf|muffler/i,
 '주얼리':/주얼리|목걸이|귀걸이|반지|팔찌|jewelry|necklace|earring/i,
 '양말':/양말|삭스|socks/i,
 '수영복':/수영복|비키니|스윔|비치|래시가드|swim|bikini/i,
 '패션소품':/소품|잡화|액세서리|악세|accessor/i
};
function famOfBase(base){ return BASE_FAM[base]||null; }
function famsOf(text){ var r=[]; for(var k in FAM){ if(FAM[k].test(text)) r.push(k); } return r; }
// 후보가 기대 계열과 '다른 가먼트 계열'에 속하는가(명백한 상충일 때만 true → 재검색 트리거)
function conflictFam(base, text){
  var ef=famOfBase(base); if(!ef || !text) return false;
  var fams=famsOf(text);
  if(fams.indexOf(ef)>=0) return false; // 기대 계열 포함 → 정상
  return fams.length>0;                 // 기대 계열 없이 다른 계열만 → 상충
}
// 계열 일반 검색어(base가 너무 좁아 검색이 비거나 남성만 나올 때 폭을 넓힘)
var FAM_KW={BOTTOM:'바지',DRESS:'원피스',SKIRT:'스커트',OUTER:'자켓',TOP:'상의',SHOES:'신발',BAG:'가방',SWIM:'수영복'};
function famGeneralKw(base, gender){
  var ef=famOfBase(base); if(!ef || !FAM_KW[ef]) return null;
  var g = gender==='W' ? '여성 ' : (gender==='M' ? '남성 ' : '');
  return g+FAM_KW[ef];
}
// 영어권 마켓(쇼피/머스트잇)은 한글 검색이 안 먹어 영어 키워드 필요
var ENGLISH_MARKETS={SHOPEE:1, MUSTIT:1};
var ENG_BASE={'가방':'bag','스니커즈':'sneakers','반바지':'shorts','슬랙스':'pants','청바지':'jeans','스커트':'skirt','원피스':'dress','점프수트':'jumpsuit','보디수트':'bodysuit','자켓':'jacket','코트':'coat','니트':'knit','맨투맨':'sweatshirt','카라티셔츠':'polo','티셔츠':'t-shirt','블라우스':'blouse','셔츠':'shirt','넥타이':'necktie','벨트':'belt','모자':'hat','선글라스':'sunglasses','스카프':'scarf','주얼리':'jewelry','양말':'socks','수영복':'swimwear'};
function engKws(base){ var e=ENG_BASE[base]; return e?[e]:[]; }

// =========================================================================
// 규칙: 후보 카테고리 텍스트가 이 마켓·성별에 허용되는가
// =========================================================================
function acceptable(market, text, gender){
  if(!text) return false;
  if(FORBIDDEN.test(text)) return false;        // [E] 공통 금지어
  if(PET.test(text)) return false;              // [B] 반려동물
  if(INVALID_MARK.test(text)) return false;     // [A] 사이트 무효 표시
  if(market==='11ST' && ELEVEN_FORBIDDEN.test(text)) return false; // [D] 11번가 디자이너/biz
  if((market==='AUC20'||market==='GMK20') && /브랜드/.test(text)) return false; // [C] 옥션/지마켓 '브랜드' 포함 금지
  // [F] 성별 상충 배제
  var hasW=/여성|여자|Women|Woman|레이디|Ladies/i.test(text);
  var hasM=/남성|남자|\bMen\b|\bMan\b/i.test(text);
  if(gender==='W' && hasM && !hasW) return false;
  if(gender==='M' && hasW && !hasM) return false;
  return true;
}
// 후보 점수: 11번가 '해외' 우선 + 올바른 계열 가점 + 상충 계열 감점 + base/동의어 포함 + 성별 일치
function catScore(market, text, gender, base){
  var s=0;
  if(market==='11ST' && /해외/.test(text)) s+=5;
  var ef=famOfBase(base);
  if(ef){ var fams=famsOf(text); if(fams.indexOf(ef)>=0) s+=4; else if(fams.length) s-=3; }
  if(base && text.indexOf(base)>=0) s+=2;
  var syn=BASE_SYN[base]; if(syn && syn.test(text)) s+=2;
  if(gender==='W' && /여성|Women/i.test(text)) s+=1;
  if(gender==='M' && /남성|Men/i.test(text)) s+=1;
  if(/fashion|apparel|clothes|clothing|\bbags?\b|의류|여성복|남성복|잡화/i.test(text)) s+=1;   // 의류/패션 맥락 우대(영어권 노이즈 구분)
  if(/automobile|motorcycle|beauty|makeup|\bhome\b|grocery|food|stationery|hair access|utilities|sports ?& ?outdoor recreation/i.test(text)) s-=2; // 비의류 도메인 감점
  var depth=(text.match(/>/g)||[]).length; s += Math.min(depth,4)*0.25; // 더 구체적인(깊은) 리프 선호 (스마트스토어 비-리프 회피)
  return s;
}
// 허용 후보 중 최고 점수 선택
function pickBest(market, opts, gender, base){
  var ok=opts.filter(function(o){ return acceptable(market, o.text, gender); });
  if(!ok.length) return null;
  ok.sort(function(a,b){ return catScore(market,b.text,gender,base)-catScore(market,a.text,gender,base); });
  return ok[0];
}

// =========================================================================
// 설정 페이지 동작
// =========================================================================
function listOpts(market){
  var sel=document.getElementById('openmarket_category_search_list_'+market);
  if(!sel) return {sel:null, opts:[]};
  return { sel:sel, opts:Array.prototype.slice.call(sel.options).map(function(o,i){ return {i:i, text:(o.text||'').trim(), val:o.value}; }).filter(function(o){ return o.text.indexOf('>')>=0; }) };
}
function selectOpt(market, idx){
  var sel=document.getElementById('openmarket_category_search_list_'+market);
  sel.selectedIndex=idx; sel.dispatchEvent(new Event('change',{bubbles:true}));
}
function doSearch(market, keyword){
  var inp=document.getElementById('openmarket_category_search_text_'+market);
  if(!inp) return false;
  inp.value=keyword;
  try{ search_category(market,'openmarket_category_search_list_'+market,''); }catch(e){ return false; }
  return true;
}
async function waitAutomap(){
  // 자동매핑 완료 판정: 주요 마켓 결과목록에 카테고리 옵션이 채워질 때까지 폴링
  var t0=Date.now();
  while(Date.now()-t0<25000){
    var a=listOpts('AUC20').opts.length, b=listOpts('SMART').opts.length, c=listOpts('COUP').opts.length;
    if(a>0 && b>0 && c>0) return true;
    await sleep(700);
  }
  return false;
}
async function waitSearch(market, prevSig){
  var t0=Date.now();
  while(Date.now()-t0<8000){
    var opts=listOpts(market).opts;
    var sig=opts.map(function(o){return o.text;}).join('|');
    if(opts.length && sig!==prevSig && !/검색중/.test(sig)) return opts;
    await sleep(500);
  }
  return listOpts(market).opts;
}

// ---- 고시 상품군(notify_group) 보장 ----
// form_check: 면제 외 마켓의 카테고리가 지정되면 notify_group_no가 반드시 채워져 있어야 통과.
// automap이 상품군을 비동기로 채우므로(≈수 초) 저장 전에 (1) 채워질 때까지 대기하고 (2) 그래도 빈 곳은 직접 채운다.
var NOTIFY_EXEMPT={CAFE24:1,MUSTIT:1,HAKYUNG:1,REEBONZ:1,BALAAN:1,TRENBE:1,SHOPEE:1,QOO10JP:1,SHOPIFY:1};
function needsNotify(market){ return !NOTIFY_EXEMPT[market]; }
function hasCategory(market){ var sel=document.getElementById('openmarket_category_search_list_'+market); return !!(sel && sel.value && sel.value!=='no_category'); }
function groupSet(market){ var g=document.getElementById('notify_group_no_'+market); return !!(g && g.value); }
// 카테고리가 지정된 비면제 마켓 목록
function marketsNeedingGroup(){
  return MARKETS.filter(function(m){ return needsNotify(m) && hasCategory(m); });
}
// automap의 상품군 채움을 대기(자동설정 값을 최대한 활용)
async function waitNotifyGroups(timeout){
  var t0=Date.now();
  while(Date.now()-t0<(timeout||9000)){
    var pend=marketsNeedingGroup().filter(function(m){ return !groupSet(m); });
    if(!pend.length) return true;
    await sleep(600);
  }
  return false;
}
// 상품유형에 맞는 고시 상품군 후보 텍스트(우선순위)
function groupPrefFor(base){
  if(/가방|벨트|모자|선글라스|스카프|주얼리|양말|패션소품|넥타이/.test(base)) return ['패션잡화','잡화','패션잡화 (모자/벨트/액세서리)','기타 재화'];
  if(/스니커즈|신발|구두/.test(base)) return ['구두/신발','신발','구두','기타 재화'];
  return ['의류','패션의류','기타 재화'];
}
// 여전히 빈 상품군을 직접 채움(automap 지연/실패 대비). 직접 채운 마켓 목록을 반환.
function ensureNotifyGroups(cls){
  var prefs=groupPrefFor(cls?cls.base:'');
  var setM=[];
  marketsNeedingGroup().forEach(function(m){
    var g=document.getElementById('notify_group_no_'+m);
    if(!g || g.value) return; // 이미 채워졌으면 automap 값 보존
    var idx=-1;
    for(var p=0;p<prefs.length && idx<0;p++){
      for(var i=0;i<g.options.length;i++){ if((g.options[i].text||'').trim()===prefs[p]){ idx=i; break; } }
    }
    if(idx<0){ for(var j=0;j<g.options.length;j++){ if(/의류|잡화|기타\s*재화/.test(g.options[j].text||'')){ idx=j; break; } } }
    if(idx<0){ for(var k=0;k<g.options.length;k++){ if(g.options[k].value){ idx=k; break; } } }
    if(idx>=0){ g.selectedIndex=idx; g.dispatchEvent(new Event('change',{bubbles:true})); setM.push(m); }
  });
  return setM;
}
// ★ 상품군을 직접 지정한 마켓(주로 11번가·롯데ON)은 상품군 change 시 get_notify_item이 고시 항목을 로드하는데,
//   대표님 절차대로 "상품상세페이지 참조" 마스터 체크박스를 체크해 고시 정보를 확정한다.
//   (마스터 체크박스 onclick = chk_refer('all', el, '{M}_input_notify', '상품상세페이지 참조'))
function applyNotifyRefer(markets){
  (markets||[]).forEach(function(m){
    var master=document.getElementById(m+'_input_notify');
    if(!master) return;
    if(!master.checked){ master.checked=true; }
    try{
      if(typeof chk_refer==='function'){ chk_refer('all', master, m+'_input_notify', '상품상세페이지 참조'); }
      else { master.dispatchEvent(new Event('click',{bubbles:true})); }
    }catch(e){}
  });
}

// 마켓 전체목록(list2, 주로 11번가에만 채워짐)에서 최적 허용 후보
function bestFromFull(market, gender, base){
  var s=document.getElementById('openmarket_category_search_list2_'+market);
  if(!s || s.options.length<10) return null;
  var opts=Array.prototype.slice.call(s.options).map(function(o){ return {text:(o.text||'').trim(), val:o.value}; }).filter(function(o){ return o.text.indexOf('>')>=0; });
  var ok=opts.filter(function(o){ return acceptable(market, o.text, gender); });
  if(!ok.length) return null;
  ok.sort(function(a,b){ return catScore(market,b.text,gender,base)-catScore(market,a.text,gender,base); });
  return ok[0];
}
// 후보({text,val})를 결과목록에 주입 후 change로 커밋(검색/자동/전체목록 무관하게 커밋됨 — 라이브 검증)
function commitInject(market, cand){
  var sel=document.getElementById('openmarket_category_search_list_'+market);
  if(!sel) return false;
  var o=document.createElement('option'); o.value=cand.val; o.text=cand.text;
  sel.appendChild(o); sel.value=cand.val;
  sel.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
}
function bestOfPool(pool, market, gender, base){
  if(!pool.length) return null;
  pool.sort(function(a,b){ return catScore(market,b.text,gender,base)-catScore(market,a.text,gender,base); });
  return pool[0];
}
async function processMarket(market, cls, chosenLog){
  var base=cls.base, gender=cls.gender;
  var cur=listOpts(market);
  if(!cur.sel){ return; } // 이 마켓이 페이지에 없음
  // 후보 풀: 자동매핑 추천 중 허용된 것
  var pool=[];
  cur.opts.forEach(function(o){ if(acceptable(market,o.text,gender)) pool.push({text:o.text, val:o.val}); });
  var autoBest=bestOfPool(pool.slice(), market, gender, base);
  // 스마트스토어 신발/모자는 자동매핑이 비-리프(구버전) 노드를 골라 저장 후 "카테고리를 변경해주세요"로 무효표시되는 경우가 있어 항상 리프 검색으로 보완
  var smartRefine=(market==='SMART' && (famOfBase(base)==='SHOES'||famOfBase(base)==='ACC'));
  var needSearch = !autoBest || conflictFam(base, autoBest.text) || smartRefine;
  if(needSearch){
    // 검색어: gender+base, gender+계열일반, base, 계열일반 (+ 영어권 마켓은 영어 키워드)
    var kws=[cls.keyword, famGeneralKw(base,gender), base, famGeneralKw(base,'')];
    if(ENGLISH_MARKETS[market]) kws=kws.concat(engKws(base));
    kws=kws.filter(function(k,i,a){ return k && a.indexOf(k)===i; });
    for(var ki=0; ki<kws.length; ki++){
      var prev=listOpts(market).opts.map(function(o){return o.text;}).join('|');
      if(!doSearch(market, kws[ki])) continue;
      var opts=await waitSearch(market, prev);
      opts.forEach(function(o){ if(acceptable(market,o.text,gender)) pool.push({text:o.text, val:o.val}); });
      var cb=bestOfPool(pool.slice(), market, gender, base);
      if(cb && !conflictFam(base, cb.text) && catScore(market,cb.text,gender,base)>=6) break; // 충분히 좋은 후보 확보 → 조기 종료
    }
  }
  var winner=bestOfPool(pool, market, gender, base);
  // 검색으로도 허용/계열 정상 후보가 없으면 전체목록(11번가) 폴백
  if(!winner || conflictFam(base, winner.text)){
    var full=bestFromFull(market, gender, base);
    if(full && (!winner || catScore(market,full.text,gender,base)>catScore(market,winner.text,gender,base))) winner=full;
  }
  if(winner){
    commitInject(market, winner);
    chosenLog[MLABEL[market]] = winner.text;
  } else {
    // 허용 후보 전무 → 현재 선택값 유지(경고 로그)
    var keep=listOpts(market); var cs=keep.sel? (keep.sel.options[keep.sel.selectedIndex]||{}).text:'';
    chosenLog[MLABEL[market]] = '(유지)'+(cs||'').trim();
  }
}

function serializeForm(form){
  var fd=new FormData(form);
  var p=new URLSearchParams();
  fd.forEach(function(v,k){ if(typeof v==='string') p.append(k,v); });
  return p;
}

async function processFilter(state){
  var item=state.queue[state.idx];
  var name=item.name||'';
  var cls=classify(name);
  setStat('['+(state.idx+1)+'/'+state.queue.length+'] '+name+' — 자동매핑 실행...');

  // 자동매핑 실행(버튼 텍스트/onclick 무엇이든 함수 직접 호출)
  var aiBtn=Array.prototype.slice.call(document.querySelectorAll('a,button,input')).find(function(x){
    var oc=(x.getAttribute&&x.getAttribute('onclick'))||''; return oc.indexOf('search_recommend_category_all')>=0 || /자동\s*매핑\s*시작/.test(x.textContent||x.value||'');
  });
  _alerts.length=0;
  try{ if(typeof search_recommend_category_all==='function') search_recommend_category_all(aiBtn||{}); }catch(e){}
  await waitAutomap();

  // 마켓별 재선택
  var chosen={};
  for(var i=0;i<MARKETS.length;i++){ await processMarket(MARKETS[i], cls, chosen); }

  // ★ 고시 처리: automap이 채울 때까지 대기 → 빈 곳 상품군 직접 지정 →
  //   get_notify_item 로드 대기 → "상품상세페이지 참조" 마스터 체크박스 체크(대표님 절차)
  //   상품군을 직접 지정한 마켓 + 대표님이 지목한 11번가/롯데ON은 항상 참조 체크.
  setStat('['+(state.idx+1)+'/'+state.queue.length+'] '+name+' — 고시 상품군/참조 처리...');
  await waitNotifyGroups(9000);
  var setM=ensureNotifyGroups(cls);
  var referTargets=[];
  [].concat(setM, ['11ST','LTON']).forEach(function(m){ if(referTargets.indexOf(m)<0 && !NOTIFY_EXEMPT[m] && hasCategory(m)) referTargets.push(m); });
  if(referTargets.length){ await sleep(1500); applyNotifyRefer(referTargets); await sleep(500); }

  var rec={id:item.id, name:name, kw:cls.keyword, chosen:chosen};

  if(state.dry){
    rec.saved=false;
    // 테스트 모드에서도 검증 결과를 로그로 남겨 사전 점검
    try{ rec.formCheck=(typeof form_check==='function')?form_check():''; }catch(e){ rec.formCheck='ERR'; }
    state.log.push(rec); state.ok++;
    setStat('[테스트] '+name+' 매핑 계산 완료(저장 안 함)'+(rec.formCheck?(' · 검증경고: '+rec.formCheck):''));
    return true;
  }

  // 저장: form_check 통과 시 fetch-POST. 실패 시 상품군 재지정+참조체크 후 1회 재시도.
  var form=document.market_category || document.querySelector('form[name=market_category]');
  var fc=''; try{ fc=(typeof form_check==='function')?form_check():''; }catch(e){ fc=''; }
  if(fc){ var setM2=ensureNotifyGroups(cls); await sleep(1500); applyNotifyRefer(marketsNeedingGroup()); await sleep(600); try{ fc=(typeof form_check==='function')?form_check():''; }catch(e){ fc=''; } }
  if(fc){ rec.saved=false; rec.err='검증실패: '+fc; state.log.push(rec); state.fail++; setStat('저장검증 실패: '+fc); return false; }
  try{
    var body=serializeForm(form);
    var action=new URL(form.getAttribute('action')||'admin_category_ok.php', location.href).href;
    var resp=await fetch(action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:body.toString()});
    var ok=resp.status===200;
    rec.saved=ok; if(!ok) rec.err='HTTP '+resp.status;
    state.log.push(rec);
    if(ok){ state.ok++; } else { state.fail++; }
    return ok;
  }catch(e){ rec.saved=false; rec.err=String(e); state.log.push(rec); state.fail++; return false; }
}

async function runSetPage(){
  var state=gs();
  if(!state || !state.running) return;
  // 현재 페이지가 큐의 현재 항목인지 확인
  var m=location.search.match(/ps_ftid=(\d+)/);
  var curId=m?m[1]:null;
  if(state.idx>=state.queue.length){ finish(state); return; }
  var want=state.queue[state.idx];
  if(curId!==String(want.id)){ // 위치 어긋남 → 올바른 필터로 이동
    location.href=DIR()+'admin_category_set.php?tm=F&ps_ftid='+want.id;
    return;
  }
  panelSet(state);
  // 페이지/스크립트 준비 대기
  await sleep(1200);
  // 자동매핑 시작 전 정지 확인(현재 항목을 아직 시작 안 했으면 즉시 멈춤)
  if(!gs() || !gs().running){ stopHere(state, '정지되었습니다.'); return; }
  if(state.max && (state.ok+state.fail)>=state.max){ finish(state, true); return; }
  var okgo=await processFilter(state);
  // ★ 정지 반영: processFilter(수 초) 도중 눌린 정지 플래그가 아래 ss(state)로 덮어써지지 않도록
  //   localStorage의 최신 running 값을 다시 읽어 메모리 state에 반영.
  var latest=gs();
  if(latest && latest.running===false){ state.idx++; stopHere(state, '정지되었습니다 — 성공 '+state.ok+' · 실패 '+state.fail); return; }
  // 다음으로
  state.idx++; ss(state); panelSet(state);
  if(state.idx>=state.queue.length){ finish(state); return; }
  if(state.max && (state.ok+state.fail)>=state.max){ finish(state, true); return; }
  await sleep(400);
  location.href=DIR()+'admin_category_set.php?tm=F&ps_ftid='+state.queue[state.idx].id;
}

// 정지 요청 처리: running 확정 종료 + 진행분 저장 + 목록 복귀
function stopHere(state, msg){
  state.running=false; ss(state);
  setStat(msg||'정지되었습니다.');
  try{ console.log('[TMG 카테고리매핑] 정지 — 결과 로그:', JSON.stringify(state.log,null,1)); }catch(e){}
  if(location.pathname.indexOf('admin_category_set.php')>=0){
    setTimeout(function(){ location.href=DIR()+'admin_group.php'; }, 1200);
  }
}
function finish(state, stoppedByMax){
  state.running=false; ss(state);
  var msg='완료 — 총 '+state.queue.length+' | 성공 '+state.ok+' · 실패 '+state.fail+(stoppedByMax?' (테스트 개수 도달)':'');
  setStat(msg);
  // 로그를 콘솔 + localStorage에 남김
  try{ console.log('[TMG 카테고리매핑] 결과 로그:', JSON.stringify(state.log,null,1)); }catch(e){}
  if(location.pathname.indexOf('admin_category_set.php')>=0){
    // 목록으로 복귀
    setTimeout(function(){ location.href=DIR()+'admin_group.php'; }, 1500);
  }
}

// =========================================================================
// 목록 페이지: 대상 수집 + 시작 패널
// =========================================================================
async function buildQueue(){
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
  for(var pg=1; pg<=8; pg++){ var r=await getPage(pg); if(!r.length) break; r.forEach(function(x){ if(!seen[x.id]){ seen[x.id]=1; all.push(x); } }); if(r.length<100) break; }
  // Zara(독일자라) 전체 — 상태 무관(설정하기=미매핑 + 설정수정=완료 모두 재매핑)
  return all.filter(function(x){ return x.name.indexOf('독일자라')>=0; })
            .map(function(x){ return {id:x.id, name:x.name}; });
}

async function startRun(){
  _stopStart=false;                 // 이번 실행 시작 시 정지 요청 초기화
  setStat('대상 필터 수집 중...');
  var queue;
  try{ queue=await buildQueue(); }catch(e){ setStat('수집 실패: '+e.message); return; }
  if(_stopStart){ setStat('정지했습니다.'); return; }   // 수집 도중 정지 요청됨
  if(!queue.length){ setStat('대상(독일자라) 필터가 없습니다.'); return; }
  var dry=q('#tmgDry') && q('#tmgDry').checked;
  var maxv=parseInt((q('#tmgMax') && q('#tmgMax').value)||'0',10)||0;
  if(!confirm(queue.length+'개 독일자라 필터를 '+(dry?'[테스트: 저장 안 함]':'[실제 저장]')+'으로 처리합니다. (설정하기+설정수정 모두 포함)'+(maxv?(' (앞 '+maxv+'개만)'):'')+'\n진행할까요?')){ setStat('취소됨'); return; }
  if(_stopStart){ setStat('정지했습니다.'); return; }   // 확인창 대기 중 정지 요청됨
  ss({running:true, dry:!!dry, idx:0, ok:0, fail:0, skip:0, max:maxv, queue:queue, log:[]});
  location.href=DIR()+'admin_category_set.php?tm=F&ps_ftid='+queue[0].id;
}

// =========================================================================
// UI
// =========================================================================
function setStat(m){ var s=q('#tmgCmStat'); if(s) s.textContent=m; var s2=q('#tmgCmStat2'); if(s2) s2.textContent=m; }
function panelList(){
  if(q('#tmgCmPanel')) return;
  var p=document.createElement('div'); p.id='tmgCmPanel';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #9b59b6;border-radius:8px;padding:10px 12px;width:300px;font:12px/1.6 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold;margin-bottom:6px">카테고리매핑 자동(Zara)</div>'
   +'<div style="margin-bottom:4px"><label><input type="checkbox" id="tmgDry" checked> 테스트(저장 안 함)</label></div>'
   +'<div style="margin-bottom:4px">앞에서 <input id="tmgMax" type="number" value="3" min="0" style="width:50px"> 개만 (0=전체)</div>'
   +'<button id="tmgCmGo">대상 수집 &amp; 시작</button> <button id="tmgCmStop" style="color:#d9534f">정지</button>'
   +'<div id="tmgCmStat" style="margin-top:8px;color:#333;min-height:32px">대기중</div>'
   +'<div style="margin-top:6px;color:#888;font-size:11px">※ 진행 중 페이지가 계속 이동합니다. 팝업창은 건드리지 마세요. 결과는 콘솔(F12)에 기록됩니다.</div>';
  document.body.appendChild(p);
  q('#tmgCmGo').onclick=startRun;
  q('#tmgCmStop').onclick=function(){ _stopStart=true; var s=gs(); if(s){ s.running=false; ss(s); } setStat('정지했습니다.'); };
}
function panelSet(state){
  if(q('#tmgCmMini')) { return; }
  var p=document.createElement('div'); p.id='tmgCmMini';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #9b59b6;border-radius:8px;padding:8px 10px;width:300px;font:12px/1.5 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML='<div style="font-weight:bold">카테고리매핑 진행중'+(state.dry?' [테스트]':'')+'</div><div id="tmgCmStat2" style="margin-top:6px;color:#333;min-height:32px"></div>'
   +'<button id="tmgCmStop2" style="color:#d9534f;margin-top:6px">정지</button>';
  document.body.appendChild(p);
  q('#tmgCmStop2').onclick=function(){ var s=gs(); if(s){ s.running=false; ss(s); } setStat('정지 요청됨 — 현재 항목 후 멈춥니다.'); };
}

function boot(){
  if(location.pathname.indexOf('admin_group.php')>=0){ panelList(); }
  else if(location.pathname.indexOf('admin_category_set.php')>=0){ var s2=gs(); if(s2&&s2.running){ panelSet(s2); runSetPage(); } }
}
if(document.readyState==='complete') boot();
else window.addEventListener('load', boot);
})();
